// Archive v2 on Node (design §8, §14.3 importV2.test.ts, §14.5): export → import parity into a new space and over
// an existing one (every table and column, ids, ranks, the derived columns, provenance, settings), the users'
// remapping (the candidates of an instance admin and of anyone else, the suggestions, a mapping refused or
// recomputed at commit time, placeholders), provenance through export and re-import, the idempotent retry, the
// limits (per import, per day, skipActivity), one import at a time, the read snapshot of an export taken while
// another request writes, and the accounts mapped into a space reaching its mirror.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { ImportAnalysisDTO, ImportResultDTO, SpaceArchiveDTO, TaskDTO } from '@shared/types';
import { loadConfig } from '../src/config';
import type { Db } from '../src/core/db';
import { openNodeStack } from '../src/runtime/node/stack';
import { createTaskRow } from '../src/services/taskMutations';
import { waitText } from '../src/routes/data';
import { validateArchive } from '../src/space/archive/validate';
import { createTestContext, type TestClient, type TestContext } from './helpers';
import { comparableArchive, downloadArchive, formBytes, identityMapping, importArchive, importForm, sameContent, suggestedMapping } from './support/archive';
import { applySetCookies, OWNER_EMAIL, PASSWORD } from './support/directoryHarness';
import fixture from './fixtures/spaceArchive.json';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A test server with these import limits (IMPORT_DAILY_ROW_WRITES, IMPORT_MAX_ROW_WRITES; Node's default is none). */
function withLimits(vars: Record<string, string>): TestContext {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return createTestContext();
}

const SPACE_TABLES = ['statuses', 'tags', 'projects', 'milestones', 'epics', 'tasks', 'task_tags', 'task_links', 'comments', 'work_logs', 'activity', 'boards'];

/**
 * Every row of a space's content, every column (the import's own timestamps aside: statuses carry none in an
 * archive, and a mirror row's updated_at is when it was written), and its settings and sequences.
 */
function dump(db: Db, o: { users?: boolean; importTimes?: boolean } = {}) {
  const out: Record<string, unknown[]> = {};
  for (const table of SPACE_TABLES) {
    const order = table === 'task_tags' ? 'task_id, tag_id' : table === 'task_links' ? 'blocked_id, blocker_id' : 'id';
    out[table] = db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order}`).map((row) => {
      const copy = { ...row };
      // Neither carries its times in an archive (a link's is when the import wrote it).
      if (table === 'statuses' || table === 'task_links') {
        delete copy.created_at;
        delete copy.updated_at;
      }
      // Two imports of the same file at different times: whether a row has a provenance time, not which.
      if (o.importTimes === false && 'imported_at' in copy) copy.imported_at = copy.imported_at !== null;
      return copy;
    });
  }
  out.settings = db.all('SELECT key, value FROM settings ORDER BY key');
  out.sequences = db.all("SELECT name, seq FROM sqlite_sequence WHERE name <> 'users' ORDER BY name");
  if (o.users) out.users = db.all('SELECT id, kind, display_name, email, is_member, deleted FROM users ORDER BY id');
  return out;
}

/**
 * The source space: the owner's sample data, and rows of Bob (a member) and Carol (a member until she was
 * removed). Dave is a member who wrote nothing.
 */
async function richSource(ctx: TestContext) {
  const owner = await ctx.signedIn({ createSampleData: true });
  const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob' });
  const carol = await ctx.addUser({ email: 'carol@example.com', displayName: 'Carol' });
  const dave = await ctx.addUser({ email: 'dave@example.com', displayName: 'Dave' });
  const tasks = (await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', { limit: 5000 })).body.tasks;
  const project = tasks[0]!.projectId;
  // Task dependencies: a chain of two links.
  expect((await owner.client.post(`/api/tasks/${tasks[3]!.id}/blockers`, { blockerId: tasks[0]!.id })).status).toBe(200);
  expect((await owner.client.post(`/api/tasks/${tasks[4]!.id}/blockers`, { blockerId: tasks[3]!.id })).status).toBe(200);
  for (const [who, client] of [
    ['Bob', bob.client],
    ['Carol', carol.client],
  ] as const) {
    expect((await client.post(`/api/tasks/${tasks[1]!.id}/comments`, { body: `${who} was here` })).status).toBe(201);
    expect((await client.post(`/api/tasks/${tasks[2]!.id}/worklogs`, { date: '2026-10-01', minutes: 45, note: who })).status).toBe(201);
    expect((await client.post('/api/tasks', { projectId: project, title: `${who}'s task`, estimate: 0.1 + (who === 'Bob' ? 0.2 : 0) })).status).toBe(201);
  }
  expect((await owner.client.delete(`/api/spaces/${owner.spaceId}/members/${carol.user.id}`)).status).toBe(200);
  // A request after the removal: the mirror syncs, Carol is a former member.
  expect((await owner.client.get('/api/bootstrap')).status).toBe(200);
  return { owner, bob, carol, dave };
}

/** A space created for an import (§8.4 step 1); its id. */
async function newSpace(client: TestClient, name = 'Moved'): Promise<string> {
  const res = await client.post<{ id: string; status: string }>('/api/spaces', { name, forImport: true });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('importing');
  return res.body.id;
}

const spacePrefix = (spaceId: string) => `/api/s/${spaceId}/data`;

