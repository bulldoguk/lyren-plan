// Contract between GET /api/dashboard and the web dashboard's "Show more" for truncated lists:
// POST /api/tasks/query with the web's section queries (web/src/features/dashboard/
// dashboardModel.ts), in the web's order, must reproduce each dashboard list, and its total
// must equal the list's count. The web loads a whole section at once (useFullSection): the
// server's sort is not the dashboard's order, so pages of it are not prefixes of that order.

import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { DashboardDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import { compareDashboardTasks, dashboardSectionQuery, type DashboardSection } from '../../web/src/features/dashboard/dashboardModel';
import { createTestContext } from './helpers';
import { insertProject, insertTask, statusIdByName, T0 } from './services.fixtures';

const TODAY = '2026-05-20';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** The sections the server lists ('slipped' is the client's: DashboardDTO counts it only). */
const SECTIONS: Array<Exclude<DashboardSection, 'slipped'>> = ['overdue', 'dueToday', 'dueSoon', 'inProgress', 'recentlyClosed'];

describe('dashboard sections through POST /api/tasks/query', () => {
  it('reproduce every dashboard list and count, truncated lists included', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const { db } = ctx;
    const web = insertProject(db, 'WEB');
    const ops = insertProject(db, 'OPS');
    const old = insertProject(db, 'OLD', { status: 'archived' });
    const backlog = statusIdByName(db, 'Backlog');
    const started = statusIdByName(db, 'In Progress');
    const review = statusIdByName(db, 'In Review');
    const done = statusIdByName(db, 'Done');
    const cancelled = statusIdByName(db, 'Cancelled');

    // 70 overdue tasks over 9 due dates and every priority, so the cap cuts through ties.
    for (let i = 0; i < 70; i++) {
      const day = String(1 + (i % 9)).padStart(2, '0');
      insertTask(db, { projectId: i % 2 ? web : ops, title: `late ${i}`, dueDate: `2026-05-${day}`, priority: (i % 5) as 0 | 1 | 2 | 3 | 4 });
    }
    // Due today (open and closed), due soon (in and out of the window, backlog included).
    for (let i = 0; i < 6; i++) insertTask(db, { projectId: web, title: `today ${i}`, dueDate: TODAY, priority: (i % 3) as 0 | 1 | 2 });
    insertTask(db, { projectId: web, title: 'done today', dueDate: TODAY, statusId: done, completedAt: ago(HOUR) });
    for (let i = 0; i < 60; i++) {
      const day = String(21 + (i % 8)).padStart(2, '0'); // 05-21 … 05-28: the 28th is outside the window
      insertTask(db, { projectId: ops, title: `soon ${i}`, dueDate: `2026-05-${day}`, statusId: i % 4 ? undefined : backlog });
    }
    // 55 started tasks with shared updatedAt values (ties broken by id).
    for (let i = 0; i < 55; i++) {
      const updatedAt = `2026-05-${String(1 + (i % 11)).padStart(2, '0')}T00:00:00.000Z`;
      insertTask(db, { projectId: i % 3 ? web : ops, title: `wip ${i}`, statusId: i % 2 ? started : review, updatedAt });
    }
    // 26 closed in the window (one without completedAt), 2 closed long ago.
    for (let i = 0; i < 25; i++) {
      insertTask(db, { projectId: web, title: `closed ${i}`, statusId: i % 5 ? done : cancelled, completedAt: ago((i % 12) * HOUR + HOUR) });
    }
    insertTask(db, { projectId: web, title: 'closed, no date', statusId: done, completedAt: null });
    insertTask(db, { projectId: web, title: 'closed long ago', statusId: done, completedAt: ago(30 * 24 * HOUR) });
    // Never on the dashboard: archived tasks and tasks of archived projects.
    insertTask(db, { projectId: web, title: 'archived late', dueDate: '2026-05-01', archivedAt: T0 });
    insertTask(db, { projectId: old, title: 'old late', dueDate: '2026-05-01', statusId: started });

    const dash = (await client.get<DashboardDTO>(`/api/dashboard?today=${TODAY}`)).body;
    expect(dash.counts).toEqual({ overdue: 70, dueToday: 6, dueSoon: 53, inProgress: 55, recentlyClosed: 27 });

    const ids = (tasks: TaskDTO[]) => tasks.map((t) => t.id);
    for (const section of SECTIONS) {
      // As useFullSection does: the whole section in one request, sorted on the client.
      const res = await client.post<TaskQueryResult>('/api/tasks/query', dashboardSectionQuery(section, TODAY, LIMITS.queryLimitMax));
      expect(res.status).toBe(200);
      const all = [...res.body.tasks].sort(compareDashboardTasks(section));
      expect(res.body.total, section).toBe(dash.counts[section]);
      expect(all, section).toHaveLength(dash.counts[section]);
      expect(ids(all.slice(0, dash[section].length)), section).toEqual(ids(dash[section]));

    }
  });

  it('keeps the latest completion first when other closed tasks were edited later (more than one page)', async () => {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    const { db } = ctx;
    const web = insertProject(db, 'WEB');
    const done = statusIdByName(db, 'Done');
    // 205 tasks closed two hours ago but edited (e.g. bulk-tagged) a minute ago…
    for (let i = 0; i < 205; i++) {
      insertTask(db, { projectId: web, title: `cleanup ${i}`, statusId: done, completedAt: ago(2 * HOUR + i * 1000), updatedAt: ago(60_000) });
    }
    // …and one closed an hour ago, untouched since.
    const latest = insertTask(db, { projectId: web, title: 'most recently completed', statusId: done, completedAt: ago(HOUR), updatedAt: ago(HOUR) });
    // Due-date ties across a page boundary: 30 low-priority tasks due the same day as 3 urgent ones.
    for (let i = 0; i < 30; i++) insertTask(db, { projectId: web, title: `low ${i}`, dueDate: '2026-05-10', priority: 1 });
    for (let i = 0; i < 3; i++) insertTask(db, { projectId: web, title: `urgent ${i}`, dueDate: '2026-05-10', priority: 4 });

    const dash = (await client.get<DashboardDTO>(`/api/dashboard?today=${TODAY}`)).body;
    expect(dash.recentlyClosed[0]!.id).toBe(latest);
    expect(dash.overdue.slice(0, 3).map((t) => t.priority)).toEqual([4, 4, 4]);

    for (const section of ['recentlyClosed', 'overdue'] as const) {
      const res = await client.post<TaskQueryResult>('/api/tasks/query', dashboardSectionQuery(section, TODAY, LIMITS.queryLimitMax));
      const all = [...res.body.tasks].sort(compareDashboardTasks(section));
      expect(all.map((t) => t.id).slice(0, dash[section].length), section).toEqual(dash[section].map((t) => t.id));
    }
    // Why the web never pages through the server's sort: its first page of 200 misses the latest completion.
    const page = await client.post<TaskQueryResult>('/api/tasks/query', dashboardSectionQuery('recentlyClosed', TODAY, 200));
    expect(page.body.tasks.some((t) => t.id === latest)).toBe(false);
  });
});
