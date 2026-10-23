// The single-scan statistics and dashboard (design §2.4.1 item 7, §11.2, Appendix D 42) against the queries
// they replaced, which this file keeps as its oracle: services/stats.ts, the hydration and filter SQL of
// services/tasks.ts and routes/dashboard.ts as of P2, verbatim but for their names. On random spaces of
// many seeds, on edge cases and on a space of more than 2,000 tasks, every statistic (whole space and scoped), the
// bootstrap lists, the getters, the dashboard and the hydrated tasks must be identical, value for value.
// Run on NodeDb by server/test/stats.equivalence.test.ts and on DoDb in workerd by
// server/test-workers/stats.test.ts.
//
// The worlds exercise what the JS must get exactly as SQLite did: estimates whose sums round (0.1, 1/3), text
// that JS's `<` orders differently from SQLite's BINARY (a supplementary character against U+E000-U+FFFF in
// ranks and due dates, a due date with a time), ties of every sort key, NULLs, archived tasks and archived
// projects, open tasks with a completedAt, closed ones without, cut-offs to the millisecond, every status
// category, statuses and tags nothing uses, and rows deleted afterwards (cascades and SET NULLs).

import { describe, expect, it } from 'vitest';
import {
  EPIC_STATUSES,
  isClosedCategory,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
  type Priority,
  type StatusCategory,
} from '@shared/constants';
import { addDays, endOfWeek, resolveDuePreset, startOfWeek, type WeekStart } from '@shared/dates';
import type { TaskFilter } from '@shared/schemas';
import type { DashboardDTO, MilestoneDTO, ProgressStats, ProjectStats, TagRef, TaskDTO } from '@shared/types';
import type { Db, SqlValue } from '../../src/db';
import { buildDashboard, DASHBOARD_LIMITS } from '../../src/routes/dashboard';
import { listActivity } from '../../src/services/activity';
import {
  getEpic,
  getMilestone,
  getProject,
  getStatus,
  getTag,
  listEpics,
  listMilestones,
  listProjects,
  listStatuses,
  listTags,
} from '../../src/services/entities';
import {
  compareTagNames,
  toEpicDTO,
  toMilestoneDTO,
  toProjectDTO,
  toStatusDTO,
  toTagDTO,
  toTagRef,
} from '../../src/services/mappers';
import type { EpicRow, MilestoneRow, ProjectRow, StatusRow, TagRow, TaskRow } from '../../src/services/rows';
import { CLOSED_CATEGORIES_SQL, idScope, inJson, jsonList } from '../../src/services/sql';
import {
  emptyMilestoneStats,
  emptyProgressStats,
  emptyProjectStats,
  epicStats,
  milestoneStats,
  projectStats,
  spaceStats,
  statusTaskCounts,
  tagTaskCounts,
} from '../../src/services/stats';
import { getTaskDTOs, hydrateTasks, TASK_COLUMNS, TASK_FROM, type TaskWhereContext } from '../../src/services/tasks';
import {
  insertEpic,
  insertMilestone,
  insertProject,
  insertStatus,
  insertTag,
  insertTask,
  prng,
  type WithSpaceDb,
} from './fixtures';

// ---------------------------------------------------------------------------
// The oracle: the queries of P2
// ---------------------------------------------------------------------------

type OldMilestoneStats = MilestoneDTO['stats'];

interface CountRow {
  id: number;
  total: number;
  done: number;
}

interface ProgressRow {
  id: number;
  tasks_total: number;
  tasks_closed: number;
  estimate_total: number;
  estimate_closed: number;
}

const COUNTED_TASK_SQL = `(t.archived_at IS NULL OR s.category IN ${CLOSED_CATEGORIES_SQL})`;

const PROGRESS_COLUMNS = `
  COUNT(*) AS tasks_total,
  COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN 1 ELSE 0 END), 0) AS tasks_closed,
  COALESCE(SUM(t.estimate), 0) AS estimate_total,
  COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN t.estimate ELSE 0 END), 0) AS estimate_closed`;

function toProgress(row: ProgressRow): ProgressStats {
  return {
    tasksTotal: row.tasks_total,
    tasksClosed: row.tasks_closed,
    estimateTotal: row.estimate_total,
    estimateClosed: row.estimate_closed,
  };
}

