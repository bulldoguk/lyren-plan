import { describe, expect, it } from 'vitest';
import type { DashboardDTO } from '@shared/types';
import type { Db } from '../src/db';
import { recordActivity } from '../src/services/activity';
import { createTestContext } from './helpers';
import { insertProject, insertTask, statusIdByName, T0 } from './services.fixtures';

// 2026-05-20 is a Wednesday: Monday weeks run 05-18 … 05-24, Sunday weeks 05-17 … 05-23.
const TODAY = '2026-05-20';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setup() {
  const ctx = createTestContext();
  const { client, user } = await ctx.signedIn();
  const project = insertProject(ctx.db, 'WEB', { name: 'Website' });
  // §3.6: weekStartsOn is the viewer's preference, which the client sends in the query (default 1).
  const get = async (today: string | null = TODAY, weekStartsOn?: 0 | 1) => {
    const query = new URLSearchParams();
    if (today !== null) query.set('today', today);
    if (weekStartsOn !== undefined) query.set('weekStartsOn', String(weekStartsOn));
    const res = await client.get<DashboardDTO>(`/api/dashboard${query.size === 0 ? '' : `?${query}`}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  return { ...ctx, client, user, project, get };
}

const titles = (tasks: Array<{ title: string }>) => tasks.map((t) => t.title);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function insertWorklog(db: Db, userId: number | null, taskId: number, date: string, minutes: number | null, note = '') {
  db.run(
    `INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at)
     VALUES (:taskId, :userId, :date, :minutes, :note, :t, :t)`,
    { taskId, userId, date, minutes, note, t: T0 },
  );
}

describe('GET /api/dashboard', () => {
  it('requires a session', async () => {
    const ctx = createTestContext();
    await ctx.signedIn();
    const res = await ctx.client().get('/api/dashboard');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid ?today=', async () => {
    const { client } = await setup();
    for (const bad of ['2026-02-30', 'yesterday', '2026-5-1']) {
      const res = await client.get(`/api/dashboard?today=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.details[0].path).toBe('query.today');
    }
  });

  it('returns empty lists and zero totals for a fresh install', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const res = await client.get<DashboardDTO>(`/api/dashboard?today=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      today: TODAY,
      overdue: [],
      dueToday: [],
      dueSoon: [],
      inProgress: [],
      recentlyClosed: [],
      counts: { overdue: 0, dueToday: 0, dueSoon: 0, inProgress: 0, recentlyClosed: 0 },
      inProgressProjects: 0,
      slipped: 0,
      recentActivity: [],
      worklog: { todayMinutes: 0, weekMinutes: 0 },
    });
  });

  it("defaults today to the server's UTC date", async () => {
    const { get } = await setup();
    const body = await get(null);
    expect(body.today).toBe(new Date().toISOString().slice(0, 10));
  });

  it('lists open overdue tasks, oldest due date first, then the most urgent', async () => {
    const { db, project, get } = await setup();
    const done = statusIdByName(db, 'Done');
    const cancelled = statusIdByName(db, 'Cancelled');
    insertTask(db, { projectId: project, title: 'A', dueDate: '2026-05-10', priority: 1 });
    insertTask(db, { projectId: project, title: 'B', dueDate: '2026-05-10', priority: 4 });
    insertTask(db, { projectId: project, title: 'C', dueDate: '2026-05-15', priority: 0 });
    insertTask(db, { projectId: project, title: 'D', dueDate: '2026-05-10', priority: 0 });
    insertTask(db, { projectId: project, title: 'E (done)', dueDate: '2026-05-19', statusId: done, completedAt: ago(DAY) });
    insertTask(db, { projectId: project, title: 'G (cancelled)', dueDate: '2026-05-01', statusId: cancelled, completedAt: ago(DAY) });
    insertTask(db, { projectId: project, title: 'F (today)', dueDate: TODAY });
    insertTask(db, { projectId: project, title: 'H (no date)' });

    const body = await get();
    expect(titles(body.overdue)).toEqual(['B', 'A', 'D', 'C']);
    // Full TaskDTOs (hydrated: ref, tags, counts).
    expect(body.overdue[0]).toMatchObject({ ref: 'WEB-2', projectId: project, dueDate: '2026-05-10', tags: [], commentCount: 0 });
    // Relative to the client's day: a day earlier, C is not overdue yet.
    expect(titles((await get('2026-05-15')).overdue)).toEqual(['B', 'A', 'D']);
  });

  it('lists open tasks due today, most urgent first', async () => {
    const { db, project, get } = await setup();
    insertTask(db, { projectId: project, title: 'none', dueDate: TODAY, priority: 0 });
    insertTask(db, { projectId: project, title: 'high', dueDate: TODAY, priority: 3 });
    insertTask(db, { projectId: project, title: 'done', dueDate: TODAY, priority: 4, statusId: statusIdByName(db, 'Done') });
    insertTask(db, { projectId: project, title: 'started', dueDate: TODAY, priority: 2, statusId: statusIdByName(db, 'In Progress') });
    insertTask(db, { projectId: project, title: 'backlog', dueDate: TODAY, priority: 1, statusId: statusIdByName(db, 'Backlog') });
    insertTask(db, { projectId: project, title: 'tomorrow', dueDate: '2026-05-21', priority: 4 });

    const body = await get();
    expect(titles(body.dueToday)).toEqual(['high', 'started', 'backlog', 'none']);
    expect(body.overdue).toEqual([]);
  });

  it('lists open tasks due in the 7 days after today', async () => {
    const { db, project, get } = await setup();
    insertTask(db, { projectId: project, title: '+7', dueDate: '2026-05-27' });
    insertTask(db, { projectId: project, title: '+1 low', dueDate: '2026-05-21', priority: 1 });
    insertTask(db, { projectId: project, title: '+1 urgent', dueDate: '2026-05-21', priority: 4 });
    insertTask(db, { projectId: project, title: '+8', dueDate: '2026-05-28' });
    insertTask(db, { projectId: project, title: 'today', dueDate: TODAY });
    insertTask(db, { projectId: project, title: '+3 done', dueDate: '2026-05-23', statusId: statusIdByName(db, 'Done') });

    const body = await get();
    expect(titles(body.dueSoon)).toEqual(['+1 urgent', '+1 low', '+7']);
    expect(titles(body.dueToday)).toEqual(['today']);
  });

  it("lists tasks in a 'started' status, most recently updated first", async () => {
    const { db, project, get } = await setup();
    const inProgress = statusIdByName(db, 'In Progress');
    const inReview = statusIdByName(db, 'In Review');
    insertTask(db, { projectId: project, title: 'U1', statusId: inProgress, updatedAt: '2026-05-01T10:00:00.000Z' });
    insertTask(db, { projectId: project, title: 'U2', statusId: inReview, updatedAt: '2026-05-03T10:00:00.000Z' });
    insertTask(db, { projectId: project, title: 'todo', updatedAt: '2026-05-09T10:00:00.000Z' });
    insertTask(db, { projectId: project, title: 'U4', statusId: inProgress, updatedAt: '2026-05-02T10:00:00.000Z' });

    expect(titles((await get()).inProgress)).toEqual(['U2', 'U4', 'U1']);
  });

  it('lists tasks closed in the last 7 days, most recently closed first', async () => {
    const { db, project, get } = await setup();
    const done = statusIdByName(db, 'Done');
    const cancelled = statusIdByName(db, 'Cancelled');
    insertTask(db, { projectId: project, title: '6 days', statusId: done, completedAt: ago(6 * DAY) });
    insertTask(db, { projectId: project, title: '1 hour', statusId: done, completedAt: ago(HOUR) });
    insertTask(db, { projectId: project, title: '8 days', statusId: done, completedAt: ago(8 * DAY) });
    insertTask(db, { projectId: project, title: '3 days (cancelled)', statusId: cancelled, completedAt: ago(3 * DAY) });
    insertTask(db, { projectId: project, title: 'open', completedAt: null });

    expect(titles((await get()).recentlyClosed)).toEqual(['1 hour', '3 days (cancelled)', '6 days']);
  });

  it('hides archived tasks and tasks of archived projects, but not other project statuses', async () => {
    const { db, project, get } = await setup();
    const archivedProject = insertProject(db, 'OLD', { status: 'archived' });
    const onHold = insertProject(db, 'HOLD', { status: 'on_hold' });
    const completed = insertProject(db, 'FIN', { status: 'completed' });
    const inProgress = statusIdByName(db, 'In Progress');
    insertTask(db, { projectId: project, title: 'archived task', dueDate: '2026-05-01', archivedAt: T0 });
    insertTask(db, { projectId: archivedProject, title: 'archived project', dueDate: '2026-05-01' });
    insertTask(db, { projectId: archivedProject, title: 'archived project wip', statusId: inProgress });
    insertTask(db, { projectId: onHold, title: 'on hold', dueDate: '2026-05-02' });
    insertTask(db, { projectId: completed, title: 'completed project', dueDate: '2026-05-03' });
    insertTask(db, { projectId: project, title: 'archived wip', statusId: inProgress, archivedAt: T0 });

    const body = await get();
    expect(titles(body.overdue)).toEqual(['on hold', 'completed project']);
    expect(body.inProgress).toEqual([]);
    // Counts use the same filter as the lists.
    expect(body.counts).toMatchObject({ overdue: 2, inProgress: 0 });
    expect(body.inProgressProjects).toBe(0);
  });

  it('caps every list', async () => {
    const { db, project, get } = await setup();
    const done = statusIdByName(db, 'Done');
    for (let i = 0; i < 55; i++) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      insertTask(db, { projectId: project, title: `late ${i}`, dueDate: `2026-04-${day}` });
    }
    for (let i = 0; i < 25; i++) {
      insertTask(db, { projectId: project, title: `closed ${i}`, statusId: done, completedAt: ago((i + 1) * HOUR) });
    }
    const body = await get();
    expect(body.overdue).toHaveLength(50);
    // The 50 oldest: the five dropped ones are among the latest due dates.
    expect(body.overdue[0]!.dueDate).toBe('2026-04-01');
    expect(body.overdue.every((t, i, all) => i === 0 || all[i - 1]!.dueDate! <= t.dueDate!)).toBe(true);
    expect(body.recentlyClosed).toHaveLength(20);
    expect(body.recentlyClosed[0]!.title).toBe('closed 0');
    // The counts are uncapped, so a client can tell (and say) how many tasks a full list leaves out.
    expect(body.counts).toEqual({ overdue: 55, dueToday: 0, dueSoon: 0, inProgress: 0, recentlyClosed: 25 });
  });

  it('counts every in-progress task and project even when the list is capped', async () => {
    const { db, project, get } = await setup();
    const inProgress = statusIdByName(db, 'In Progress');
    const others = ['API', 'OPS', 'DOC'].map((key) => insertProject(db, key));
    // Older work in three other projects, then 55 newer tasks in one project: the capped list
    // (most recently updated first) holds only tasks of `project`.
    others.forEach((p, i) => {
      insertTask(db, { projectId: p, title: `other ${i}`, statusId: inProgress, updatedAt: '2026-01-01T00:00:00.000Z' });
    });
    for (let i = 0; i < 55; i++) {
      const updatedAt = `2026-05-${String(1 + (i % 19)).padStart(2, '0')}T00:00:00.000Z`;
      insertTask(db, { projectId: project, title: `wip ${i}`, statusId: inProgress, updatedAt });
    }
    // Archived work and archived projects stay out of the counts, as they do from the lists.
    insertTask(db, { projectId: others[0]!, title: 'archived wip', statusId: inProgress, archivedAt: T0 });
    const old = insertProject(db, 'OLD', { status: 'archived' });
    insertTask(db, { projectId: old, title: 'old wip', statusId: inProgress });

    const body = await get();
    expect(body.inProgress).toHaveLength(50);
    expect(new Set(body.inProgress.map((t) => t.projectId))).toEqual(new Set([project]));
    expect(body.counts.inProgress).toBe(58);
    expect(body.inProgressProjects).toBe(4);
  });

  it('includes the 15 latest activity entries, newest first', async () => {
    const { db, project, user, get } = await setup();
    const task = insertTask(db, { projectId: project, title: 'Logged' });
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        recordActivity(db, {
          userId: user.id,
          projectId: project,
          taskId: task,
          entityType: 'task',
          entityId: task,
          action: i === 0 ? 'task.created' : 'task.updated',
          data: { title: 'Logged', ref: 'WEB-1' },
        }),
      );
    }
    const body = await get();
    expect(body.recentActivity.map((a) => a.id)).toEqual(ids.slice(5).reverse());
    expect(body.recentActivity[0]).toMatchObject({
      action: 'task.updated',
      entityType: 'task',
      projectId: project,
      taskId: task,
      actor: { id: user.id, displayName: 'Owner' },
      task: { id: task, ref: 'WEB-1', title: 'Logged' },
    });
  });

  it("sums the viewer's work logs for today and the current week using ?weekStartsOn", async () => {
    const { db, project, get, user, addUser } = await setup();
    const task = insertTask(db, { projectId: project });
    const other = insertTask(db, { projectId: insertProject(db, 'OLD', { status: 'archived' }), archivedAt: T0 });
    const me = user.id;
    insertWorklog(db, me, task, '2026-05-16', 99); // Saturday of the previous Monday-week
    insertWorklog(db, me, task, '2026-05-17', 30); // Sunday
    insertWorklog(db, me, task, '2026-05-18', 60); // Monday
    insertWorklog(db, me, task, TODAY, 45);
    insertWorklog(db, me, other, TODAY, 15); // time spent counts even on archived work
    insertWorklog(db, me, task, TODAY, null, 'note only');
    insertWorklog(db, me, task, '2026-05-23', 10); // Saturday
    insertWorklog(db, me, task, '2026-05-24', 20); // Sunday
    insertWorklog(db, me, task, '2026-05-25', 99); // next Monday
    // §7.3: the totals are the viewer's own, not another member's, nor a deleted account's.
    const member = await addUser({ email: 'm@example.com', displayName: 'Mia' });
    expect((await member.client.get('/api/statuses')).status).toBe(200); // the mirror holds the account now
    insertWorklog(db, member.user.id, task, TODAY, 500, 'another member');
    insertWorklog(db, member.user.id, task, '2026-05-19', 400, 'another member');
    insertWorklog(db, null, task, TODAY, 300, 'a deleted account');

    expect((await get()).worklog).toEqual({ todayMinutes: 60, weekMinutes: 60 + 60 + 10 + 20 });
    expect((await get(TODAY, 0)).worklog).toEqual({ todayMinutes: 60, weekMinutes: 30 + 60 + 60 + 10 });
    // Another day of the same week (client's today decides).
    expect((await get('2026-05-23', 0)).worklog).toEqual({ todayMinutes: 10, weekMinutes: 160 });
  });

  it('is read-only (writes no activity)', async () => {
    const { db, project, get } = await setup();
    insertTask(db, { projectId: project, dueDate: '2026-05-01' });
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n;
    await get();
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n).toBe(before);
  });
});