describe('export → import into a new space (an instance admin)', () => {
  it('maps the archive users to accounts by address, attributes the rows, and keeps provenance; parity B → C', async () => {
    const ctx = createTestContext();
    const { owner, bob, carol, dave } = await richSource(ctx);
    const a = (await downloadArchive(owner.client)).archive!;
    // Referenced users and the exporter only: Dave wrote nothing. Carol's address stays (her account lives).
    expect(a.users.map((u) => [u.id, u.displayName, u.email])).toEqual([
      [owner.user.id, 'Owner', OWNER_EMAIL],
      [bob.user.id, 'Bob', 'bob@example.com'],
      [carol.user.id, 'Carol', 'carol@example.com'],
    ]);
    expect(a.users.map((u) => u.id)).not.toContain(dave.user.id);
    expect(validateArchive(a).version).toBe(2);

    const b = await newSpace(owner.client);
    const { analysis, commit } = await importArchive(owner.client, { path: spacePrefix(b), mode: 'new', file: a, gzip: true });
    expect(analysis.status).toBe(200);
    const an = analysis.body as ImportAnalysisDTO;
    expect(an).toMatchObject({ mode: 'new', format: 'lyren-plan-space/2', spaceName: "Owner's space", counts: { tasks: a.tasks.length } });
    expect(an.users.map((u) => [u.archiveId, u.references])).toEqual([
      [owner.user.id, { tasks: a.tasks.length - 2, comments: a.comments.length - 2, worklogs: a.worklogs.length - 2, activity: expect.any(Number) }],
      [bob.user.id, { tasks: 1, comments: 1, worklogs: 1, activity: 3 }],
      [carol.user.id, { tasks: 1, comments: 1, worklogs: 1, activity: 3 }],
    ]);
    // An instance admin may map to any active account.
    expect(an.candidates.map((c) => c.displayName)).toEqual(['Bob', 'Carol', 'Dave', 'Owner']);
    expect(an.suggestions).toEqual([
      { archiveId: owner.user.id, target: { kind: 'user', userId: owner.user.id } },
      { archiveId: bob.user.id, target: { kind: 'user', userId: bob.user.id } },
      { archiveId: carol.user.id, target: { kind: 'user', userId: carol.user.id } },
    ]);
    expect(an.estimate).toMatchObject({ limit: null, dailyLeft: null });
    expect(an.estimate.rowWritesWithoutActivity).toBeLessThan(an.estimate.rowWrites);

    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    const result = commit.body as ImportResultDTO;
    expect(result.safety).toBeNull();
    expect(result.nonMemberAuthors.map((u) => u.displayName)).toEqual(['Bob', 'Carol']);
    expect((await owner.client.get<{ status: string }>(`/api/spaces/${b}`)).body.status).toBe('active');
    const people = ctx.directoryDb.all<{ user_id: number }>(
      'SELECT user_id FROM space_people WHERE space_id = (SELECT id FROM spaces WHERE public_id = :b) ORDER BY user_id',
      { b },
    );
    expect(people.map((p) => p.user_id)).toEqual([owner.user.id, bob.user.id, carol.user.id]);

    const bDb = ctx.stack.spaces.database(b)!;
    // Activity data keeps the key order the app wrote it in, byte for byte (the file's own object, Appendix D 62).
    const sourceDb = ctx.stack.spaces.database(owner.spaceId)!;
    const activityData = (db: Db) => db.all<{ id: number; data: string }>('SELECT id, data FROM activity ORDER BY id');
    expect(activityData(bDb)).toEqual(activityData(sourceDb));
    // Rows by Bob and Carol are attributed to them, labelled as imported by the owner.
    const comments = bDb.all<{ user_id: number; imported_by: number | null; imported_at: string | null }>('SELECT * FROM comments ORDER BY id');
    for (const c of comments) {
      if (c.user_id === owner.user.id) expect([c.imported_by, c.imported_at]).toEqual([null, null]);
      else expect(c.imported_by).toBe(owner.user.id);
    }
    expect(bDb.all('SELECT id, is_member FROM users ORDER BY id')).toEqual([
      { id: owner.user.id, is_member: 1 },
      { id: bob.user.id, is_member: 0 },
      { id: carol.user.id, is_member: 0 },
    ]);
    const boot = (await owner.client.get(`/api/s/${b}/bootstrap`)).body;
    expect(boot.people.map((p: { displayName: string; isMember: boolean }) => [p.displayName, p.isMember])).toEqual([
      ['Bob', false],
      ['Carol', false],
      ['Owner', true],
    ]);

    // B's archive is A's, but for the provenance B added and the space it names.
    const bArchive = (await downloadArchive(owner.client, `${spacePrefix(b)}/export`)).archive!;
    const withoutProvenance = (archive: SpaceArchiveDTO) => ({
      ...comparableArchive(archive),
      space: null,
      comments: archive.comments.map(({ importedBy: _by, importedAt: _at, ...row }) => row),
      worklogs: archive.worklogs.map(({ importedBy: _by, importedAt: _at, ...row }) => row),
      activity: archive.activity.map(({ importedBy: _by, importedAt: _at, ...row }) => row),
    });
    expect(withoutProvenance(bArchive)).toEqual(withoutProvenance(a));
    expect(bArchive.comments.filter((c) => c.importedBy === owner.user.id)).toHaveLength(2);

    // B → C: every table and column the same, its provenance kept.
    const c = await newSpace(owner.client, 'Again');
    expect((await importArchive(owner.client, { path: spacePrefix(c), mode: 'new', file: bArchive })).commit.status).toBe(200);
    const cDb = ctx.stack.spaces.database(c)!;
    expect(dump(cDb, { users: true })).toEqual(dump(bDb, { users: true }));
    expect(comparableArchive((await downloadArchive(owner.client, `${spacePrefix(c)}/export`)).archive!)).toEqual({
      ...comparableArchive(bArchive),
      space: { ...bArchive.space, id: c, name: 'Again' },
    });
  });

  it('a replace keeps the members of the space and gives the same content as an import into a new space', async () => {
    const ctx = createTestContext();
    const { owner, bob } = await richSource(ctx);
    const a = (await downloadArchive(owner.client)).archive!;
    const fresh = await newSpace(owner.client);
    expect((await importArchive(owner.client, { path: spacePrefix(fresh), mode: 'new', file: a })).commit.status).toBe(200);

    // A space of its own, with Bob as a member, replaced by the same archive.
    const other = (await owner.client.post<{ id: string }>('/api/spaces', { name: 'Other', createSampleData: true })).body.id;
    const otherDb = ctx.stack.spaces.database(other)!;
    ctx.directoryDb.run(
      `INSERT INTO memberships (space_id, user_id, role, created_at, updated_at)
       SELECT id, :bob, 'member', created_at, created_at FROM spaces WHERE public_id = :other`,
      { bob: bob.user.id, other },
    );
    expect((await bob.client.get(`/api/s/${other}/tags`)).status).toBe(200);
    const { analysis, commit } = await importArchive(owner.client, { path: spacePrefix(other), mode: 'replace', file: a });
    expect((analysis.body as ImportAnalysisDTO).estimate.rowWrites).toBeGreaterThan(0);
    expect(commit.status).toBe(200);
    const result = commit.body as ImportResultDTO;
    expect(result.safety?.path).toMatch(new RegExp(`^backups/spaces/${other}/pre-import-`));
    // Bob is a member here: only Carol is not.
    expect(result.nonMemberAuthors.map((u) => u.displayName)).toEqual(['Carol']);
    // The same rows; the sequences of the replaced space keep their higher values (ids are never reused).
    const { sequences: replaced, ...content } = dump(otherDb, { importTimes: false });
    const { sequences: created, ...expected } = dump(ctx.stack.spaces.database(fresh)!, { importTimes: false });
    for (const table of Object.keys(expected)) expect(content[table], table).toEqual(expected[table]);
    for (const { name, seq } of created as Array<{ name: string; seq: number }>) {
      expect((replaced as Array<{ name: string; seq: number }>).find((r) => r.name === name)!.seq).toBeGreaterThanOrEqual(seq);
    }
    expect(otherDb.all('SELECT id, is_member FROM users ORDER BY id')).toEqual([
      { id: owner.user.id, is_member: 1 },
      { id: bob.user.id, is_member: 1 },
      { id: ctx.directoryDb.get<{ id: number }>("SELECT id FROM users WHERE email = 'carol@example.com'")!.id, is_member: 0 },
    ]);
    // A replace needs the re-auth window; a new import does not (a new space has nothing to lose).
    ctx.directoryDb.run("UPDATE sessions SET reauth_at = '2000-01-01T00:00:00.000Z'");
    expect((await owner.client.post(`${spacePrefix(other)}/import/analyze?mode=replace`, importForm(a))).body.error.code).toBe('reauth_required');
  });
});

