// Reference (in-memory) implementation of TaskFilter matching and task sorting.
//
// The server implements the same semantics in SQL (buildTaskWhere in server/src/services/tasks.ts)
// and has tests that cross-check against these functions. The web client uses
// them for custom board columns, optimistic updates and local filtering.

import { isClosedCategory, type ProjectStatus, type StatusCategory } from './constants';
import { resolveDuePreset, type ISODate, type WeekStart } from './dates';
import type { TaskFilter, TaskSort } from './schemas';
import type { TaskDTO } from './types';

export interface FilterContext {
  statusCategoryById: ReadonlyMap<number, StatusCategory>;
  projectStatusById: ReadonlyMap<number, ProjectStatus>;
  today: ISODate;
  weekStartsOn: WeekStart;
  /** Epoch ms used for closedWithinDays; defaults to Date.now(). */
  nowMs?: number;
}

export function isTaskClosed(task: Pick<TaskDTO, 'statusId'>, ctx: Pick<FilterContext, 'statusCategoryById'>): boolean {
  const cat = ctx.statusCategoryById.get(task.statusId);
  return cat ? isClosedCategory(cat) : false;
}

/** Whitespace-separated, lower-cased search tokens. */
export function searchTokens(search: string | undefined): string[] {
  if (!search) return [];
  return search.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The due date filters and sorting go by: the adjusted due date of a slipped task (its blockers push it later;
 * ./schedule.ts), else the task's own. The SQL twin replaces t.due_date for the slipped tasks only.
 */
export function effectiveDueDate(task: Pick<TaskDTO, 'dueDate' | 'adjustedDueDate' | 'slipDays'>): ISODate | null {
  return task.slipDays > 0 ? task.adjustedDueDate : task.dueDate;
}

function nonEmpty<T>(arr: readonly T[] | undefined): arr is readonly T[] {
  return Array.isArray(arr) && arr.length > 0;
}

function matchesNullableIds(value: number | null, ids: readonly (number | null)[]): boolean {
  return ids.includes(value);
}

export function matchesTaskFilter(task: TaskDTO, filter: TaskFilter, ctx: FilterContext): boolean {
  if (nonEmpty(filter.ids) && !filter.ids.includes(task.id)) return false;

  // Projects
  if (nonEmpty(filter.projectIds)) {
    if (!filter.projectIds.includes(task.projectId)) return false;
  } else if (!filter.includeArchivedProjects) {
    if (ctx.projectStatusById.get(task.projectId) === 'archived') return false;
  }

  if (nonEmpty(filter.milestoneIds) && !matchesNullableIds(task.milestoneId, filter.milestoneIds)) return false;
  if (nonEmpty(filter.epicIds) && !matchesNullableIds(task.epicId, filter.epicIds)) return false;
  if (nonEmpty(filter.statusIds) && !filter.statusIds.includes(task.statusId)) return false;

  const category = ctx.statusCategoryById.get(task.statusId);
  if (nonEmpty(filter.statusCategories)) {
    if (!category || !filter.statusCategories.includes(category)) return false;
  }
  const closed = category ? isClosedCategory(category) : false;

  if (nonEmpty(filter.priorities) && !filter.priorities.includes(task.priority)) return false;

  // Tags
  const taskTagIds = task.tags.map((t) => t.id);
  if (nonEmpty(filter.tagIds)) {
    const wanted = filter.tagIds.filter((id): id is number => id !== null);
    const wantsUntagged = filter.tagIds.includes(null);
    if ((filter.tagMode ?? 'any') === 'all') {
      if (wanted.length > 0) {
        if (!wanted.every((id) => taskTagIds.includes(id))) return false;
      } else if (wantsUntagged && taskTagIds.length > 0) {
        return false;
      }
    } else {
      const anyTag = wanted.some((id) => taskTagIds.includes(id));
      const untaggedOk = wantsUntagged && taskTagIds.length === 0;
      if (!anyTag && !untaggedOk) return false;
    }
  }
  if (nonEmpty(filter.excludeTagIds) && filter.excludeTagIds.some((id) => taskTagIds.includes(id))) return false;

  // Due presets (ORed), on the adjusted due date of a slipped task
  const dueDate = effectiveDueDate(task);
  if (nonEmpty(filter.due)) {
    const ok = filter.due.some((preset) => {
      const r = resolveDuePreset(preset, ctx.today, ctx.weekStartsOn);
      switch (r.kind) {
        case 'overdue':
          return dueDate !== null && dueDate < r.before && !closed;
        case 'none':
          return dueDate === null;
        case 'any':
          return dueDate !== null;
        case 'range':
          return (
            dueDate !== null &&
            (r.from === null || dueDate >= r.from) &&
            (r.to === null || dueDate <= r.to)
          );
      }
    });
    if (!ok) return false;
  }
  if (filter.dueFrom || filter.dueTo) {
    if (dueDate === null) return false;
    if (filter.dueFrom && dueDate < filter.dueFrom) return false;
    if (filter.dueTo && dueDate > filter.dueTo) return false;
  }

  if (filter.slipped && !(task.slipDays > 0)) return false;

  // Search: every token must appear in title, description or ref (case-insensitive).
  const tokens = searchTokens(filter.search);
  if (tokens.length > 0) {
    const hay = `${task.title}\n${task.description}\n${task.ref}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) return false;
  }

  // Archived
  const archived = filter.archived ?? 'exclude';
  if (archived === 'exclude' && task.archivedAt !== null) return false;
  if (archived === 'only' && task.archivedAt === null) return false;

  // Recently-closed window: 0 hides every closed task; otherwise a closed task is kept when
  // completedAt >= now - N days. A closed task without completedAt counts as recent.
  // SQL: NOT closed OR (:n > 0 AND (completed_at IS NULL OR completed_at >= :cutoffIso))
  if (filter.closedWithinDays !== undefined && filter.closedWithinDays !== null && closed) {
    if (filter.closedWithinDays === 0) return false;
    if (task.completedAt) {
      const cutoff = (ctx.nowMs ?? Date.now()) - filter.closedWithinDays * 86_400_000;
      if (task.completedAt < new Date(cutoff).toISOString()) return false;
    }
  }

  return true;
}

export interface SortContext {
  /** Status position by id (for sorting by status). */
  statusPositionById: ReadonlyMap<number, number>;
}

function cmpNullsLast<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

const cmpPrimitive = <T extends string | number>(x: T, y: T): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Comparator implementing TaskSort. Rules (mirrored by the SQL ORDER BY):
 *  - 'manual': rank, then id (dir 'desc' reverses both).
 *  - dueDate/startDate/estimate: nulls always last, dir applies to non-null values; dueDate is effectiveDueDate.
 *  - priority: 0 ("no priority") always last; dir applies to 1..4 ('desc' = urgent first).
 *  - title: case-insensitive (ASCII lower-casing, like SQLite NOCASE).
 *  - status: by status position.
 *  - Ties are broken by rank asc, then id asc.
 */
export function compareTasks(a: TaskDTO, b: TaskDTO, sort: TaskSort, ctx: SortContext): number {
  const sign = sort.dir === 'desc' ? -1 : 1;
  let r = 0;
  switch (sort.field) {
    case 'manual':
      r = sign * (cmpPrimitive(a.rank, b.rank) || cmpPrimitive(a.id, b.id));
      return r;
    case 'priority': {
      const pa = a.priority === 0 ? null : a.priority;
      const pb = b.priority === 0 ? null : b.priority;
      r = cmpNullsLast(pa, pb, (x, y) => sign * cmpPrimitive(x, y));
      break;
    }
    case 'dueDate':
      r = cmpNullsLast(effectiveDueDate(a), effectiveDueDate(b), (x, y) => sign * cmpPrimitive(x, y));
      break;
    case 'startDate':
      r = cmpNullsLast(a.startDate, b.startDate, (x, y) => sign * cmpPrimitive(x, y));
      break;
    case 'estimate':
      r = cmpNullsLast(a.estimate, b.estimate, (x, y) => sign * cmpPrimitive(x, y));
      break;
    case 'createdAt':
      r = sign * cmpPrimitive(a.createdAt, b.createdAt);
      break;
    case 'updatedAt':
      r = sign * cmpPrimitive(a.updatedAt, b.updatedAt);
      break;
    case 'title':
      r = sign * cmpPrimitive(asciiLower(a.title), asciiLower(b.title));
      break;
    case 'number':
      r = sign * (cmpPrimitive(a.projectId, b.projectId) || cmpPrimitive(a.number, b.number));
      break;
    case 'status':
      r =
        sign *
        cmpPrimitive(ctx.statusPositionById.get(a.statusId) ?? 0, ctx.statusPositionById.get(b.statusId) ?? 0);
      break;
  }
  return r || cmpPrimitive(a.rank, b.rank) || cmpPrimitive(a.id, b.id);
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Build a FilterContext from bootstrap-style lists. */
export function buildFilterContext(input: {
  statuses: ReadonlyArray<{ id: number; category: StatusCategory }>;
  projects: ReadonlyArray<{ id: number; status: ProjectStatus }>;
  today: ISODate;
  weekStartsOn: WeekStart;
  nowMs?: number;
}): FilterContext {
  return {
    statusCategoryById: new Map(input.statuses.map((s) => [s.id, s.category])),
    projectStatusById: new Map(input.projects.map((p) => [p.id, p.status])),
    today: input.today,
    weekStartsOn: input.weekStartsOn,
    nowMs: input.nowMs,
  };
}
