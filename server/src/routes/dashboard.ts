// GET /api/dashboard?today=&weekStartsOn= — the home page in one request: open tasks by due date, work
// in progress, recently closed tasks, the latest activity and the time the viewer logged today / this
// week (weekStartsOn is the viewer's preference, default 1 = Monday).
// The task lists are capped (DASHBOARD_LIMITS); `counts` carries each section's uncapped total
// and `inProgressProjects` the number of projects with started work, so tiles never guess.
//
// Every task list uses the shared filter semantics (buildTaskWhere): archived tasks and tasks of
// archived projects are left out; "open" means the status category is not completed/cancelled.
// The sections come from ONE scan of the tasks (design §2.4.1 item 7; a Durable Object bills every row a
// statement reads, and a query per section read every task again): each section's filter is evaluated
// in JS exactly as buildTaskWhere's SQL would (SQLite's text order, its NULLs), its order is the SQL
// ORDER BY's, and only the tasks listed are read in full (server/test/contract/stats.contract.ts keeps
// the SQL as its oracle).

import { Hono } from 'hono';
import { isClosedCategory, STATUS_CATEGORIES, type ProjectStatus, type StatusCategory } from '@shared/constants';
import { addDays, endOfWeek, resolveDuePreset, startOfWeek, type WeekStart } from '@shared/dates';
import { dashboardQueryInput, type TaskFilter } from '@shared/schemas';
import type { DashboardDTO, TaskDTO } from '@shared/types';
import type { Db } from '../db';
import type { AppEnv, Deps } from '../env';
import { readQuery } from '../http/validate';
import { listActivity } from '../services/activity';
import type { TaskRow } from '../services/rows';
import { compareText, serverToday } from '../services/sql';
import { readSchedule, slips } from '../services/schedule';
import { getTaskDTOs, type TaskWhereContext } from '../services/tasks';
import { currentUser } from '../space/context';

/** Caps and windows of the dashboard lists (DashboardDTO documents them). */
export const DASHBOARD_LIMITS = {
  /** overdue / dueToday / dueSoon / inProgress */
  list: 50,
  recentlyClosed: 20,
  recentActivity: 15,
  /** dueSoon covers today+1 … today+N. */
  dueSoonDays: 7,
  /** recentlyClosed covers completedAt >= now − N days. */
  recentlyClosedDays: 7,
} as const;

const OPEN_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => !isClosedCategory(c));
const CLOSED_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => isClosedCategory(c));

/** The columns the dashboard reads of every task. */
type DashboardTask = Pick<
  TaskRow,
  'id' | 'project_id' | 'status_id' | 'due_date' | 'priority' | 'rank' | 'completed_at' | 'updated_at' | 'archived_at'
>;

const DASHBOARD_COLUMNS = 'id, project_id, status_id, due_date, priority, rank, completed_at, updated_at, archived_at';

type Order = (a: DashboardTask, b: DashboardTask) => number;

/** SQL's order of two nullable TEXT values (NULL first, as ASC puts it). */
const compareNullableText = (a: string | null, b: string | null): number =>
  a === null || b === null ? (a === null ? 0 : 1) - (b === null ? 0 : 1) : compareText(a, b);

// The ORDER BY of each section, as comparators over the scanned columns. Within one due date the most
// urgent task comes first (priority 4 → 1, "no priority" last), then the manual order:
// t.priority = 0, t.priority DESC, t.rank ASC, t.id ASC.
const byPriority: Order = (a, b) =>
  Number(a.priority === 0) - Number(b.priority === 0) || b.priority - a.priority || compareText(a.rank, b.rank) || a.id - b.id;
const ORDER = {
  /** t.due_date ASC (a slipped task's adjusted one, which its scanned row carries), then by priority */
  overdue: (a, b) => compareNullableText(a.due_date, b.due_date) || byPriority(a, b),
  dueToday: byPriority,
  dueSoon: (a, b) => compareNullableText(a.due_date, b.due_date) || byPriority(a, b),
  /** t.updated_at DESC, t.id DESC */
  inProgress: (a, b) => compareText(b.updated_at, a.updated_at) || b.id - a.id,
  /**
   * A closed task without completedAt counts as recent (filter semantics) but sorts last:
   * t.completed_at IS NULL, t.completed_at DESC, t.id DESC
   */
  recentlyClosed: (a, b) =>
    Number(a.completed_at === null) - Number(b.completed_at === null) ||
    compareNullableText(b.completed_at, a.completed_at) ||
    b.id - a.id,
} satisfies Record<keyof DashboardDTO['counts'], Order>;