describe('the checked-in archive (§14.5: the same file on both runtimes)', () => {
  it('imports into a new space and exports back unchanged', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: null });
    const archive = fixture as SpaceArchiveDTO;
    expect(archive.users.map((u) => u.id)).toEqual([-1, owner.user.id, bob.user.id]);
    const target = await newSpace(owner.client);
    const { commit } = await importArchive(owner.client, { path: spacePrefix(target), mode: 'new', file: archive, gzip: true, mapping: identityMapping(archive) });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    const again = (await downloadArchive(owner.client, `${spacePrefix(target)}/export`)).archive!;
    expect(sameContent(again)).toEqual(sameContent(archive));
  });
});

describe('remapping (§8.5, §8.6)', () => {
  /** An owner who is no instance admin, in a space shared with Bob, importing an archive of Ann, Bob and Zed. */
  async function nonAdmin() {
    const ctx = createTestContext();
    const admin = await ctx.signedIn({ createSampleData: true });
    const importer = await ctx.addUser({ email: 'imp@example.com', displayName: 'Importer', spaceId: null });
    const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId: null });
    await ctx.addUser({ email: 'stranger@example.com', displayName: 'Stranger', spaceId: null });
    const shared = (await importer.client.post<{ id: string }>('/api/spaces', { name: 'Shared' })).body.id;
    ctx.directoryDb.run(
      `INSERT INTO memberships (space_id, user_id, role, created_at, updated_at)
       SELECT id, :bob, 'viewer', created_at, created_at FROM spaces WHERE public_id = :shared`,
      { bob: bob.user.id, shared },
    );
    const target = await newSpace(importer.client);
    const archive = (await downloadArchive(admin.client)).archive!;
    // Three users: Ann (no account here), Bob (bob@example.com) and Zed with the stranger's address.
    archive.users = [
      { id: 101, kind: 'account', displayName: 'Ann', email: 'ann@example.com' },
      { id: 102, kind: 'account', displayName: 'Bob in the archive', email: 'BOB@example.com' },
      { id: 103, kind: 'account', displayName: 'Zed', email: 'stranger@example.com' },
      { id: -7, kind: 'placeholder', displayName: 'Old friend', email: null },
    ];
    archive.space.exportedBy = 101;
    archive.tasks.forEach((t, i) => (t.createdBy = [101, 102, 103, -7][i % 4]!));
    archive.comments.forEach((c) => (c.authorId = 102));
    archive.activity.forEach((a) => (a.actorId = null));
    archive.worklogs.forEach((w) => (w.authorId = null));
    return { ctx, admin, importer, bob, shared, target, archive };
  }

  it('candidates are the importer and the members of their spaces; nobody else is matched or named', async () => {
    const { ctx, importer, bob, target, archive } = await nonAdmin();
    const analysis = await importer.client.post<ImportAnalysisDTO>(`${spacePrefix(target)}/import/analyze?mode=new`, importForm(archive));
    expect(analysis.status).toBe(200);
    expect(analysis.body.candidates).toEqual([
      { userId: bob.user.id, displayName: 'Bob', email: 'bob@example.com', isYou: false },
      { userId: importer.user.id, displayName: 'Importer', email: 'imp@example.com', isYou: true },
    ]);
    expect(JSON.stringify(analysis.body)).not.toContain('Stranger');
    expect(analysis.body.suggestions).toEqual([
      // The exporter: the importer.
      { archiveId: 101, target: { kind: 'user', userId: importer.user.id } },
      // The address (normalized) of a candidate.
      { archiveId: 102, target: { kind: 'user', userId: bob.user.id } },
      // An address that has an account, which the importer cannot see: no match.
      { archiveId: 103, target: { kind: 'placeholder' } },
      { archiveId: -7, target: { kind: 'placeholder' } },
    ]);

    // The stranger's id is refused like any other non-candidate, with the archive user's mapping path.
    const strangerId = ctx.directoryDb.get<{ id: number }>("SELECT id FROM users WHERE email = 'stranger@example.com'")!.id;
    const refused = await importer.client.post(
      `${spacePrefix(target)}/import/commit?mode=new`,
      importForm(archive, {
        mapping: {
          mapping: [
            ...analysis.body.suggestions.filter((s) => s.archiveId !== 103),
            { archiveId: 103, target: { kind: 'user', userId: strangerId } },
          ],
        },
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ path: 'mapping.3.target.userId', message: `Archive user 103: account ${strangerId} is not one you can choose` }]);
  });

  it('every referenced user exactly once; others ignored; placeholders keep the names; the commit asks for the candidates again', async () => {
    const { ctx, admin, importer, bob, shared, target, archive } = await nonAdmin();
    const commit = (mapping: unknown) => importer.client.post(`${spacePrefix(target)}/import/commit?mode=new`, importForm(archive, { mapping }));
    const toImporter = { kind: 'user', userId: importer.user.id };
    const missing = await commit({ mapping: [{ archiveId: 101, target: toImporter }, { archiveId: 101, target: toImporter }, { archiveId: 999, target: toImporter }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/^Invalid mapping \(4 problems\): Archive user 101 is mapped twice/);
    expect(missing.body.error.details.map((d: { path: string }) => d.path)).toEqual(['mapping.1.archiveId', 'mapping', 'mapping', 'mapping']);

    // Bob leaves the shared space between the analysis and the commit: he is no candidate any more.
    const mapping = {
      mapping: [
        { archiveId: 101, target: toImporter },
        { archiveId: 102, target: { kind: 'user', userId: bob.user.id } },
        { archiveId: 103, target: { kind: 'placeholder' } },
        { archiveId: -7, target: { kind: 'placeholder' } },
      ],
    };
    expect((await bob.client.post(`/api/spaces/${shared}/leave`)).status).toBe(200);
    const gone = await commit(mapping);
    expect(gone.status).toBe(400);
    expect(gone.body.error.details).toEqual([{ path: 'mapping.1.target.userId', message: `Archive user 102: account ${bob.user.id} is not one you can choose` }]);

    mapping.mapping[1] = { archiveId: 102, target: { kind: 'placeholder' } };
    const done = await commit(mapping);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const db = ctx.stack.spaces.database(target)!;
    expect(db.all('SELECT id, kind, display_name, email, is_member FROM users ORDER BY id')).toEqual([
      { id: -3, kind: 'placeholder', display_name: 'Old friend', email: null, is_member: 0 },
      { id: -2, kind: 'placeholder', display_name: 'Zed', email: null, is_member: 0 },
      { id: -1, kind: 'placeholder', display_name: 'Bob in the archive', email: null, is_member: 0 },
      { id: importer.user.id, kind: 'account', display_name: 'Importer', email: 'imp@example.com', is_member: 1 },
    ]);
    expect(db.all('SELECT DISTINCT user_id FROM comments')).toEqual([{ user_id: -1 }]);
    // Null references stay null in v2 (v1 gives comments and work logs the importer).
    expect(db.all('SELECT DISTINCT user_id FROM work_logs')).toEqual([{ user_id: null }]);
    expect(db.all('SELECT DISTINCT imported_by FROM comments')).toEqual([{ imported_by: importer.user.id }]);
    expect(db.all('SELECT DISTINCT imported_by FROM work_logs')).toEqual([{ imported_by: null }]);
    expect(admin).toBeDefined();
  });

  it('a v1 export: no users to map, every reference to the importer, whatever the mapping says', async () => {
    const { ctx, importer, target } = await nonAdmin();
    const v1 = {
      format: 'lyren-plan-export',
      formatVersion: 1,
      exportedAt: '2026-10-01T00:00:00.000Z',
      appVersion: '1.0.0',
      settings: { weekStartsOn: 1, estimateUnit: 'hours', defaultBoardId: null, homePage: 'dashboard' },
      statuses: [{ id: 1, name: 'Open', category: 'unstarted', color: '#111111', position: 0 }],
      tags: [],
      projects: [{ id: 1, key: 'AB', name: 'A', description: '', color: '#222222', status: 'active', position: 0, taskCounter: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
      milestones: [],
      epics: [],
      tasks: [
        {
          ...{ id: 1, projectId: 1, number: 1, epicId: null, statusId: 1, priority: 0, title: 'T', description: '' },
          ...{ startDate: null, dueDate: null, estimate: null, rank: 'a0', completedAt: null, archivedAt: null, createdBy: 77 },
          ...{ createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', tagIds: [] },
        },
      ],
      comments: [{ id: 1, taskId: 1, body: 'x', authorId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', editedAt: null }],
      worklogs: [],
      activity: [],
      boards: [],
    };
    const { analysis, commit } = await importArchive(importer.client, { path: spacePrefix(target), mode: 'new', file: v1, mapping: { mapping: [{ archiveId: 77, target: { kind: 'placeholder' } }] } });
    expect(analysis.body).toMatchObject({ format: 'lyren-plan-export/1', spaceName: null, users: [], suggestions: [] });
    expect(commit.status).toBe(200);
    expect(commit.body.nonMemberAuthors).toEqual([]);
    const db = ctx.stack.spaces.database(target)!;
    expect(db.get('SELECT created_by FROM tasks')).toEqual({ created_by: importer.user.id });
    expect(db.get('SELECT user_id, imported_by FROM comments')).toEqual({ user_id: importer.user.id, imported_by: null });
    expect(db.all("SELECT id FROM users WHERE kind = 'placeholder'")).toEqual([]);
  });
});

describe('provenance through export and re-import (§8.6, §13.16)', () => {
  it("an archive's provenance is kept only when it names the importer; anything else the importer attributes names them, now", async () => {
    const ctx = createTestContext();
    const { owner, bob, carol } = await richSource(ctx);
    const b = await newSpace(owner.client);
    expect((await importArchive(owner.client, { path: spacePrefix(b), mode: 'new', file: (await downloadArchive(owner.client)).archive! })).commit.status).toBe(200);
    const bArchive = (await downloadArchive(owner.client, `${spacePrefix(b)}/export`)).archive!;
    const bobsComment = bArchive.comments.find((c) => c.authorId === bob.user.id)!;
    expect(bobsComment).toMatchObject({ importedBy: owner.user.id, importedAt: expect.any(String) });
    expect(bArchive.comments.find((c) => c.authorId === owner.user.id)).not.toHaveProperty('importedBy');
    // (The owner moving B on keeps its provenance, its own, with its time: the B → C parity above.)

    // Bob imports B into a space of his own (the owner's rows go to a placeholder, Carol's to Bob).
    const own = (await bob.client.post<{ id: string }>('/api/spaces', { name: 'Bob', forImport: true })).body.id;
    const mapping = {
      mapping: [
        { archiveId: owner.user.id, target: { kind: 'placeholder' } },
        { archiveId: bob.user.id, target: { kind: 'user', userId: bob.user.id } },
        { archiveId: carol.user.id, target: { kind: 'user', userId: bob.user.id } },
      ],
    };
    const startedAt = new Date().toISOString();
    expect((await importArchive(bob.client, { path: spacePrefix(own), mode: 'new', file: bArchive, mapping })).commit.status).toBe(200);
    const db = ctx.stack.spaces.database(own)!;
    // Bob's own comment is his to vouch for: the owner's attribution (another person's act) is not repeated.
    expect(db.get('SELECT user_id, imported_by, imported_at FROM comments WHERE id = :id', { id: bobsComment.id })).toEqual({
      user_id: bob.user.id,
      imported_by: null,
      imported_at: null,
    });
    // The owner's rows (the placeholder now) are labelled as Bob's import, now.
    const ownersComment = bArchive.comments.find((c) => c.authorId === owner.user.id)!;
    const labelled = db.get<{ user_id: number; imported_by: number; imported_at: string }>('SELECT user_id, imported_by, imported_at FROM comments WHERE id = :id', {
      id: ownersComment.id,
    })!;
    expect(labelled).toMatchObject({ user_id: -1, imported_by: bob.user.id });
    expect(labelled.imported_at >= startedAt).toBe(true);
    const timeline = (await bob.client.get(`/api/s/${own}/tasks/${bobsComment.taskId}/timeline`)).body;
    expect(timeline.comments.find((c: { id: number }) => c.id === bobsComment.id).importedBy).toBeNull();
  });

  it('a forged provenance (the author as importer, a date long ago) names the importer and the time of the import', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn({ createSampleData: true });
    const mallory = await ctx.addUser({ email: 'mallory@example.com', displayName: 'Mallory' });
    const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob' });
    const archive = (await downloadArchive(owner.client)).archive!;
    const forged: SpaceArchiveDTO = {
      ...archive,
      users: [...archive.users, { id: 7, kind: 'account', displayName: 'Bob', email: 'bob@example.com' }],
      comments: [
        ...archive.comments,
        {
          ...{ id: 999_999, taskId: archive.tasks[0]!.id, body: 'I quit, signed Bob', authorId: 7, importedBy: 7 },
          ...{ importedAt: '2001-01-01T00:00:00.000Z', createdAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z', editedAt: null },
        },
      ],
    };
    // Mallory shares the owner's space with Bob, so Bob is one of her candidates, suggested by his address.
    const target = await newSpace(mallory.client);
    const startedAt = new Date().toISOString();
    const { analysis, commit } = await importArchive(mallory.client, { path: spacePrefix(target), mode: 'new', file: forged });
    expect((analysis.body as ImportAnalysisDTO).suggestions).toContainEqual({ archiveId: 7, target: { kind: 'user', userId: bob.user.id } });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    const row = ctx.stack.spaces.database(target)!.get<{ user_id: number; imported_by: number; imported_at: string }>(
      'SELECT user_id, imported_by, imported_at FROM comments WHERE id = 999999',
    )!;
    expect(row).toMatchObject({ user_id: bob.user.id, imported_by: mallory.user.id });
    expect(row.imported_at >= startedAt).toBe(true);
  });
});

describe('the protocol (§8.4)', () => {
  it('a commit whose directory call failed: the retry writes nothing again and answers the stored result', async () => {
    const ctx = withLimits({ IMPORT_DAILY_ROW_WRITES: '100000' });
    const owner = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(owner.client)).archive!;
    const target = await newSpace(owner.client);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const committed = vi.spyOn(ctx.stack.service, 'importCommitted').mockRejectedValueOnce(new Error('directory down (test)'));
    const first = await importArchive(owner.client, { path: spacePrefix(target), mode: 'new', file: archive });
    expect(first.commit.status).toBe(503);
    expect(first.commit.body.error.message).toBe('The import was saved, but it could not be completed. Send it again to finish.');
    expect((await owner.client.get<{ status: string }>(`/api/spaces/${target}`)).body.status).toBe('importing');
    const db = ctx.stack.spaces.database(target)!;
    const before = dump(db, { users: true });
    const reserved = ctx.directoryDb.get<{ count: number }>("SELECT count FROM auth_throttle WHERE substr(key, 1, 7) = 'import:'")!.count;

    const again = await owner.client.post(`${spacePrefix(target)}/import/commit?mode=new`, importForm('not even a file'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, counts: { tasks: archive.tasks.length }, safety: null });
    expect(committed).toHaveBeenCalledTimes(2);
    expect(dump(db, { users: true })).toEqual(before);
    // Nothing more reserved.
    expect(ctx.directoryDb.get<{ count: number }>("SELECT count FROM auth_throttle WHERE substr(key, 1, 7) = 'import:'")!.count).toBe(reserved);
    // Now the space is active: a new import is refused by the gate.
    const late = await owner.client.post(`${spacePrefix(target)}/import/commit?mode=new`, importForm(archive));
    expect(late.status).toBe(409);
    expect(late.body.error).toEqual({ code: 'conflict', message: 'This space has already been imported' });
  });

  it('a commit that fails before or while it writes gives its reservation back', async () => {
    const ctx = withLimits({ IMPORT_DAILY_ROW_WRITES: '100000' });
    const owner = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(owner.client)).archive!;
    const used = () => ctx.directoryDb.get<{ count: number }>("SELECT count FROM auth_throttle WHERE substr(key, 1, 7) = 'import:'")?.count ?? 0;
    // A replace whose safety point cannot be written (a file where its folder belongs): 500, nothing reserved.
    fs.mkdirSync(path.join(ctx.config.dataDir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(ctx.config.dataDir, 'backups', 'spaces'), 'in the way');
    const refunded = vi.spyOn(ctx.stack.service, 'refundImport');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const crashed = await importArchive(owner.client, { mode: 'replace', file: archive });
    expect(crashed.commit.status).toBe(500);
    expect(refunded).toHaveBeenCalledTimes(1);
    expect(used()).toBe(0);
    fs.rmSync(path.join(ctx.config.dataDir, 'backups', 'spaces'));
    // A write that fails in its transaction (a foreign key the integrity check does not see: the test breaks the
    // schema's, which nothing else could): 400, rolled back, refunded.
    const db = ctx.db;
    const tasks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    const tx = db.tx.bind(db);
    vi.spyOn(db, 'tx').mockImplementation((fn) =>
      tx(() => {
        const result = fn();
        if (db.inTransaction && db.get("SELECT 1 AS imported FROM _meta WHERE key = 'imported_at'")) throw new Error('disk I/O error (test)');
        return result;
      }),
    );
    const failed = await importArchive(owner.client, { mode: 'replace', file: archive });
    expect(failed.commit.status).toBe(500);
    expect(refunded).toHaveBeenCalledTimes(2);
    expect(used()).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(tasks);
  });

  it('a full day refuses until 00:00 UTC; over the per-import limit, 409', async () => {
    const ctx = withLimits({ IMPORT_DAILY_ROW_WRITES: '700', IMPORT_MAX_ROW_WRITES: '1500' });
    const owner = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(owner.client)).archive!;
    const used = () => ctx.directoryDb.get<{ count: number }>("SELECT count FROM auth_throttle WHERE substr(key, 1, 7) = 'import:'")?.count ?? 0;

    const target = await newSpace(owner.client);
    const analysis = (await owner.client.post<ImportAnalysisDTO>(`${spacePrefix(target)}/import/analyze?mode=new`, importForm(archive))).body;
    const { rowWrites, rowWritesWithoutActivity } = analysis.estimate;
    expect(analysis.estimate).toMatchObject({ limit: 1_500, dailyLeft: 700 });
    expect(rowWrites).toBeGreaterThan(350);
    expect(rowWrites).toBeGreaterThan(rowWritesWithoutActivity);
    const ok = await owner.client.post(`${spacePrefix(target)}/import/commit?mode=new`, importForm(archive, { mapping: suggestedMapping(analysis) }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(used()).toBe(rowWrites);

    // The next import of the day does not fit any more.
    const second = await newSpace(owner.client, 'Second');
    const left = (await owner.client.post<ImportAnalysisDTO>(`${spacePrefix(second)}/import/analyze?mode=new`, importForm(archive))).body;
    expect(left.estimate.dailyLeft).toBe(700 - rowWrites);
    const full = await owner.client.post(`${spacePrefix(second)}/import/commit?mode=new`, importForm(archive, { mapping: suggestedMapping(left) }));
    expect(full.status).toBe(429);
    expect(full.body.error).toEqual({ code: 'rate_limited', message: "This instance has reached today's import limit. It resets at 00:00 UTC." });
    expect(Number(full.headers.get('retry-after'))).toBeGreaterThan(0);

    // Over the per-import limit: 409 with both numbers; without the activity it fits.
    vi.unstubAllEnvs();
    const small = withLimits({ IMPORT_MAX_ROW_WRITES: String(rowWritesWithoutActivity) });
    const o2 = await small.signedIn();
    const t2 = await newSpace(o2.client);
    const tooBig = await importArchive(o2.client, { path: spacePrefix(t2), mode: 'new', file: archive });
    expect(tooBig.analysis.body.estimate).toMatchObject({ rowWrites, rowWritesWithoutActivity, limit: rowWritesWithoutActivity });
    expect(tooBig.commit.status).toBe(409);
    expect(tooBig.commit.body.error).toEqual({
      code: 'quota_exceeded',
      message: `This import needs about ${rowWrites.toLocaleString('en-US')} row writes; this instance allows ${rowWritesWithoutActivity.toLocaleString('en-US')} per import.`,
    });
    const without = await importArchive(o2.client, { path: spacePrefix(t2), mode: 'new', file: archive, skipActivity: true });
    expect(without.commit.status, JSON.stringify(without.commit.body)).toBe(200);
    expect(without.commit.body.counts.activity).toBe(0);
    expect(small.stack.spaces.database(t2)!.get('SELECT COUNT(*) AS n FROM activity')).toEqual({ n: 0 });
  });

  it('im:<userId>: ten analyze and commit calls an hour, refused ones included', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn();
    const archive = (await downloadArchive(owner.client)).archive!;
    for (let i = 0; i < 4; i++) {
      expect((await owner.client.post(`/api/data/import/analyze?mode=replace`, importForm(archive))).status).toBe(200);
    }
    // A commit counts as it starts, whatever it answers (Appendix D 62): one the file, the mapping or a limit
    // refuses has done the costly part, reading and checking the file, all the same.
    const invalid = { ...archive, tasks: [{ id: 1 }] };
    for (let i = 0; i < 6; i++) {
      const res = await owner.client.post(`/api/data/import/commit?mode=replace`, importForm(i % 2 === 0 ? invalid : 'not json'));
      expect(res.status).toBe(400);
    }
    for (const step of ['analyze', 'commit']) {
      const refused = await owner.client.post(`/api/data/import/${step}?mode=replace`, importForm(archive));
      expect(refused.status).toBe(429);
      expect(refused.body.error.message).toBe('You have started too many imports in the last hour. Try again in about an hour.');
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(3500);
    }
    expect(waitText(1)).toBe('a minute');
    expect(waitText(61)).toBe('about 2 minutes');
    expect(waitText(2400)).toBe('about 40 minutes');
  });

  it('one import at a time on a Node server: a second one anywhere answers 503', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(owner.client)).archive!;
    const target = await newSpace(owner.client);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const candidates = ctx.stack.service.importCandidates.bind(ctx.stack.service);
    vi.spyOn(ctx.stack.service, 'importCandidates').mockImplementationOnce(async (input) => {
      await held;
      return candidates(input);
    });
    const first = owner.client.post(`${spacePrefix(target)}/import/analyze?mode=new`, importForm(archive));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await owner.client.post('/api/data/import/analyze?mode=replace', importForm(archive));
    expect(second.status).toBe(503);
    expect(second.body.error).toEqual({ code: 'unavailable', message: 'Another import is running. Try again in a minute.' });
    release();
    expect((await first).status).toBe(200);
    expect((await owner.client.post('/api/data/import/analyze?mode=replace', importForm(archive))).status).toBe(200);
  });

  it('accounts mapped into a space reach its mirror: a deleted one loses its address there', async () => {
    const ctx = createTestContext();
    const { owner, carol } = await richSource(ctx);
    const b = await newSpace(owner.client);
    expect((await importArchive(owner.client, { path: spacePrefix(b), mode: 'new', file: (await downloadArchive(owner.client)).archive! })).commit.status).toBe(200);
    expect((await carol.client.request('DELETE', '/api/account', { confirm: 'carol@example.com' })).status).toBe(200);
    expect((await owner.client.get(`/api/s/${b}/bootstrap`)).status).toBe(200);
    const row = ctx.stack.spaces.database(b)!.get('SELECT display_name, email, deleted FROM users WHERE id = :id', { id: carol.user.id });
    expect(row).toEqual({ display_name: 'Carol', email: null, deleted: 1 });
    const again = (await downloadArchive(owner.client, `${spacePrefix(b)}/export`)).archive!;
    expect(again.users.find((u) => u.id === carol.user.id)).toEqual({ id: carol.user.id, kind: 'account', displayName: 'Carol', email: null });
  });
});

describe('the export reads one consistent view (§8.3, Node: a read transaction of its own)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes that commit while an export is being written do not reach it', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyren-export-'));
    dirs.push(dataDir);
    const config = loadConfig({ dbPath: path.join(dataDir, 'lyren.db'), webDir: null, setupToken: 'export-test', logRequests: false });
    const stack = openNodeStack({ ...config, directory: { ...config.directory, passwordScryptP: 1 } }, { mode: 'maintenance' });
    try {
      const jar = new Map<string, string>();
      const call = async (method: string, p: string, body?: unknown) => {
        const res = await stack.app.request(p, {
          method,
          headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        applySetCookies(jar, res.headers.getSetCookie());
        return res;
      };
      expect((await call('POST', '/api/auth/setup', { email: OWNER_EMAIL, displayName: 'Owner', password: PASSWORD, setupCode: 'export-test' })).status).toBe(201);
      const spaceId = ((await (await call('GET', '/api/auth/status')).json()) as { spaces: Array<{ id: string }> }).spaces[0]!.id;
      const db = stack.spaces.database(spaceId)!;
      const project = (await (await call('POST', `/api/s/${spaceId}/projects`, { name: 'Big', key: 'BIG' })).json()) as { id: number };
      const statusId = db.get<{ id: number }>('SELECT id FROM statuses ORDER BY position LIMIT 1')!.id;
      db.tx(() => {
        for (let i = 0; i < 600; i++) {
          createTaskRow(db, { userId: 1 }, { projectId: project.id, title: `Task ${i} ${'x'.repeat(200)}`, statusId });
        }
      });

      // The compressor waits for the test at its first chunk: the export has read part of the space by then.
      const Real = CompressionStream;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => (reached = resolve));
      vi.stubGlobal(
        'CompressionStream',
        class {
          readonly readable: ReadableStream<Uint8Array>;
          readonly writable: WritableStream<Uint8Array>;
          constructor(format: ConstructorParameters<typeof CompressionStream>[0]) {
            const real = new Real(format);
            this.readable = real.readable;
            const writer = real.writable.getWriter();
            let first = true;
            this.writable = new WritableStream({
              async write(chunk) {
                if (first) {
                  first = false;
                  reached();
                  await held;
                }
                await writer.write(chunk);
              },
              close: () => writer.close(),
              abort: (reason) => writer.abort(reason),
            });
          }
        },
      );
      const exporting = call('GET', `/api/s/${spaceId}/data/export`);
      await waiting;
      // Meanwhile: a tag, a renamed task, a deleted one, and a new task.
      expect((await call('POST', `/api/s/${spaceId}/tags`, { name: 'meanwhile' })).status).toBe(201);
      const last = db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
      expect((await call('PATCH', `/api/s/${spaceId}/tasks/${last}`, { title: 'Renamed meanwhile' })).status).toBe(200);
      expect((await call('DELETE', `/api/s/${spaceId}/tasks/${last - 1}`)).status).toBe(200);
      expect((await call('POST', `/api/s/${spaceId}/tasks`, { projectId: project.id, title: 'New meanwhile' })).status).toBe(201);
      release();
      const res = await exporting;
      vi.unstubAllGlobals();
      expect(res.status).toBe(200);
      const { unpackArchive } = await import('./support/archive');
      const archive = unpackArchive(new Uint8Array(await res.arrayBuffer()));
      expect(archive.tags.map((t) => t.name)).not.toContain('meanwhile');
      expect(archive.tasks).toHaveLength(600);
      expect(archive.tasks.find((t) => t.id === last)!.title).toMatch(/^Task 599 /);
      expect(archive.tasks.some((t) => t.id === last - 1)).toBe(true);
      expect(archive.activity.some((a) => a.action === 'task.deleted')).toBe(false);
      expect(validateArchive(archive).tasks).toHaveLength(600);
      // A later export has everything.
      const after = unpackArchive(new Uint8Array(await (await call('GET', `/api/s/${spaceId}/data/export`)).arrayBuffer()));
      expect(after.tags.map((t) => t.name)).toContain('meanwhile');
      expect(after.tasks).toHaveLength(600);
    } finally {
      vi.unstubAllGlobals();
      stack.close();
    }
  });
});

describe('the form', () => {
  it('a gzip archive and the same JSON uncompressed both import (told apart by the magic bytes)', async () => {
    const ctx = createTestContext();
    const owner = await ctx.signedIn({ createSampleData: true });
    const { bytes, archive } = await downloadArchive(owner.client);
    for (const file of [bytes, JSON.stringify(archive)]) {
      const res = await importArchive(owner.client, { mode: 'replace', file });
      expect(res.commit.status).toBe(200);
    }
    const sent = await formBytes(importForm(archive));
    expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });
});