function oldProjectStats(db: Db, today: string, projectIds?: readonly number[]): Map<number, ProjectStats> {
  const out = new Map<number, ProjectStats>();
  const entry = (id: number): ProjectStats => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyProjectStats()));
    return s;
  };
  const tasks = idScope('t.project_id', projectIds);
  const taskRows = db.all<{ id: number; total: number; closed: number; overdue: number }>(
    `SELECT t.project_id AS id,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN s.category IN ${CLOSED_CATEGORIES_SQL} THEN 1 ELSE 0 END), 0) AS closed,
            COALESCE(SUM(CASE WHEN s.category NOT IN ${CLOSED_CATEGORIES_SQL} AND t.due_date < :today THEN 1 ELSE 0 END), 0) AS overdue
       FROM tasks t JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND ${tasks.sql}
      GROUP BY t.project_id`,
    { ...tasks.params, today },
  );
  for (const r of taskRows) {
    const s = entry(r.id);
    s.tasksTotal = r.total;
    s.tasksClosed = r.closed;
    s.tasksOpen = r.total - r.closed;
    s.tasksOverdue = r.overdue;
  }
  const byProject = idScope('project_id', projectIds);
  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS done
       FROM milestones WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(r.id);
    s.milestonesTotal = r.total;
    s.milestonesCompleted = r.done;
  }
  for (const r of db.all<CountRow>(
    `SELECT project_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE ${byProject.sql} GROUP BY project_id`,
    byProject.params,
  )) {
    const s = entry(r.id);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

function oldMilestoneStats(db: Db, milestoneIds?: readonly number[]): Map<number, OldMilestoneStats> {
  const out = new Map<number, OldMilestoneStats>();
  const entry = (id: number): OldMilestoneStats => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyMilestoneStats()));
    return s;
  };
  const tasks = idScope('e.milestone_id', milestoneIds);
  for (const r of db.all<ProgressRow>(
    `SELECT e.milestone_id AS id, ${PROGRESS_COLUMNS}
       FROM tasks t
       JOIN epics e ON e.id = t.epic_id
       JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND e.milestone_id IS NOT NULL AND ${tasks.sql}
      GROUP BY e.milestone_id`,
    tasks.params,
  )) {
    Object.assign(entry(r.id), toProgress(r));
  }
  const epics = idScope('milestone_id', milestoneIds);
  for (const r of db.all<CountRow>(
    `SELECT milestone_id AS id, COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done
       FROM epics WHERE milestone_id IS NOT NULL AND ${epics.sql} GROUP BY milestone_id`,
    epics.params,
  )) {
    const s = entry(r.id);
    s.epicsTotal = r.total;
    s.epicsDone = r.done;
  }
  return out;
}

