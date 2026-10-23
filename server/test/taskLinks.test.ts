// API tests for task dependencies (docs/design/task-dependencies.md): links (POST/DELETE
// /api/tasks/:id/blockers), the adjusted dates on task reads, filters, sorting and the dashboard, deleting a
// blocker, and rebaselining (POST /api/tasks/rebaseline(/preview)).

import { describe, expect, it } from 'vitest';
import type { ActivityData, DashboardDTO, RebaselineItemDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import type { Db } from '../src/db';
import type { ActivityRow } from '../src/services/rows';
import { createTestContext } from './helpers';
import { insertProject, statusIdByName } from './services.fixtures';

const TODAY = '2026-10-23';

async function setup() {
  const ctx = createTestContext();
  const { client } = await ctx.signedIn();
  const alpha = insertProject(ctx.db, 'ALP', { name: 'Alpha' });
  const beta = insertProject(ctx.db, 'BET', { name: 'Beta' });
  const done = statusIdByName(ctx.db, 'Done');
  const cancelled = statusIdByName(ctx.db, 'Cancelled');
  const create = async (body: Record<string, unknown>): Promise<TaskDTO> => {
    const res = await client.post<TaskDTO>('/api/tasks', { projectId: alpha, ...body });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const link = (blockedId: number, blockerId: number) => client.post<any>(`/api/tasks/${blockedId}/blockers`, { blockerId });
  const get = async (id: number): Promise<TaskDTO> => (await client.get<TaskDTO>(`/api/tasks/${id}?today=${TODAY}`)).body;
  const query = async (body: Record<string, unknown>): Promise<TaskDTO[]> =>
    (await client.post<TaskQueryResult>('/api/tasks/query', { today: TODAY, ...body })).body.tasks;
  return { ctx, client, alpha, beta, done, cancelled, create, link, get, query };
}

function activityOf(ctx: { db: Db }, taskId: number): ActivityData[] {
  return ctx.db
    .all<ActivityRow>("SELECT * FROM activity WHERE task_id = :taskId AND action = 'task.updated' ORDER BY id", { taskId })
    .map((r) => JSON.parse(r.data) as ActivityData);
}

describe('links', () => {
  it('links two tasks and reports both sides', async () => {
    const t = await setup();
    const a = await t.create({ title: 'Design', dueDate: '2026-10-28' });
    const b = await t.create({ title: 'Build', startDate: '2026-10-26', dueDate: '2026-10-29' });
    const res = await t.link(b.id, a.id);
    expect(res.status).toBe(200);
    expect(res.body.blockedBy).toEqual([a.id]);
    const blocked = await t.get(b.id);
    expect(blocked).toMatchObject({
      blockedBy: [a.id],
      blocks: [],
      adjustedStartDate: '2026-10-29',
      adjustedDueDate: '2026-11-01',
      slipDays: 3,
      dueDate: '2026-10-29',
    });
    expect((await t.get(a.id)).blocks).toEqual([b.id]);
    expect(activityOf(t.ctx, b.id).at(-1)?.changes).toEqual([{ field: 'blockedBy', added: ['ALP-1'], removed: [] }]);
  });

  it('links across projects of the space', async () => {
    const t = await setup();
    const a = await t.create({ title: 'Ops', projectId: t.beta });
    const b = await t.create({ title: 'App' });
    expect((await t.link(b.id, a.id)).status).toBe(200);
  });

  it('refuses a task blocking itself, an unknown blocker and a cycle', async () => {
    const t = await setup();
    const a = await t.create({ title: 'A' });
    const b = await t.create({ title: 'B' });
    const c = await t.create({ title: 'C' });
    expect((await t.link(a.id, a.id)).status).toBe(400);
    expect((await t.link(a.id, 9999)).status).toBe(400);
    expect((await t.client.post('/api/tasks/9999/blockers', { blockerId: a.id })).status).toBe(404);
    await t.link(b.id, a.id);
    await t.link(c.id, b.id);
    const cycle = await t.link(a.id, c.id);
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.message).toBe("ALP-3 can't block ALP-1: it already waits on it");
  });

  it('adds an existing link once and removes it once', async () => {
    const t = await setup();
    const a = await t.create({ title: 'A' });
    const b = await t.create({ title: 'B' });
    await t.link(b.id, a.id);
    await t.link(b.id, a.id);
    expect(activityOf(t.ctx, b.id)).toHaveLength(1);
    const removed = await t.client.delete<TaskDTO>(`/api/tasks/${b.id}/blockers/${a.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.blockedBy).toEqual([]);
    await t.client.delete(`/api/tasks/${b.id}/blockers/${a.id}`);
    const changes = activityOf(t.ctx, b.id).map((d) => d.changes);
    expect(changes).toEqual([
      [{ field: 'blockedBy', added: ['ALP-1'], removed: [] }],
      [{ field: 'blockedBy', added: [], removed: ['ALP-1'] }],
    ]);
  });

  it('removes the links of a deleted task and notes it on the tasks it blocked', async () => {
    const t = await setup();
    const a = await t.create({ title: 'A', dueDate: '2026-11-30' });
    const b = await t.create({ title: 'B', dueDate: '2026-10-24' });
    await t.link(b.id, a.id);
    expect((await t.client.delete(`/api/tasks/${a.id}`)).status).toBe(200);
    expect(await t.get(b.id)).toMatchObject({ blockedBy: [], slipDays: 0, adjustedDueDate: '2026-10-24' });
    expect(activityOf(t.ctx, b.id).at(-1)?.changes).toEqual([{ field: 'blockedBy', added: [], removed: ['ALP-1'] }]);
  });

  it('lets a viewer read links but not change them', async () => {
    const t = await setup();
    const a = await t.create({ title: 'A' });
    const b = await t.create({ title: 'B' });
    const viewer = await t.ctx.addUser({ email: 'viewer@example.com', role: 'viewer' });
    expect((await viewer.client.post(`/api/tasks/${b.id}/blockers`, { blockerId: a.id })).status).toBe(403);
    expect((await viewer.client.get(`/api/tasks/${b.id}`)).status).toBe(200);
  });
});

describe('adjusted dates in lists', () => {
  async function slipped() {
    const t = await setup();
    // A runs late, which pushes B past C although B was due first.
    const a = await t.create({ title: 'A', dueDate: '2026-10-30' });
    const b = await t.create({ title: 'B', dueDate: '2026-10-25' });
    const c = await t.create({ title: 'C', dueDate: '2026-10-27' });
    await t.link(b.id, a.id);
    return { ...t, a, b, c };
  }

  it('sorts and filters by the adjusted due date', async () => {
    const t = await slipped();
    const byDue = await t.query({ sort: { field: 'dueDate', dir: 'asc' } });
    expect(byDue.map((x) => x.title)).toEqual(['C', 'A', 'B']);
    const dueNextWeek = await t.query({ filter: { dueFrom: '2026-10-24', dueTo: '2026-10-26' } });
    expect(dueNextWeek).toEqual([]);
    const late = await t.query({ filter: { dueFrom: '2026-10-31' } });
    expect(late.map((x) => x.title)).toEqual(['B']);
  });

  it('filters the slipped tasks', async () => {
    const t = await slipped();
    expect((await t.query({ filter: { slipped: true } })).map((x) => x.title)).toEqual(['B']);
    expect(await t.query({ filter: { slipped: true, projectIds: [t.beta] } })).toEqual([]);
  });

  it('counts open slipped tasks on the dashboard', async () => {
    const t = await slipped();
    const dash = (await t.client.get<DashboardDTO>(`/api/dashboard?today=${TODAY}`)).body;
    expect(dash.slipped).toBe(1);
    expect(dash.dueSoon.map((x) => x.title)).toEqual(['C', 'A']);
    await t.client.patch(`/api/tasks/${t.b.id}`, { statusId: t.done });
    expect((await t.client.get<DashboardDTO>(`/api/dashboard?today=${TODAY}`)).body.slipped).toBe(0);
  });

  it('stops blocking when the blocker is cancelled, and blocks again when it reopens', async () => {
    const t = await slipped();
    const todo = (await t.get(t.a.id)).statusId;
    await t.client.patch(`/api/tasks/${t.a.id}`, { statusId: t.cancelled });
    expect((await t.get(t.b.id)).slipDays).toBe(0);
    await t.client.patch(`/api/tasks/${t.a.id}`, { statusId: todo });
    expect((await t.get(t.b.id)).slipDays).toBe(6);
  });

  it('lets the blocked task close before its blocker', async () => {
    const t = await slipped();
    const res = await t.client.patch<TaskDTO>(`/api/tasks/${t.b.id}`, { statusId: t.done });
    expect(res.status).toBe(200);
    expect((await t.get(t.b.id)).slipDays).toBe(0);
  });
});

describe('rebaseline', () => {
  async function chain() {
    const t = await setup();
    const a = await t.create({ title: 'A', dueDate: '2026-10-30' });
    const b = await t.create({ title: 'B', startDate: '2026-10-26', dueDate: '2026-10-27' });
    const c = await t.create({ title: 'C', projectId: t.beta, dueDate: '2026-10-28' });
    await t.link(b.id, a.id);
    await t.link(c.id, b.id);
    return { ...t, a, b, c };
  }

  it('previews the moves without changing anything', async () => {
    const t = await chain();
    const res = await t.client.post<{ items: RebaselineItemDTO[] }>('/api/tasks/rebaseline/preview', { projectId: t.alpha, today: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        taskId: t.b.id,
        ref: 'ALP-2',
        title: 'B',
        from: { startDate: '2026-10-26', dueDate: '2026-10-27' },
        to: { startDate: '2026-10-31', dueDate: '2026-11-01' },
        slipDays: 5,
      },
    ]);
    expect((await t.get(t.b.id)).dueDate).toBe('2026-10-27');
  });

  it('moves start and due together, logs it, and leaves no slip behind', async () => {
    const t = await chain();
    const res = await t.client.post<{ items: RebaselineItemDTO[] }>('/api/tasks/rebaseline', { ids: [t.b.id, t.c.id], today: TODAY });
    expect(res.body.items.map((i) => i.ref)).toEqual(['ALP-2', 'BET-1']);
    expect(await t.get(t.b.id)).toMatchObject({ startDate: '2026-10-31', dueDate: '2026-11-01', slipDays: 0 });
    expect(await t.get(t.c.id)).toMatchObject({ startDate: null, dueDate: '2026-11-02', slipDays: 0 });
    const logged = activityOf(t.ctx, t.b.id).at(-1)!;
    expect(logged.rebaseline).toBe(true);
    expect(logged.changes).toEqual([
      { field: 'startDate', from: '2026-10-26', to: '2026-10-31' },
      { field: 'dueDate', from: '2026-10-27', to: '2026-11-01' },
    ]);
    expect((await t.query({ filter: { slipped: true } }))).toEqual([]);
  });

  it('asks for a project or a selection, not both', async () => {
    const t = await chain();
    expect((await t.client.post('/api/tasks/rebaseline', {})).status).toBe(400);
    expect((await t.client.post('/api/tasks/rebaseline', { projectId: t.alpha, ids: [t.b.id] })).status).toBe(400);
  });
});
