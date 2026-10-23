// The gate (design §6.4): every route of the space app has exactly the expected rule, and every
// spelling of a request (plain, a percent-encoded letter, HEAD for GET routes) gets the decision of the
// handler that runs. Also: re-auth, fresh identities, the importing status, the import mode, the size
// limit, a route without a rule failing closed, a request judged again once its body has arrived
// (Appendix D 27) and its body limits, and the data routes' use of the gate's facilities (the read snapshot,
// the import gate, the safety point).

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_RANK, type SpaceRole } from '@shared/roles';
import type { SpaceIdentity } from '../../src/core/ports';
import type { AppEnv } from '../../src/env';
import { handleError } from '../../src/http/errors';
import { createSpaceApp } from '../../src/space/app';
import { createGate, GATE_RULES, type GateRule } from '../../src/space/gate';
import { assertFoldsConsistent } from '../support/folds';
import { heldBody, settle } from '../support/heldBody';
import { downloadArchive, importForm, replaceImport, v1Of } from '../support/archive';
import { createSpaceHarness, mirrorRows, type SpaceTestClient } from '../support/spaceHarness';

const view = (need: SpaceRole = 'viewer'): GateRule => ({ need, write: false, conditional: true });
const edit = (need: SpaceRole = 'member'): GateRule => ({ need, write: true });
const remove = (need: SpaceRole = 'member'): GateRule => ({ need, write: true, allowWhenFull: true });

/** The expected table, written out so that a new route or a changed rule cannot slip in unnoticed. */
const EXPECTED: Record<string, GateRule> = {
  'GET /api/bootstrap': view(),
  'GET /api/projects': view(),
  'POST /api/projects': edit(),
  'POST /api/projects/reorder': edit(),
  'GET /api/projects/:id': view(),
  'PATCH /api/projects/:id': edit(),
  'DELETE /api/projects/:id': remove('admin'),
  'GET /api/projects/:id/milestones': view(),
  'GET /api/projects/:id/epics': view(),
  'POST /api/milestones': edit(),
  'POST /api/milestones/reorder': edit(),
  'GET /api/milestones/:id': view(),
  'PATCH /api/milestones/:id': edit(),
  'DELETE /api/milestones/:id': remove(),
  'POST /api/epics': edit(),
  'POST /api/epics/reorder': edit(),
  'GET /api/epics/:id': view(),
  'PATCH /api/epics/:id': edit(),
  'DELETE /api/epics/:id': remove(),
  'POST /api/tasks/query': view(),
  'POST /api/tasks/bulk': edit(),
  'POST /api/tasks/bulk-delete': remove(),
  'POST /api/tasks': edit(),
  'GET /api/tasks/ref/:ref': view(),
  'GET /api/tasks/:id': view(),
  'PATCH /api/tasks/:id': edit(),
  'DELETE /api/tasks/:id': remove(),
  'POST /api/tasks/:id/duplicate': edit(),
  'POST /api/tasks/:id/blockers': edit(),
  'DELETE /api/tasks/:id/blockers/:blockerId': remove(),
  'POST /api/tasks/rebaseline/preview': view(),
  'POST /api/tasks/rebaseline': edit(),
  'GET /api/tasks/:id/timeline': view(),
  'POST /api/tasks/:id/comments': edit(),
  'PATCH /api/comments/:id': edit(),
  'DELETE /api/comments/:id': remove(),
  'POST /api/tasks/:id/worklogs': edit(),
  'PATCH /api/worklogs/:id': edit(),
  'DELETE /api/worklogs/:id': remove(),
  'GET /api/worklogs': view(),
  'GET /api/activity': view(),
  'GET /api/boards': view(),
  'POST /api/boards': edit(),
  'POST /api/boards/reorder': edit(),
  'GET /api/boards/:id': view(),
  'PATCH /api/boards/:id': edit(),
  'DELETE /api/boards/:id': remove(),
  'POST /api/boards/:id/duplicate': edit(),
  'GET /api/tags': view(),
  'POST /api/tags': edit(),
  'PATCH /api/tags/:id': edit(),
  'DELETE /api/tags/:id': remove('admin'),
  'POST /api/tags/:id/merge': edit('admin'),
  'GET /api/statuses': view(),
  'POST /api/statuses': edit('admin'),
  'POST /api/statuses/reorder': edit('admin'),
  'PATCH /api/statuses/:id': edit('admin'),
  'DELETE /api/statuses/:id': remove('admin'),
  'GET /api/settings': view(),
  'PATCH /api/settings': edit('admin'),
  'GET /api/data/export': { need: 'owner', write: false, fresh: true, reauth: 'always' },
  'POST /api/data/import/analyze': { need: 'owner', write: false, fresh: true, reauth: 'replace', importing: 'allowed', allowWhenFull: true },
  'POST /api/data/import/commit': { need: 'owner', write: true, fresh: true, reauth: 'replace', importing: 'allowed' },
  'POST /api/people/:personId/reassign': edit('admin'),
  'POST /api/people/me/disown': edit('viewer'),
  'GET /api/dashboard': view(),
  'GET /api/search': view(),
};