function oldEpicStats(db: Db, epicIds?: readonly number[]): Map<number, ProgressStats> {
  const scope = idScope('t.epic_id', epicIds);
  const rows = db.all<ProgressRow>(
    `SELECT t.epic_id AS id, ${PROGRESS_COLUMNS}
       FROM tasks t JOIN statuses s ON s.id = t.status_id
      WHERE ${COUNTED_TASK_SQL} AND t.epic_id IS NOT NULL AND ${scope.sql}
      GROUP BY t.epic_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, toProgress(r)]));
}

function oldStatusTaskCounts(db: Db, statusIds?: readonly number[]): Map<number, number> {
  const scope = idScope('status_id', statusIds);
  const rows = db.all<{ id: number; n: number }>(
    `SELECT status_id AS id, COUNT(*) AS n FROM tasks WHERE ${scope.sql} GROUP BY status_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

function oldTagTaskCounts(db: Db, tagIds?: readonly number[]): Map<number, number> {
  const scope = idScope('tt.tag_id', tagIds);
  const rows = db.all<{ id: number; n: number }>(
    `SELECT tt.tag_id AS id, COUNT(*) AS n
       FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
      WHERE t.archived_at IS NULL AND ${scope.sql}
      GROUP BY tt.tag_id`,
    scope.params,
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** The old hydration: tags through task_tags, counts by id lists. */
function oldHydrateTasks(db: Db, rows: readonly TaskRow[]): TaskDTO[] {
  if (rows.length === 0) return [];
  const taskIds = jsonList(rows.map((r) => r.id));
  const keys = new Map(
    db
      .all<{ id: number; key: string }>(`SELECT id, key FROM projects WHERE ${inJson('id', 'ids')}`, {
        ids: jsonList(rows.map((r) => r.project_id)),
      })
      .map((p) => [p.id, p.key]),
  );
  const epicIds = rows.map((r) => r.epic_id).filter((id): id is number => id !== null);
  const milestones = new Map(
    epicIds.length === 0
      ? []
      : db
          .all<{ id: number; milestone_id: number | null }>(`SELECT id, milestone_id FROM epics WHERE ${inJson('id', 'ids')}`, {
              ids: jsonList(epicIds),
            })
          .map((e) => [e.id, e.milestone_id]),
  );
  const tags = new Map<number, TagRef[]>();
  for (const r of db.all<{ task_id: number; id: number; name: string; color: string }>(
    `SELECT tt.task_id, g.id, g.name, g.color
       FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
      WHERE ${inJson('tt.task_id', 'ids')}`,
    { ids: taskIds },
  )) {
    const list = tags.get(r.task_id);
    if (list) list.push(toTagRef(r));
    else tags.set(r.task_id, [toTagRef(r)]);
  }
  for (const list of tags.values()) list.sort(compareTagNames);
  const comments = new Map(
    db
      .all<{ task_id: number; n: number }>(
        `SELECT task_id, COUNT(*) AS n FROM comments WHERE ${inJson('task_id', 'ids')} GROUP BY task_id`,
        { ids: taskIds },
      )
      .map((c) => [c.task_id, c.n]),
  );
  const minutes = new Map(
    db
      .all<{ task_id: number; n: number }>(
        `SELECT task_id, COALESCE(SUM(minutes), 0) AS n FROM work_logs WHERE ${inJson('task_id', 'ids')} GROUP BY task_id`,
        { ids: taskIds },
      )
      .map((w) => [w.task_id, w.n]),
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    ref: `${keys.get(r.project_id) ?? '?'}-${r.number}`,
    epicId: r.epic_id,
    milestoneId: r.epic_id === null ? null : (milestones.get(r.epic_id) ?? null),
    statusId: r.status_id,
    priority: r.priority,
    title: r.title,
    description: r.description,
    startDate: r.start_date,
    dueDate: r.due_date,
    estimate: r.estimate,
    rank: r.rank,
    completedAt: r.completed_at,
    archivedAt: r.archived_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tags: tags.get(r.id) ?? [],
    commentCount: comments.get(r.id) ?? 0,
    worklogMinutes: minutes.get(r.id) ?? 0,
    // These suites link no tasks: every task keeps its own dates.
    blockedBy: [],
    blocks: [],
    adjustedStartDate: r.start_date,
    adjustedDueDate: r.due_date,
    slipDays: 0,
  }));
}

const OLD_TASK_FROM = `tasks t
  JOIN projects p ON p.id = t.project_id
  JOIN statuses s ON s.id = t.status_id
  LEFT JOIN epics e ON e.id = t.epic_id`;

const OLD_TASK_CLOSED_SQL = `s.category IN ${CLOSED_CATEGORIES_SQL}`;

/** The old buildTaskWhere, for the keys the dashboard's filters use. */
function oldTaskWhere(filter: TaskFilter, ctx: TaskWhereContext): { sql: string; params: Record<string, SqlValue> } {
  const clauses: string[] = [];
  const params: Record<string, SqlValue> = {};
  const param = (value: SqlValue): string => {
    const name = `f${Object.keys(params).length}`;
    params[name] = value;
    return `:${name}`;
  };
  const inList = (column: string, values: Iterable<number | string>): string =>
    `${column} IN (SELECT value FROM json_each(${param(jsonList(values))}))`;
  const anyOf = (parts: string[]): string => (parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`);
  if (filter.projectIds?.length) clauses.push(inList('t.project_id', filter.projectIds));
  else if (!filter.includeArchivedProjects) clauses.push("p.status <> 'archived'");
  if (filter.statusCategories?.length) clauses.push(inList('s.category', filter.statusCategories));
  if (filter.due?.length) {
    const parts = [...new Set(filter.due)].map((preset) => {
      const r = resolveDuePreset(preset, ctx.today, ctx.weekStartsOn);
      switch (r.kind) {
        case 'overdue':
          return `(t.due_date < ${param(r.before)} AND NOT ${OLD_TASK_CLOSED_SQL})`;
        case 'none':
          return 't.due_date IS NULL';
        case 'any':
          return 't.due_date IS NOT NULL';
        case 'range': {
          const range = ['t.due_date IS NOT NULL'];
          if (r.from !== null) range.push(`t.due_date >= ${param(r.from)}`);
          if (r.to !== null) range.push(`t.due_date <= ${param(r.to)}`);
          return `(${range.join(' AND ')})`;
        }
      }
    });
    clauses.push(anyOf(parts));
  }
  if (filter.dueFrom || filter.dueTo) {
    clauses.push('t.due_date IS NOT NULL');
    if (filter.dueFrom) clauses.push(`t.due_date >= ${param(filter.dueFrom)}`);
    if (filter.dueTo) clauses.push(`t.due_date <= ${param(filter.dueTo)}`);
  }
  const archived = filter.archived ?? 'exclude';
  if (archived === 'exclude') clauses.push('t.archived_at IS NULL');
  else if (archived === 'only') clauses.push('t.archived_at IS NOT NULL');
  const days = filter.closedWithinDays;
  if (days !== undefined && days !== null) {
    if (days === 0) {
      clauses.push(`NOT ${OLD_TASK_CLOSED_SQL}`);
    } else {
      const cutoffIso = new Date(ctx.nowMs - days * 86_400_000).toISOString();
      clauses.push(`(NOT ${OLD_TASK_CLOSED_SQL} OR t.completed_at IS NULL OR t.completed_at >= ${param(cutoffIso)})`);
    }
  }
  return { sql: clauses.length > 0 ? clauses.join('\n AND ') : '1', params };
}

const OPEN_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => !isClosedCategory(c));
const CLOSED_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => isClosedCategory(c));
const BY_PRIORITY = 't.priority = 0, t.priority DESC, t.rank ASC, t.id ASC';
const OLD_ORDER = {
  overdue: `t.due_date ASC, ${BY_PRIORITY}`,
  dueToday: BY_PRIORITY,
  dueSoon: `t.due_date ASC, ${BY_PRIORITY}`,
  inProgress: 't.updated_at DESC, t.id DESC',
  recentlyClosed: 't.completed_at IS NULL, t.completed_at DESC, t.id DESC',
} as const;

function oldDashboard(db: Db, ctx: TaskWhereContext, userId: number): DashboardDTO {
  const { today, weekStartsOn } = ctx;
  const section = (filter: TaskFilter, orderBy: string, limit: number) => {
    const where = oldTaskWhere(filter, ctx);
    const rows = db.all<TaskRow>(`SELECT t.* FROM ${OLD_TASK_FROM} WHERE ${where.sql} ORDER BY ${orderBy} LIMIT :limit`, {
      ...where.params,
      limit,
    });
    const tasks = oldHydrateTasks(db, rows);
    const total =
      tasks.length < limit
        ? { tasks: tasks.length, projects: new Set(tasks.map((t) => t.projectId)).size }
        : db.get<{ tasks: number; projects: number }>(
            `SELECT COUNT(*) AS tasks, COUNT(DISTINCT t.project_id) AS projects FROM ${OLD_TASK_FROM} WHERE ${where.sql}`,
            where.params,
          )!;
    return { tasks, total };
  };
  const { list } = DASHBOARD_LIMITS;
  const overdue = section({ due: ['overdue'] }, OLD_ORDER.overdue, list);
  const dueToday = section({ due: ['today'], statusCategories: OPEN_CATEGORIES }, OLD_ORDER.dueToday, list);
  const dueSoon = section(
    { dueFrom: addDays(today, 1), dueTo: addDays(today, DASHBOARD_LIMITS.dueSoonDays), statusCategories: OPEN_CATEGORIES },
    OLD_ORDER.dueSoon,
    list,
  );
  const inProgress = section({ statusCategories: ['started'] }, OLD_ORDER.inProgress, list);
  const recentlyClosed = section(
    { statusCategories: CLOSED_CATEGORIES, closedWithinDays: DASHBOARD_LIMITS.recentlyClosedDays },
    OLD_ORDER.recentlyClosed,
    DASHBOARD_LIMITS.recentlyClosed,
  );
  const worklog = db.get<{ today_minutes: number; week_minutes: number }>(
    `SELECT COALESCE(SUM(CASE WHEN date = :today THEN minutes END), 0) AS today_minutes,
            COALESCE(SUM(minutes), 0) AS week_minutes
       FROM work_logs
      WHERE date >= :weekStart AND date <= :weekEnd AND user_id = :userId`,
    { today, weekStart: startOfWeek(today, weekStartsOn), weekEnd: endOfWeek(today, weekStartsOn), userId },
  );
  return {
    today,
    overdue: overdue.tasks,
    dueToday: dueToday.tasks,
    dueSoon: dueSoon.tasks,
    inProgress: inProgress.tasks,
    recentlyClosed: recentlyClosed.tasks,
    counts: {
      overdue: overdue.total.tasks,
      dueToday: dueToday.total.tasks,
      dueSoon: dueSoon.total.tasks,
      inProgress: inProgress.total.tasks,
      recentlyClosed: recentlyClosed.total.tasks,
    },
    inProgressProjects: inProgress.total.projects,
    slipped: 0,
    recentActivity: listActivity(db, { limit: DASHBOARD_LIMITS.recentActivity }).items,
    worklog: { todayMinutes: worklog?.today_minutes ?? 0, weekMinutes: worklog?.week_minutes ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse('2026-03-15T12:00:00.000Z');
const TODAYS = ['2026-03-15', '2026-03-08', '2026-03-22'];
/** Text JS's `<` orders differently from SQLite: a supplementary character and one of U+E000-U+FFFF. */
const ODD_TEXT = ['\u{1F680}', '', '�', 'é', 'Z', 'a', '0'];
const ESTIMATES = [null, null, 0, 1, 2.5, 3, 8, 13, 0.1, 0.2, 0.3, 1 / 3, 2.675, 0.001, 7.77, 99_999.99, 100_000];

interface Shape {
  tasks: number;
  projects: number;
  tags: number;
  /** Delete some rows afterwards (cascades, SET NULLs). */
  deletions: boolean;
  /** Every task archived. */
  allArchived?: boolean;
  /** No epics or milestones at all. */
  noEpics?: boolean;
}

function buildWorld(db: Db, seed: number, shape: Shape): void {
  const rnd = prng(seed);
  const day = (offset: number) => addDays('2026-03-15', offset);
  const stamp = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
  for (const category of STATUS_CATEGORIES) {
    if (rnd.chance(0.4)) insertStatus(db, `Extra ${category} ${seed}`, category, rnd.int(-1, 8));
  }
  const unused = insertStatus(db, `Unused ${seed}`, rnd.pick(STATUS_CATEGORIES));
  const statuses = db.all<StatusRow>('SELECT * FROM statuses WHERE id <> :unused', { unused });
  const projects = Array.from({ length: shape.projects }, (_, i) =>
    insertProject(db, `P${i}X${seed % 1000}`.slice(0, 10), { status: rnd.pick(PROJECT_STATUSES) }),
  );
  const epicsOf = new Map<number, number[]>();
  for (const projectId of projects) {
    const milestones = shape.noEpics
      ? []
      : Array.from({ length: rnd.int(0, 3) }, () => insertMilestone(db, projectId, { status: rnd.pick(MILESTONE_STATUSES) }));
    const epics = shape.noEpics
      ? []
      : Array.from({ length: rnd.int(0, 4) }, () =>
          insertEpic(db, projectId, {
            milestoneId: milestones.length > 0 && rnd.chance(0.7) ? rnd.pick(milestones) : null,
            status: rnd.pick(EPIC_STATUSES),
          }),
        );
    epicsOf.set(projectId, epics);
  }
  const tags = Array.from({ length: shape.tags }, (_, i) => insertTag(db, `tag ${i} ${rnd.pick(ODD_TEXT)}`));
  const updated = Array.from({ length: 8 }, (_, i) => stamp(i * 7 * 3_600_000));
  const text = () => Array.from({ length: rnd.int(1, 3) }, () => rnd.pick(ODD_TEXT)).join('');
  const taskIds: number[] = [];
  for (let i = 0; i < shape.tasks && projects.length > 0; i++) {
    const projectId = rnd.pick(projects);
    const status = rnd.pick(statuses);
    const closed = isClosedCategory(status.category);
    let completedAt: string | null = null;
    const r = rnd.next();
    if (closed) {
      if (r < 0.15) completedAt = null;
      else if (r < 0.4) completedAt = stamp(DASHBOARD_LIMITS.recentlyClosedDays * DAY_MS + rnd.pick([-1, 0, 1]));
      else completedAt = stamp(rnd.int(0, 20) * DAY_MS + rnd.int(0, 3_600_000));
    } else if (r < 0.05) {
      completedAt = stamp(2 * DAY_MS); // inconsistent data: an open task with a completedAt
    }
    const dueRoll = rnd.next();
    const dueDate =
      dueRoll < 0.3
        ? null
        : dueRoll < 0.33
          ? `${day(rnd.int(-3, 3))}${rnd.pick(['T10:00', ' ', '\u{1F680}', ''])}` // not a date: text order decides
          : day(rnd.int(-14, 16));
    const epics = epicsOf.get(projectId)!;
    taskIds.push(
      insertTask(db, {
        projectId,
        statusId: status.id,
        epicId: epics.length > 0 && rnd.chance(0.7) ? rnd.pick(epics) : null,
        title: `Task ${i}`,
        priority: rnd.int(0, 4) as Priority,
        dueDate,
        estimate: rnd.pick(ESTIMATES),
        completedAt,
        archivedAt: shape.allArchived || rnd.chance(0.15) ? rnd.pick(updated) : null,
        createdAt: rnd.pick(updated),
        updatedAt: rnd.pick(updated),
        tagIds: rnd.subset(tags, 0.25).slice(0, 4),
        rank: rnd.chance(0.2) ? `a${text()}` : `a${String(rnd.int(0, 40)).padStart(2, '0')}`,
      }),
    );
  }
  for (let i = 0; i < Math.floor(taskIds.length / 3); i++) {
    db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:taskId, 1, 'c', :t, :t)", {
      taskId: rnd.pick(taskIds),
      t: stamp(i * 60_000),
    });
  }
  for (let i = 0; i < Math.floor(taskIds.length / 4); i++) {
    db.run(
      `INSERT INTO work_logs (task_id, user_id, date, minutes, created_at, updated_at)
       VALUES (:taskId, :userId, :date, :minutes, :t, :t)`,
      {
        taskId: rnd.pick(taskIds),
        userId: rnd.chance(0.8) ? 1 : null,
        date: day(rnd.int(-9, 9)),
        minutes: rnd.chance(0.9) ? rnd.int(1, 600) : null,
        t: stamp(i * 60_000),
      },
    );
  }
  if (shape.deletions) {
    const one = (sql: string) => db.get<{ id: number }>(sql)?.id;
    const tag = one('SELECT id FROM tags ORDER BY id LIMIT 1');
    if (tag !== undefined) db.run('DELETE FROM tags WHERE id = :id', { id: tag });
    const epic = one('SELECT id FROM epics ORDER BY id DESC LIMIT 1');
    if (epic !== undefined) db.run('DELETE FROM epics WHERE id = :id', { id: epic });
    const milestone = one('SELECT id FROM milestones ORDER BY id LIMIT 1');
    if (milestone !== undefined) db.run('DELETE FROM milestones WHERE id = :id', { id: milestone });
    for (const id of rnd.subset(taskIds, 0.05)) db.run('DELETE FROM tasks WHERE id = :id', { id });
    const project = one('SELECT id FROM projects ORDER BY id DESC LIMIT 1');
    if (project !== undefined && projects.length > 2) db.run('DELETE FROM projects WHERE id = :id', { id: project });
    db.run('DELETE FROM statuses WHERE id = :unused', { unused });
    db.run('DELETE FROM task_tags WHERE task_id IN (SELECT task_id FROM task_tags ORDER BY task_id LIMIT 3)');
  }
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const entries = <V>(map: Map<number, V>): Array<[number, V]> => [...map].sort((a, b) => a[0] - b[0]);
const ids = (db: Db, table: string): number[] => db.all<{ id: number }>(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);

/** A few id lists to scope a statistic with: random subsets, an unknown id, a duplicate, the empty list. */
function scopes(rnd: ReturnType<typeof prng>, all: number[]): number[][] {
  const some = rnd.subset(all, 0.4);
  return [some, [...rnd.subset(all, 0.2), 99_999], all.slice(0, 1).concat(all.slice(0, 1)), []];
}

/** Every statistic, list, getter, dashboard and hydration of `db`, new against old. Returns how many it compared. */
function compareAll(db: Db, userId: number, seed: number): number {
  const rnd = prng(seed ^ 0x5eed);
  let compared = 0;
  const same = <T>(what: string, actual: T, expected: T) => {
    expect({ what, value: actual }).toEqual({ what, value: expected });
    compared++;
  };
  const projects = ids(db, 'projects');
  const milestones = ids(db, 'milestones');
  const epics = ids(db, 'epics');
  const statuses = ids(db, 'statuses');
  const tags = ids(db, 'tags');

  for (const today of TODAYS) {
    const all = spaceStats(db, today);
    same(`spaceStats.projects ${today}`, entries(all.projects), entries(oldProjectStats(db, today)));
    same(`projectStats ${today}`, entries(projectStats(db, today)), entries(oldProjectStats(db, today)));
    for (const scope of scopes(rnd, projects)) {
      same(`projectStats ${today} ${scope}`, entries(projectStats(db, today, scope)), entries(oldProjectStats(db, today, scope)));
    }
    same(`listProjects ${today}`, listProjects(db, today, all.projects), oldListProjects(db, today));
    for (const id of projects) same(`getProject ${id} ${today}`, getProject(db, id, today), oldGetProject(db, id, today));
  }
  const all = spaceStats(db, TODAYS[0]!);
  same('spaceStats.milestones', entries(all.milestones), entries(oldMilestoneStats(db)));
  same('spaceStats.epics', entries(all.epics), entries(oldEpicStats(db)));
  same('spaceStats.statuses', entries(all.statuses), entries(oldStatusTaskCounts(db)));
  same('spaceStats.tags', entries(all.tags), entries(oldTagTaskCounts(db)));
  same('milestoneStats', entries(milestoneStats(db)), entries(oldMilestoneStats(db)));
  same('epicStats', entries(epicStats(db)), entries(oldEpicStats(db)));
  same('statusTaskCounts', entries(statusTaskCounts(db)), entries(oldStatusTaskCounts(db)));
  same('tagTaskCounts', entries(tagTaskCounts(db)), entries(oldTagTaskCounts(db)));
  for (const scope of scopes(rnd, milestones)) {
    same(`milestoneStats ${scope}`, entries(milestoneStats(db, scope)), entries(oldMilestoneStats(db, scope)));
  }
  for (const scope of scopes(rnd, epics)) same(`epicStats ${scope}`, entries(epicStats(db, scope)), entries(oldEpicStats(db, scope)));
  for (const scope of scopes(rnd, statuses)) {
    same(`statusTaskCounts ${scope}`, entries(statusTaskCounts(db, scope)), entries(oldStatusTaskCounts(db, scope)));
  }
  for (const scope of scopes(rnd, tags)) same(`tagTaskCounts ${scope}`, entries(tagTaskCounts(db, scope)), entries(oldTagTaskCounts(db, scope)));

  // The bootstrap lists (spaceStats) and the routes' own (each its own scan).
  same('listMilestones', listMilestones(db, undefined, all.milestones), oldListMilestones(db));
  same('listMilestones (own)', listMilestones(db), oldListMilestones(db));
  same('listEpics', listEpics(db, undefined, all.epics), oldListEpics(db));
  same('listEpics (own)', listEpics(db), oldListEpics(db));
  same('listStatuses', listStatuses(db, all.statuses), oldListStatuses(db));
  same('listStatuses (own)', listStatuses(db), oldListStatuses(db));
  same('listTags', listTags(db, all.tags), oldListTags(db));
  same('listTags (own)', listTags(db), oldListTags(db));
  for (const id of projects) {
    same(`listMilestones ${id}`, listMilestones(db, id), oldListMilestones(db, id));
    same(`listEpics ${id}`, listEpics(db, id), oldListEpics(db, id));
  }
  for (const id of milestones) same(`getMilestone ${id}`, getMilestone(db, id), oldGetMilestone(db, id));
  for (const id of epics) same(`getEpic ${id}`, getEpic(db, id), oldGetEpic(db, id));
  for (const id of statuses) same(`getStatus ${id}`, getStatus(db, id), oldGetStatus(db, id));
  for (const id of tags) same(`getTag ${id}`, getTag(db, id), oldGetTag(db, id));

  // The dashboard, for several days, week starts and clocks (cut-offs to the millisecond).
  for (const today of TODAYS) {
    for (const weekStartsOn of [0, 1] as WeekStart[]) {
      for (const nowMs of [NOW_MS, NOW_MS + 1, NOW_MS - 3 * DAY_MS]) {
        const ctx = { today, weekStartsOn, nowMs };
        same(`dashboard ${JSON.stringify(ctx)}`, buildDashboard(db, ctx, userId), oldDashboard(db, ctx, userId));
      }
    }
  }

  // Hydration: the counts the rows keep (migration 3) against counts of the comments and work logs, and the
  // lookups by id against the old IN lists.
  const plain = db.all<TaskRow>('SELECT * FROM tasks ORDER BY id');
  const listed = db.all<TaskRow>(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} ORDER BY t.id`);
  const expected = oldHydrateTasks(db, plain);
  same('hydrateTasks (TASK_COLUMNS)', hydrateTasks(db, listed), expected);
  same('hydrateTasks (SELECT *)', hydrateTasks(db, plain), expected);
  // getTaskDTOs: in the order asked, an unknown id skipped, a repeated one once.
  const asked = [...plain.filter((_, i) => i % 3 === 0).map((r) => r.id).reverse(), 0, ...plain.slice(0, 1).map((r) => r.id)];
  const byId = new Map(plain.map((r) => [r.id, r]));
  same('getTaskDTOs', getTaskDTOs(db, asked), oldHydrateTasks(db, [...new Set(asked)].flatMap((id) => byId.get(id) ?? [])));
  return compared;
}

// The old lists and getters: the P2 entities.ts functions on the old statistics.

function oldListProjects(db: Db, today: string) {
  const stats = oldProjectStats(db, today);
  return db.all<ProjectRow>('SELECT * FROM projects ORDER BY position, id').map((r) => toProjectDTO(r, stats.get(r.id) ?? emptyProjectStats()));
}

function oldGetProject(db: Db, id: number, today: string) {
  const row = db.get<ProjectRow>('SELECT * FROM projects WHERE id = :id', { id })!;
  return toProjectDTO(row, oldProjectStats(db, today, [id]).get(id) ?? emptyProjectStats());
}

function oldListMilestones(db: Db, projectId?: number) {
  const rows =
    projectId === undefined
      ? db.all<MilestoneRow>('SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id ORDER BY p.position, p.id, m.position, m.id')
      : db.all<MilestoneRow>('SELECT * FROM milestones WHERE project_id = :projectId ORDER BY position, id', { projectId });
  const stats = oldMilestoneStats(db, projectId === undefined ? undefined : rows.map((r) => r.id));
  return rows.map((r) => toMilestoneDTO(r, stats.get(r.id) ?? emptyMilestoneStats()));
}

function oldGetMilestone(db: Db, id: number) {
  const row = db.get<MilestoneRow>('SELECT * FROM milestones WHERE id = :id', { id })!;
  return toMilestoneDTO(row, oldMilestoneStats(db, [id]).get(id) ?? emptyMilestoneStats());
}

function oldListEpics(db: Db, projectId?: number) {
  const rows =
    projectId === undefined
      ? db.all<EpicRow>('SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id ORDER BY p.position, p.id, e.position, e.id')
      : db.all<EpicRow>('SELECT * FROM epics WHERE project_id = :projectId ORDER BY position, id', { projectId });
  const stats = oldEpicStats(db, projectId === undefined ? undefined : rows.map((r) => r.id));
  return rows.map((r) => toEpicDTO(r, stats.get(r.id) ?? emptyProgressStats()));
}

function oldGetEpic(db: Db, id: number) {
  const row = db.get<EpicRow>('SELECT * FROM epics WHERE id = :id', { id })!;
  return toEpicDTO(row, oldEpicStats(db, [id]).get(id) ?? emptyProgressStats());
}

function oldListStatuses(db: Db) {
  const counts = oldStatusTaskCounts(db);
  return db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id').map((r) => toStatusDTO(r, counts.get(r.id) ?? 0));
}

function oldGetStatus(db: Db, id: number) {
  const row = db.get<StatusRow>('SELECT * FROM statuses WHERE id = :id', { id })!;
  return toStatusDTO(row, oldStatusTaskCounts(db, [id]).get(id) ?? 0);
}

function oldListTags(db: Db) {
  const counts = oldTagTaskCounts(db);
  return db
    .all<TagRow>('SELECT * FROM tags')
    .sort(compareTagNames)
    .map((r) => toTagDTO(r, counts.get(r.id) ?? 0));
}

function oldGetTag(db: Db, id: number) {
  const row = db.get<TagRow>('SELECT * FROM tags WHERE id = :id', { id })!;
  return toTagDTO(row, oldTagTaskCounts(db, [id]).get(id) ?? 0);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/** The random seeds: worlds of 0 to 300 tasks. */
export const EQUIVALENCE_SEEDS = Array.from({ length: 40 }, (_, i) => 20261018 + i * 7919);

export function defineStatsEquivalence(kind: string, withSpaceDb: WithSpaceDb): void {
  describe(`single-scan statistics and dashboard ≡ the P2 queries (${kind})`, () => {
    it.each(EQUIVALENCE_SEEDS.map((seed, i) => [seed, i]))('random space, seed %i', (seed, i) =>
      withSpaceDb(({ db, userId }) => {
        const rnd = prng(seed);
        buildWorld(db, seed, {
          tasks: [0, 1, 5, 30, 120, 300][i % 6]!,
          projects: rnd.int(1, 6),
          tags: rnd.int(0, 8),
          deletions: i % 2 === 1,
        });
        expect(compareAll(db, userId, seed)).toBeGreaterThan(40);
      }),
    );

    it('an empty space (only the defaults)', () =>
      withSpaceDb(({ db, userId }) => {
        expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBe(0);
        compareAll(db, userId, 1);
        expect(buildDashboard(db, { today: TODAYS[0]!, weekStartsOn: 1, nowMs: NOW_MS }, userId).counts).toEqual({
          overdue: 0,
          dueToday: 0,
          dueSoon: 0,
          inProgress: 0,
          recentlyClosed: 0,
        });
      }));

    it('projects without tasks, epics or milestones, and statuses without tasks', () =>
      withSpaceDb(({ db, userId }) => {
        buildWorld(db, 2, { tasks: 0, projects: 4, tags: 3, deletions: false, noEpics: true });
        compareAll(db, userId, 2);
      }));

    it('tasks without epics or milestones, in every status category', () =>
      withSpaceDb(({ db, userId }) => {
        buildWorld(db, 3, { tasks: 200, projects: 3, tags: 4, deletions: false, noEpics: true });
        const categories = db.all<{ category: string }>(
          'SELECT DISTINCT s.category FROM tasks t JOIN statuses s ON s.id = t.status_id ORDER BY s.category',
        );
        expect(categories.map((c) => c.category)).toEqual([...STATUS_CATEGORIES].sort());
        compareAll(db, userId, 3);
      }));

    it('every task archived', () =>
      withSpaceDb(({ db, userId }) => {
        buildWorld(db, 4, { tasks: 150, projects: 3, tags: 5, deletions: true, allArchived: true });
        compareAll(db, userId, 4);
        expect(listTags(db).every((t) => t.taskCount === 0)).toBe(true);
      }));

    it('a space of more than 2,000 tasks', { timeout: 120_000 }, () =>
      withSpaceDb(({ db, userId }) => {
        buildWorld(db, 5, { tasks: 3_000, projects: 6, tags: 12, deletions: true });
        expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n).toBeGreaterThan(2_000);
        compareAll(db, userId, 5);
      }));
  });
}