/** What a section's filter needs to know about the space: its statuses and projects (small tables). */
interface DashboardScope extends TaskWhereContext {
  categoryOf: ReadonlyMap<number, StatusCategory>;
  projectStatusOf: ReadonlyMap<number, ProjectStatus>;
}

/** The TaskFilter keys the dashboard's sections use; matchesSection refuses any other. */
const SECTION_FILTER_KEYS = new Set<keyof TaskFilter>(['statusCategories', 'due', 'dueFrom', 'dueTo', 'closedWithinDays']);

/**
 * buildTaskWhere's condition for one section's filter (of SECTION_FILTER_KEYS), in JS. A task whose project or
 * status is missing (a broken foreign key) matches nothing, as when the SQL joined them.
 */
function matchesSection(task: DashboardTask, filter: TaskFilter, scope: DashboardScope): boolean {
  const category = scope.categoryOf.get(task.status_id);
  const projectStatus = scope.projectStatusOf.get(task.project_id);
  if (category === undefined || projectStatus === undefined) return false;
  const open = !isClosedCategory(category);
  const due = task.due_date;
  // Not of an archived project, not archived (the filter's defaults).
  if (projectStatus === 'archived' || task.archived_at !== null) return false;
  if (filter.statusCategories?.length && !filter.statusCategories.includes(category)) return false;
  if (filter.due?.length) {
    const hit = filter.due.some((preset) => {
      const r = resolveDuePreset(preset, scope.today, scope.weekStartsOn);
      switch (r.kind) {
        case 'overdue':
          return due !== null && compareText(due, r.before) < 0 && open;
        case 'none':
          return due === null;
        case 'any':
          return due !== null;
        case 'range':
          return (
            due !== null && (r.from === null || compareText(due, r.from) >= 0) && (r.to === null || compareText(due, r.to) <= 0)
          );
      }
    });
    if (!hit) return false;
  }
  if (filter.dueFrom || filter.dueTo) {
    if (due === null) return false;
    if (filter.dueFrom && compareText(due, filter.dueFrom) < 0) return false;
    if (filter.dueTo && compareText(due, filter.dueTo) > 0) return false;
  }
  const days = filter.closedWithinDays;
  if (days !== undefined && days !== null) {
    if (days === 0) return open;
    const cutoffIso = new Date(scope.nowMs - days * 86_400_000).toISOString();
    if (!(open || task.completed_at === null || compareText(task.completed_at, cutoffIso) >= 0)) return false;
  }
  return true;
}

/** One dashboard section: the ids of its capped list, in order, and its uncapped totals. */
function section(tasks: readonly DashboardTask[], filter: TaskFilter, scope: DashboardScope, order: Order, limit: number) {
  for (const key of Object.keys(filter) as Array<keyof TaskFilter>) {
    if (!SECTION_FILTER_KEYS.has(key)) throw new Error(`The dashboard does not evaluate the filter key ${key}`);
  }
  const matching = tasks.filter((t) => matchesSection(t, filter, scope)).sort(order);
  return {
    ids: matching.slice(0, limit).map((t) => t.id),
    total: { tasks: matching.length, projects: new Set(matching.map((t) => t.project_id)).size },
  };
}

/** Minutes `userId` logged on `today` and in the calendar week containing it. */
function worklogTotals(db: Db, today: string, weekStartsOn: WeekStart, userId: number): DashboardDTO['worklog'] {
  const row = db.get<{ today_minutes: number; week_minutes: number }>(
    `SELECT COALESCE(SUM(CASE WHEN date = :today THEN minutes END), 0) AS today_minutes,
            COALESCE(SUM(minutes), 0) AS week_minutes
       FROM work_logs
      WHERE date >= :weekStart AND date <= :weekEnd AND user_id = :userId`,
    { today, weekStart: startOfWeek(today, weekStartsOn), weekEnd: endOfWeek(today, weekStartsOn), userId },
  );
  return { todayMinutes: row?.today_minutes ?? 0, weekMinutes: row?.week_minutes ?? 0 };
}

