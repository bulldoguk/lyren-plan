// Pure helpers for the dashboard (unit-tested).

import { isClosedCategory, STATUS_CATEGORIES, type StatusCategory } from '@shared/constants';
import { addDays } from '@shared/dates';
import { effectiveDueDate } from '@shared/filter';
import type { TaskFilter, TaskQueryInput, TaskSort } from '@shared/schemas';
import type { DashboardDTO, MilestoneDTO, ProjectDTO, TaskDTO } from '@shared/types';

/** "Good morning" (5–11), "Good afternoon" (12–17), else "Good evening". */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Active projects in sidebar order. */
export function dashboardProjects(projects: readonly ProjectDTO[]): ProjectDTO[] {
  return projects.filter((p) => p.status === 'active');
}

/**
 * The milestone to watch: open (planned/active) with a due date, earliest due first (overdue
 * ones included), ties by position. Null when none qualifies.
 */
export function nextMilestone(milestones: readonly MilestoneDTO[] | undefined): MilestoneDTO | null {
  let best: MilestoneDTO | null = null;
  for (const m of milestones ?? []) {
    if (m.dueDate === null || (m.status !== 'planned' && m.status !== 'active')) continue;
    if (!best || m.dueDate < best.dueDate! || (m.dueDate === best.dueDate && m.position < best.position)) best = m;
  }
  return best;
}

/**
 * "3 due tomorrow" under the Due today tile, from the (capped) dueSoon list, which is sorted by
 * due date: when every listed task is due tomorrow and the list is truncated, more may be.
 */
export function dueTomorrowHint(dueSoon: readonly Pick<TaskDTO, 'dueDate'>[], dueSoonTotal: number, tomorrow: string): string {
  const n = dueSoon.filter((t) => t.dueDate === tomorrow).length;
  if (n === 0) return 'Nothing due tomorrow';
  return n === dueSoon.length && dueSoonTotal > n ? `${n}+ due tomorrow` : `${n} due tomorrow`;
}

// ---- Full section lists ------------------------------------------------------------------------
//
// GET /api/dashboard caps its task lists (DashboardDTO; `counts` holds the totals). A truncated
// section loads the rest from POST /api/tasks/query with the section's own filter, a page at a
// time, and shows it in the dashboard's order.

/** The sections of DashboardDTO['counts'], and the slipped tasks (DashboardDTO.slipped; listed by the client). */
export type DashboardSection = keyof DashboardDTO['counts'] | 'slipped';

/** Windows of the dashboard lists (server/src/routes/dashboard.ts DASHBOARD_LIMITS). */
export const DASHBOARD_WINDOWS = { dueSoonDays: 7, recentlyClosedDays: 7 } as const;

const OPEN_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => !isClosedCategory(c));
const CLOSED_CATEGORIES: StatusCategory[] = STATUS_CATEGORIES.filter((c) => isClosedCategory(c));

/** The filter of each section: the same as the server's dashboardFilters(today). */
export function dashboardSectionFilter(section: DashboardSection, today: string): TaskFilter {
  switch (section) {
    case 'overdue':
      return { due: ['overdue'] };
    case 'dueToday':
      return { due: ['today'], statusCategories: OPEN_CATEGORIES };
    case 'dueSoon':
      return { dueFrom: addDays(today, 1), dueTo: addDays(today, DASHBOARD_WINDOWS.dueSoonDays), statusCategories: OPEN_CATEGORIES };
    case 'inProgress':
      return { statusCategories: ['started'] };
    case 'recentlyClosed':
      return { statusCategories: CLOSED_CATEGORIES, closedWithinDays: DASHBOARD_WINDOWS.recentlyClosedDays };
    case 'slipped':
      return { slipped: true, statusCategories: OPEN_CATEGORIES };
  }
}

/**
 * Server sort of a section query. useFullSection loads a whole section and sorts it with
 * compareDashboardTasks, so this only decides which tasks come back when a section exceeds
 * LIMITS.queryLimitMax: its leading key follows the dashboard's order where the server has one.
 * It is not an exact prefix of that order (recently closed sorts by updatedAt, which a later
 * edit bumps; due-date ties are broken by rank, not priority), so never page with it.
 */
const SECTION_SORT: Record<DashboardSection, TaskSort> = {
  overdue: { field: 'dueDate', dir: 'asc' },
  dueToday: { field: 'priority', dir: 'desc' },
  dueSoon: { field: 'dueDate', dir: 'asc' },
  inProgress: { field: 'updatedAt', dir: 'desc' },
  recentlyClosed: { field: 'updatedAt', dir: 'desc' },
  slipped: { field: 'dueDate', dir: 'asc' },
};

/** POST /api/tasks/query input for the first `limit` tasks of a section. */
export function dashboardSectionQuery(section: DashboardSection, today: string, limit: number): TaskQueryInput {
  return { filter: dashboardSectionFilter(section, today), sort: SECTION_SORT[section], limit, today };
}

type Compare = (a: TaskDTO, b: TaskDTO) => number;
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Urgent first: priority 4 → 1, "no priority" (0) last. */
const byPriority: Compare = (a, b) => (a.priority === 0 ? 5 : -a.priority) - (b.priority === 0 ? 5 : -b.priority);
const byRankThenId: Compare = (a, b) => asc(a.rank, b.rank) || a.id - b.id;
/** By the due date lists go by: a slipped task's adjusted one (effectiveDueDate). */
const byDue: Compare = (a, b) => asc(effectiveDueDate(a) ?? '', effectiveDueDate(b) ?? '');

/**
 * The order of each dashboard list (server ORDER in routes/dashboard.ts): by due date, then
 * the most urgent priority, then manual order; in progress by latest update; recently closed by
 * latest completion (none last).
 */
export function compareDashboardTasks(section: DashboardSection): Compare {
  switch (section) {
    case 'overdue':
    case 'dueSoon':
    case 'slipped':
      return (a, b) => byDue(a, b) || byPriority(a, b) || byRankThenId(a, b);
    case 'dueToday':
      return (a, b) => byPriority(a, b) || byRankThenId(a, b);
    case 'inProgress':
      return (a, b) => asc(b.updatedAt, a.updatedAt) || b.id - a.id;
    case 'recentlyClosed':
      return (a, b) =>
        Number(a.completedAt === null) - Number(b.completedAt === null) || asc(b.completedAt ?? '', a.completedAt ?? '') || b.id - a.id;
  }
}