/** The gate's role refusals (§6.4 step 5). */
const ROLE_MESSAGES = [
  'You have view-only access to this space.',
  'Only admins and owners can do this.',
  'Only owners can do this.',
];

const ROLES: SpaceRole[] = ['viewer', 'member', 'admin', 'owner'];

/**
 * A concrete path for a route pattern: ids that do not exist, so allowed requests change nothing; the import
 * routes with ?mode=replace (the gate refuses a missing mode before the role).
 */
const concrete = (pattern: string) =>
  pattern.replace(/:id\b/g, '987654').replace(':personId', '987654').replace(':ref', 'ZZ-1') +
  (pattern.startsWith('/api/data/import/') ? '?mode=replace' : '');

/** The same path with the first letter of its first segment after /api/ percent-encoded. */
function encodedVariant(path: string): string {
  const [, rest] = /^\/api\/(.*)$/.exec(path)!;
  const letter = rest![0]!;
  return `/api/%${letter.charCodeAt(0).toString(16).toUpperCase()}${rest!.slice(1)}`;
}

function harnessWithRoles() {
  const h = createSpaceHarness();
  const clients: Record<SpaceRole, SpaceTestClient> = {
    owner: h.owner.client,
    admin: h.addUser({ role: 'admin' }).client,
    member: h.addUser({ role: 'member' }).client,
    viewer: h.addUser({ role: 'viewer' }).client,
  };
  return { h, clients };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the gate table', () => {
  it('has one rule for every route of the space app and no other', () => {
    const { deps } = createSpaceHarness();
    const routes = createSpaceApp(deps)
      .routes.filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect([...routes].sort()).toEqual(Object.keys(GATE_RULES).sort());
    expect(GATE_RULES).toEqual(EXPECTED);
  });

  it('allows and refuses every route by role, for every spelling of the request', async () => {
    const { h, clients } = harnessWithRoles();
    for (const [key, rule] of Object.entries(GATE_RULES)) {
      const [method, pattern] = key.split(' ') as [string, string];
      const path = concrete(pattern);
      for (const role of ROLES) {
        const client = clients[role];
        const refused = ROLE_RANK[role] < ROLE_RANK[rule.need];
        const body = method === 'GET' ? undefined : {};
        const plain = await client.request(method, path, body);
        const label = `${key} as ${role}`;
        expect(plain.status === 403 && ROLE_MESSAGES.includes(plain.body?.error?.message), label).toBe(refused);
        if (!refused) expect(plain.status, label).not.toBe(500);

        const encoded = await client.request(method, encodedVariant(path), body);
        expect(encoded.status, `${label} (encoded)`).toBe(plain.status);
        if (method === 'GET') {
          const head = await client.head(path);
          expect(head.status === 403, `${label} (HEAD)`).toBe(refused);
          expect(head.body, `${label} (HEAD)`).toBeNull();
        }
      }
    }
    assertFoldsConsistent(h.db);
  });

  it('needs the re-auth window for the export and a replace import, and only there', async () => {
    const h = createSpaceHarness();
    const owner = h.owner.client;
    h.directory.reauth(h.owner.token, new Date(h.clock.now() - 11 * 60_000).toISOString());
    const exported = await owner.get('/api/data/export');
    expect(exported.status).toBe(403);
    expect(exported.body.error.code).toBe('reauth_required');
    expect((await owner.head('/api/data/export')).status).toBe(403);
    for (const step of ['analyze', 'commit']) {
      const imported = await owner.post(`/api/data/import/${step}?mode=replace`, {});
      expect(imported.body.error.code).toBe('reauth_required');
    }
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect((await owner.patch('/api/settings', { estimateUnit: 'hours' })).status).toBe(200);
    // 9 minutes ago is inside REAUTH_MINUTES (10).
    h.directory.reauth(h.owner.token, new Date(h.clock.now() - 9 * 60_000).toISOString());
    expect((await owner.get('/api/data/export')).status).toBe(200);
    expect((await owner.post('/api/data/import/commit?mode=replace', {})).status).toBe(400); // past the gate: no form
    expect(h.safety.calls).toBe(0);
  });

  it('re-authorizes fresh rules when the identity came from the auth cache', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    const owner = h.owner.client;
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect(h.directory.count('authorizeSpace')).toBe(1);
    // A demotion the push did not reach: cached reads keep the old role, the export sees the new one.
    h.directory.members.set(h.owner.userId, 'admin');
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect(h.directory.count('authorizeSpace')).toBe(1);
    const exported = await owner.get('/api/data/export');
    expect(exported.status).toBe(403);
    expect(exported.body.error.message).toBe('Only owners can do this.');
    expect(h.directory.count('authorizeSpace')).toBe(2);
    // A session revoked meanwhile: the fresh check answers 401.
    h.directory.members.set(h.owner.userId, 'owner');
    expect((await owner.get('/api/data/export')).status).toBe(200);
    h.directory.signOut(h.owner.token);
    expect((await owner.get('/api/tags')).status).toBe(200); // still cached
    expect((await owner.get('/api/data/export')).status).toBe(401);
  });

  it('does not re-authorize on Node, where every identity is fresh', async () => {
    const h = createSpaceHarness();
    await h.owner.client.get('/api/data/export');
    await h.owner.client.get('/api/data/export');
    expect(h.directory.count('authorizeSpace')).toBe(2);
  });

  it('refuses everything while the space is being imported', async () => {
    const h = createSpaceHarness();
    h.directory.space.status = 'importing';
    for (const [method, path] of [
      ['GET', '/api/tags'],
      ['POST', '/api/tasks/query'],
      ['GET', '/api/data/export'],
      ['POST', '/api/data/import/commit?mode=replace'],
      ['POST', '/api/people/me/disown'],
      ['DELETE', '/api/tags/1'],
    ] as const) {
      const res = await h.owner.client.request(method, path, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.error).toEqual({ code: 'space_unavailable', message: 'This space is still being imported.' });
    }
  });

  it('refuses writes when the space is full, except deletes and the import analysis', async () => {
    const h = createSpaceHarness({ config: { spaceMaxBytes: 1000 }, storageBytes: () => 2000 });
    const owner = h.owner.client;
    const created = await owner.post('/api/tags', { name: 'x' });
    expect(created.status).toBe(409);
    expect(created.body.error).toEqual({ code: 'quota_exceeded', message: 'This space is full. Delete something to make room.' });
    expect((await owner.patch('/api/settings', {})).status).toBe(409);
    expect((await owner.get('/api/tags')).status).toBe(200);
    expect((await owner.post('/api/tasks/query', {})).status).toBe(200);
    expect((await owner.delete('/api/tags/987654')).status).toBe(404);
    expect((await owner.post('/api/tasks/bulk-delete', { ids: [987654] })).status).toBe(400); // past the gate
    expect((await owner.post('/api/data/import/analyze?mode=replace', {})).status).toBe(400);
    expect((await owner.post('/api/data/import/commit?mode=replace', {})).body.error.code).toBe('quota_exceeded');
  });

  it('fails closed for a handler without a rule, and leaves unmatched paths to the 404', async () => {
    const h = createSpaceHarness();
    const app = createSpaceApp(h.deps);
    app.get('/api/extra', (c) => c.json({ reached: true }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await bindings(h);
    const res = await app.fetch(new Request('http://127.0.0.1/api/extra'), env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    expect(error).toHaveBeenCalledWith('[lyren] No gate rule for GET /api/extra');
    const head = await app.fetch(new Request('http://127.0.0.1/api/extra', { method: 'HEAD' }), env);
    expect(head.status).toBe(500);

    const missing = await h.owner.client.get('/api/nothing/here');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect((await h.owner.client.request('OPTIONS', '/api/tags')).status).toBe(404);
  });

  it('judges a request that two routes match by the handler that runs', async () => {
    const h = createSpaceHarness();
    const env = await bindings(h, 'viewer');
    for (const order of [['/:id', '/special'], ['/special', '/:id']]) {
      const rules: Record<string, GateRule> = {
        'GET /api/x/:id': { need: 'viewer', write: false },
        'GET /api/x/special': { need: 'owner', write: false },
      };
      const app = new Hono<AppEnv>();
      app.onError(handleError);
      app.use('/api/*', createGate(h.deps, rules));
      for (const route of order) app.get(`/api/x${route}`, (c) => c.json({ ran: route }));
      const res = await app.fetch(new Request('http://127.0.0.1/api/x/special'), env);
      if (res.status === 200) expect(((await res.json()) as { ran: string }).ran).toBe('/:id');
      else expect(order[0]).toBe('/special');
      expect(res.status).toBe(order[0] === '/:id' ? 200 : 403);
    }
  });
});

describe('a request whose body arrives late (Appendix D 27)', () => {
  /** A request whose body the test releases; it waits in the gate meanwhile. */
  function held(client: SpaceTestClient, method: string, path: string, json: unknown, chunked: boolean) {
    const body = heldBody(json, { chunked });
    return { response: client.request(method, path, body.stream, body.headers), release: body.release };
  }

  const tagCount = (h: ReturnType<typeof createSpaceHarness>) => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tags')!.n;

  for (const chunked of [false, true]) {
    const label = chunked ? 'chunked' : 'with a Content-Length';
    it(`is judged as of its arrival (${label}): removed, demoted or signed out meanwhile, nothing is written`, async () => {
      const h = createSpaceHarness();
      const member = h.addUser({ role: 'member' });

      const removed = held(member.client, 'POST', '/api/tags', { name: 'after removal' }, chunked);
      await settle();
      h.directory.removeMember(member.userId);
      removed.release();
      const notFound = await removed.response;
      expect(notFound.status).toBe(404);
      expect(notFound.body.error).toEqual({ code: 'not_found', message: 'Space not found' });

      const admin = h.addUser({ role: 'admin' });
      const demoted = held(admin.client, 'PATCH', '/api/settings', { estimateUnit: 'hours' }, chunked);
      await settle();
      h.directory.setRole(admin.userId, 'member');
      demoted.release();
      const forbidden = await demoted.response;
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.message).toBe('Only admins and owners can do this.');

      const signedOut = held(h.owner.client, 'POST', '/api/tags', { name: 'after sign-out' }, chunked);
      await settle();
      h.directory.signOut(h.owner.token);
      signedOut.release();
      expect((await signedOut.response).status).toBe(401);

      expect(tagCount(h)).toBe(0);
      expect((await admin.client.get('/api/settings')).body.estimateUnit).toBe('points');
    });
  }

  it('a delete with a held chunked body, by an admin removed meanwhile, deletes nothing', async () => {
    const h = createSpaceHarness();
    const project = (await h.owner.client.post<{ id: number }>('/api/projects', { name: 'Keep', key: 'KEEP' })).body;
    const admin = h.addUser({ role: 'admin' });
    const deletion = held(admin.client, 'DELETE', `/api/projects/${project.id}`, {}, true);
    await settle();
    h.directory.removeMember(admin.userId);
    deletion.release();
    expect((await deletion.response).status).toBe(404);
    expect((await h.owner.client.get(`/api/projects/${project.id}`)).status).toBe(200);
  });

  it('a fresh rule checks the re-auth window again after the body', async () => {
    const h = createSpaceHarness();
    const imported = held(h.owner.client, 'POST', '/api/data/import/commit?mode=replace', { file: 'not a form' }, true);
    await settle();
    h.directory.reauth(h.owner.token, new Date(h.clock.now() - 11 * 60_000).toISOString());
    imported.release();
    const res = await imported.response;
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');
    expect(h.safety.calls).toBe(0);
  });

  it('refuses what the identity before the body already refuses without reading the body', async () => {
    const h = createSpaceHarness();
    const viewer = h.addUser({ role: 'viewer' });
    // Never released: a refusal must not wait for it.
    const body = heldBody({ name: 'x' }, { chunked: true });
    const res = await viewer.client.request('POST', '/api/tags', body.stream, body.headers);
    expect(res.status).toBe(403);
    expect(h.directory.count('authorizeSpace')).toBe(1);
  });

  it('on Cloudflare the second look goes through the auth cache, which an invalidate empties', async () => {
    const h = createSpaceHarness({ authCacheTtlMs: 30_000 });
    const admin = h.addUser({ role: 'admin' });
    expect((await admin.client.get('/api/tags')).status).toBe(200);
    const calls = h.directory.count('authorizeSpace');
    // Nothing changed: both looks are answered from the cache.
    const unchanged = held(admin.client, 'PATCH', '/api/settings', { estimateUnit: 'hours' }, false);
    await settle();
    unchanged.release();
    expect((await unchanged.response).status).toBe(200);
    expect(h.directory.count('authorizeSpace')).toBe(calls);
    // A demotion the directory pushed while the body was on its way.
    const demoted = held(admin.client, 'PATCH', '/api/settings', { estimateUnit: 'points' }, false);
    await settle();
    h.directory.setRole(admin.userId, 'member');
    h.host.invalidate();
    demoted.release();
    expect((await demoted.response).status).toBe(403);
    expect(h.directory.count('authorizeSpace')).toBe(calls + 1);
    expect((await h.owner.client.get('/api/settings')).body.estimateUnit).toBe('hours');
  });

  it('is read under BODY_LIMIT, or IMPORT_BODY_LIMIT for the import (413 past it)', async () => {
    const h = createSpaceHarness({ config: { bodyLimit: 4096, importBodyLimit: 16384 } });
    const owner = h.owner.client;
    const chunked = (bytes: number) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"name":"${'x'.repeat(bytes)}"}`));
          controller.close();
        },
      });
      return stream;
    };
    const tooBig = await owner.request('POST', '/api/tags', chunked(5000), { 'Content-Type': 'application/json' });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('payload_too_large');
    const declared = await owner.request('POST', '/api/tags', '{}', { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    expect(declared.status).toBe(413);
    // The import takes the larger limit: past the gate, this is just not a form with a file.
    const commit = '/api/data/import/commit?mode=replace';
    expect((await owner.request('POST', commit, chunked(5000), { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await owner.request('POST', commit, chunked(20_000), { 'Content-Type': 'application/json' })).status).toBe(413);
    expect(h.safety.calls).toBe(0);
  });
});

describe('the import mode (§6.4 steps 2-3, for the import routes of P7)', () => {
  const rules: Record<string, GateRule> = {
    'POST /api/data/import/analyze': { need: 'owner', write: false, fresh: true, reauth: 'replace', importing: 'allowed', allowWhenFull: true },
    'POST /api/data/import/commit': { need: 'owner', write: true, fresh: true, reauth: 'replace', importing: 'allowed' },
  };

  function importApp(h: ReturnType<typeof createSpaceHarness>) {
    const app = new Hono<AppEnv>();
    app.onError(handleError);
    app.use('/api/*', createGate(h.deps, rules));
    app.post('/api/data/import/analyze', (c) => c.json({ mode: c.var.importMode }));
    app.post('/api/data/import/commit', (c) => c.json({ mode: c.var.importMode }));
    return app;
  }

  async function send(h: ReturnType<typeof createSpaceHarness>, query: string, o: { status?: 'importing' | 'active'; reauthAgoMs?: number } = {}) {
    const env = await bindings(h);
    const identity: SpaceIdentity = {
      ...env.identity,
      reauthAt: new Date(h.clock.now() - (o.reauthAgoMs ?? 0)).toISOString(),
      space: { ...env.identity.space, status: o.status ?? 'active' },
    };
    const res = await importApp(h).fetch(new Request(`http://127.0.0.1/api/data/import/commit${query}`, { method: 'POST' }), {
      ...env,
      identity,
      recheck: async () => ({ identity, fromCache: false }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('parses ?mode= once, before the status and re-auth checks', async () => {
    const h = createSpaceHarness();
    const missing = await send(h, '');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('query.mode');
    expect((await send(h, '?mode=other')).status).toBe(400);
    expect(await send(h, '?mode=new', { status: 'importing', reauthAgoMs: 3_600_000 })).toEqual({ status: 200, body: { mode: 'new' } });
    const imported = await send(h, '?mode=new');
    expect(imported.status).toBe(409);
    expect(imported.body.error).toEqual({ code: 'conflict', message: 'This space has already been imported' });
    expect((await send(h, '?mode=replace', { status: 'importing' })).body.error.code).toBe('space_unavailable');
    expect((await send(h, '?mode=replace', { reauthAgoMs: 3_600_000 })).body.error.code).toBe('reauth_required');
    expect(await send(h, '?mode=replace')).toEqual({ status: 200, body: { mode: 'replace' } });
  });

  it('never counts an import commit against the space write budget', async () => {
    const h = createSpaceHarness({ meter: true, config: { spaceDailyRowWrites: 1 } });
    h.spendBudget(5);
    expect(h.writeState.budgetLeft(h.clock.now())).toBe(0);
    const before = h.writeState.gen;
    expect((await send(h, '?mode=replace')).status).toBe(200);
    expect(h.writeState.gen).toBe(before + 1);
  });
});

describe('the data routes and what the space gives them (read snapshot, import gate, safety point)', () => {
  it('export: archive v2 of this space, through the read snapshot; HEAD builds nothing', async () => {
    const h = createSpaceHarness({ sampleData: true });
    const head = await h.owner.client.head('/api/data/export');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-disposition')).toMatch(/^attachment; filename="lyren-space-test-space-\d{4}-\d{2}-\d{2}\.json\.gz"$/);
    expect(head.headers.get('content-type')).toBe('application/gzip');
    expect(h.snapshots.calls).toBe(0);
    const res = await downloadArchive(h.owner.client);
    expect(res.status).toBe(200);
    expect(h.snapshots.calls).toBe(1);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.archive).toMatchObject({ format: 'lyren-plan-space', formatVersion: 2, space: { id: h.spaceId, name: 'Test space', exportedBy: h.owner.userId } });
    expect(res.archive!.settings).toEqual({ estimateUnit: 'points', defaultBoardId: 1 });
    expect(res.archive!.tasks.length).toBeGreaterThan(0);
    expect(res.archive!.tasks.every((t) => t.createdBy === h.owner.userId)).toBe(true);
    expect(res.archive!.users).toEqual([{ id: h.owner.userId, kind: 'account', displayName: 'Owner', email: 'owner@example.com' }]);
  });

  it('import: one at a time, the safety point first, every v1 reference to the importer, the members kept', async () => {
    const source = createSpaceHarness({ sampleData: true });
    const file = v1Of((await downloadArchive(source.owner.client)).archive!);
    // References to users the importing space has never heard of.
    file.tasks[0]!.createdBy = 42;
    file.comments.forEach((c) => (c.authorId = 43));
    file.projects[0]!.name = 'Überprüfung';

    const h = createSpaceHarness();
    const other = h.addUser({ role: 'member', displayName: 'Other' });
    await other.client.get('/api/tags');
    const mirrorBefore = mirrorRows(h.db);
    h.importGate.busy = true;
    const busy = await replaceImport(h.owner.client, file);
    expect(busy.status).toBe(503);
    expect(busy.body.error).toEqual({ code: 'unavailable', message: 'Another import is running. Try again in a minute.' });
    expect(h.safety.calls).toBe(0);
    h.importGate.busy = false;

    const res = await replaceImport(h.owner.client, file);
    expect(res.status).toBe(200);
    const backupFile = `backups/spaces/${h.spaceId}/pre-import-test.db`;
    expect(res.body).toMatchObject({ ok: true, safety: { kind: 'file', path: backupFile, restoreCommand: `restore "${backupFile}"` } });
    expect(res.body.counts.tasks).toBe(file.tasks.length);
    expect(h.safety.calls).toBe(1);
    expect(h.importGate.runs).toBe(1);
    expect(mirrorRows(h.db)).toEqual(mirrorBefore);
    const createdBy = h.db.all<{ created_by: number | null }>('SELECT DISTINCT created_by FROM tasks');
    expect(createdBy).toEqual([{ created_by: h.owner.userId }]);
    expect(h.db.all('SELECT DISTINCT user_id FROM comments')).toEqual([{ user_id: h.owner.userId }]);
    expect(h.db.get('SELECT name_fold FROM projects WHERE name = :name', { name: 'Überprüfung' })).toEqual({ name_fold: 'überprüfung' });
    assertFoldsConsistent(h.db);

    // A failed safety point aborts the import before anything changes.
    const tasks = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
    h.safety.fail = new Error('disk full (test)');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await replaceImport(h.owner.client, file)).status).toBe(500);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(tasks);
  });

  it('import: refused while another runs before a byte of its body is read, so parallel uploads are not buffered', async () => {
    const h = createSpaceHarness();
    let pulls = 0;
    // highWaterMark 0: the stream produces a chunk only when the server reads one.
    const upload = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls > 4) controller.close();
            else controller.enqueue(new Uint8Array(1024));
          },
        },
        { highWaterMark: 0 },
      );
    const multipart = { 'Content-Type': 'multipart/form-data; boundary=lyren' };
    h.importGate.busy = true;
    for (const step of ['analyze', 'commit']) {
      const res = await h.owner.client.request('POST', `/api/data/import/${step}?mode=replace`, upload(), multipart);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('unavailable');
    }
    expect(pulls).toBe(0);
    expect(h.importGate.runs).toBe(0);
  });

  it('Cloudflare has no safety point: safety is null', async () => {
    const h = createSpaceHarness({ runtime: 'cloudflare' });
    h.safety.point = null;
    const file = v1Of((await downloadArchive(h.owner.client)).archive!);
    const res = await replaceImport(h.owner.client, file);
    expect(res.status).toBe(200);
    expect(res.body.safety).toBeNull();
  });

  it('the instance backup is not a space route, nor the v1 import', async () => {
    const h = createSpaceHarness();
    expect((await h.owner.client.get('/api/data/backup')).status).toBe(404);
    expect((await h.owner.client.post('/api/data/import', importForm({}))).status).toBe(404);
  });
});

/** The bindings the host would pass for the owner (or another role of the owner's account). */
async function bindings(h: ReturnType<typeof createSpaceHarness>, role: SpaceRole = 'owner'): Promise<AppEnv['Bindings']> {
  const result = await h.directory.authorizeSpace({
    tokenHash: h.meta(h.owner.token).sessionTokenHash!,
    spaceId: h.spaceId,
    cookie: 'plain',
    secure: false,
  });
  if (!result.ok) throw new Error('owner is not authorized');
  const identity = { ...result.identity, role };
  return {
    identity,
    fromCache: false,
    reauthorize: async () => identity,
    recheck: async () => ({ identity, fromCache: false }),
    meta: h.meta(h.owner.token),
  };
}