/** The filter behind each dashboard section (POST /api/tasks/query accepts the same filters). */
function dashboardFilters(today: string): Record<keyof DashboardDTO['counts'], TaskFilter> {
  return {
    overdue: { due: ['overdue'] },
    dueToday: { due: ['today'], statusCategories: OPEN_CATEGORIES },
    dueSoon: {
      dueFrom: addDays(today, 1),
      dueTo: addDays(today, DASHBOARD_LIMITS.dueSoonDays),
      statusCategories: OPEN_CATEGORIES,
    },
    inProgress: { statusCategories: ['started'] },
    recentlyClosed: { statusCategories: CLOSED_CATEGORIES, closedWithinDays: DASHBOARD_LIMITS.recentlyClosedDays },
  };
}

/** The dashboard of `userId` (exported for the equivalence test, server/test/contract/stats.contract.ts). */
export function buildDashboard(db: Db, ctx: TaskWhereContext, userId: number): DashboardDTO {
  const { today, weekStartsOn } = ctx;
  const { list } = DASHBOARD_LIMITS;
  const filters = dashboardFilters(today);
  const schedule = readSchedule(db, today);
  const slipped = slips(schedule);
  const scope: DashboardScope = {
    ...ctx,
    slips: slipped,
    categoryOf: new Map(
      db.all<{ id: number; category: StatusCategory }>('SELECT id, category FROM statuses').map((s) => [s.id, s.category]),
    ),
    projectStatusOf: new Map(
      db.all<{ id: number; status: ProjectStatus }>('SELECT id, status FROM projects').map((p) => [p.id, p.status]),
    ),
  };
  // A slipped task goes by its adjusted due date (effectiveDueDate, buildTaskWhere's dueDateSql): its scanned
  // row carries that as due_date, so the sections' filters and orders read it.
  const tasks = db
    .all<DashboardTask>(`SELECT ${DASHBOARD_COLUMNS} FROM tasks`)
    .map((t) => (slipped.has(t.id) ? { ...t, due_date: slipped.get(t.id)! } : t));
  const slippedOpen = tasks.filter((t) => slipped.has(t.id) && matchesSection(t, { statusCategories: OPEN_CATEGORIES }, scope)).length;
  const overdue = section(tasks, filters.overdue, scope, ORDER.overdue, list);
  const dueToday = section(tasks, filters.dueToday, scope, ORDER.dueToday, list);
  const dueSoon = section(tasks, filters.dueSoon, scope, ORDER.dueSoon, list);
  const inProgress = section(tasks, filters.inProgress, scope, ORDER.inProgress, list);
  const recentlyClosed = section(tasks, filters.recentlyClosed, scope, ORDER.recentlyClosed, DASHBOARD_LIMITS.recentlyClosed);
  // Only the listed tasks are read in full, together.
  const sections = [overdue, dueToday, dueSoon, inProgress, recentlyClosed];
  const dtos = new Map(getTaskDTOs(db, sections.flatMap((s) => s.ids), schedule).map((t) => [t.id, t]));
  const listed = (s: { ids: number[] }): TaskDTO[] => s.ids.map((id) => dtos.get(id)!);
  return {
    today,
    overdue: listed(overdue),
    dueToday: listed(dueToday),
    dueSoon: listed(dueSoon),
    inProgress: listed(inProgress),
    recentlyClosed: listed(recentlyClosed),
    counts: {
      overdue: overdue.total.tasks,
      dueToday: dueToday.total.tasks,
      dueSoon: dueSoon.total.tasks,
      inProgress: inProgress.total.tasks,
      recentlyClosed: recentlyClosed.total.tasks,
    },
    inProgressProjects: inProgress.total.projects,
    slipped: slippedOpen,
    recentActivity: listActivity(db, { limit: DASHBOARD_LIMITS.recentActivity }).items,
    worklog: worklogTotals(db, today, weekStartsOn, userId),
  };
}

export function dashboardRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.get('/', (c) => {
    const { today = serverToday(), weekStartsOn = 1 } = readQuery(c, dashboardQueryInput);
    return c.json(buildDashboard(db, { today, weekStartsOn, nowMs: Date.now() }, currentUser(c).id));
  });

  return r;
}
