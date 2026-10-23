// Task reading: hydration to TaskDTO, lookups by id/ref, and the SQL implementation of
// TaskFilter / TaskSort. buildTaskWhere and taskOrderBy are exact SQL equivalents of
// matchesTaskFilter / compareTasks in shared/src/filter.ts (cross-checked on randomized data by
// server/test/contract/services.filter.contract.ts, on both adapters) — keep them in lockstep. The SQL
// reads as few rows as it can (a Durable Object bills each, design §11.2, Appendix D 42); the cost test is
// server/test-workers/cost.test.ts.

import { LIMITS } from '@shared/constants';
import { resolveDuePreset, type ISODate, type WeekStart } from '@shared/dates';
import { searchTokens } from '@shared/filter';
import type { TaskFilter, TaskQueryInput, TaskSort } from '@shared/schemas';
import type { TagRef, TaskDTO, TaskQueryResult } from '@shared/types';
import type { Db, SqlValue } from '../db';
import { notFound } from '../http/errors';
import { compareTagNames, toTagRef } from './mappers';
import type { TaskRow } from './rows';
import { linkFields, readSchedule, slips, type Schedule } from './schedule';
import { byJsonIds, CLOSED_CATEGORIES_SQL, jsonList, serverToday } from './sql';

/**
 * FROM clause every task query uses: `t` = tasks, and nothing else. buildTaskWhere and taskOrderBy reach the
 * project, status and epic of a task through subqueries over those small tables instead of joins, because a
 * Durable Object bills every row a statement reads, and a join reads its row once per task (design §11.2):
 * an uncorrelated `IN (SELECT …)` reads its table once per statement, a correlated subquery one row per task
 * it is evaluated for.
 */
export const TASK_FROM = 'tasks t';

/** SQL expression for a task's ref ('KEY-42') within TASK_FROM (a correlated read of its project's key). */
export const TASK_REF_SQL = "(SELECT key FROM projects WHERE id = t.project_id) || '-' || t.number";

/**
 * The ref folded like the *_fold columns: project keys are ASCII (projectKeySchema), so SQLite's
 * ASCII-only lower() is exact here.
 */
export const TASK_REF_FOLD_SQL = `lower(${TASK_REF_SQL})`;

/**
 * The columns a task list selects: the row alone. It holds the task's tag ids (migration 2), comment count
 * and logged minutes (migration 3), so a list reads no task_tags, comment or work-log row: a correlated count
 * read one billed row per comment and per work log of every task listed (Appendix D 46).
 */
export const TASK_COLUMNS = 't.*';

/**
 * SQL condition: every token of the JSON array bound to `param` occurs in `haystack` (folded text). One
 * parameter for any number of tokens (design §3.4), so a long query never exceeds a statement's limit.
 */
export function allTokensSql(haystack: string, param: string): string {
  return `NOT EXISTS (SELECT 1 FROM json_each(${param}) tk WHERE instr(${haystack}, tk.value) = 0)`;
}

/** SQL expression: how many tokens of the JSON array bound to `param` occur in `haystack` (ranking). */
export function tokenHitsSql(haystack: string, param: string): string {
  return `(SELECT COUNT(*) FROM json_each(${param}) tk WHERE instr(${haystack}, tk.value) > 0)`;
}

/**
 * SQL condition: the task's status category is open (not completed/cancelled), over `status` (t.status_id,
 * or +t.status_id, which keeps the planner off its index). Not `NOT t.status_id IN (closed ones)`: a Durable
 * Object bills a NOT IN about one row per task it checks, an IN nothing. Every task has a status (a foreign
 * key).
 */
export const taskOpenSql = (status = 't.status_id') =>
  `${status} IN (SELECT id FROM statuses WHERE category NOT IN ${CLOSED_CATEGORIES_SQL})`;

export const DEFAULT_TASK_SORT: TaskSort = { field: 'manual', dir: 'asc' };

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/** The tag ids of a task row (tasks.tag_ids, a JSON array). */
export function tagIdsOf(row: Pick<TaskRow, 'tag_ids'>): number[] {
  return JSON.parse(row.tag_ids) as number[];
}

/**
 * How a read gets the links and adjusted dates (services/schedule.ts): a schedule already read, or the date
 * to read one for (default the server's UTC date).
 */
export type ScheduleSource = Schedule | ISODate | undefined;

function scheduleOf(db: Db, source: ScheduleSource): Schedule {
  return typeof source === 'object' ? source : readSchedule(db, source ?? serverToday());
}

/**
 * Rows -> TaskDTOs, preserving input order. Batched: three queries at most for any number of rows (project
 * keys, epic milestones, tag names), each reading its rows by id, plus the space's links (services/schedule.ts)
 * unless `schedule` is one already read. The tags come from the rows' tag_ids and the counts from the rows
 * themselves, so no task_tags, comment or work-log row is read.
 */
export function hydrateTasks(db: Db, rows: readonly TaskRow[], schedule?: ScheduleSource): TaskDTO[] {
  if (rows.length === 0) return [];
  const links = scheduleOf(db, schedule);
  const keys = new Map(
    db
      .all<{ id: number; key: string }>(`SELECT p.id, p.key FROM ${byJsonIds('projects', 'p', 'ids')}`, {
        ids: jsonList(rows.map((r) => r.project_id)),
      })
      .map((p) => [p.id, p.key]),
  );
  const epicIds = rows.map((r) => r.epic_id).filter((id): id is number => id !== null);
  const milestones = new Map(
    epicIds.length === 0
      ? []
      : db
          .all<{ id: number; milestone_id: number | null }>(
            `SELECT e.id, e.milestone_id FROM ${byJsonIds('epics', 'e', 'ids')}`,
            { ids: jsonList(epicIds) },
          )
          .map((e) => [e.id, e.milestone_id]),
  );
  const tagIds = new Map(rows.map((r) => [r.id, tagIdsOf(r)]));
  const allTagIds = [...tagIds.values()].flat();
  const tagsById = new Map(
    allTagIds.length === 0
      ? []
      : db
          .all<{ id: number; name: string; color: string }>(`SELECT g.id, g.name, g.color FROM ${byJsonIds('tags', 'g', 'ids')}`, {
              ids: jsonList(allTagIds),
            })
          .map((g) => [g.id, toTagRef(g)]),
  );
  return rows.map((r) => {
    const tags = tagIds
      .get(r.id)!
      .map((id) => tagsById.get(id))
      .filter((g): g is TagRef => g !== undefined)
      .sort(compareTagNames);
    return {
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
      tags,
      commentCount: r.comment_count,
      worklogMinutes: r.worklog_minutes,
      ...linkFields(links, r),
    };
  });
}

/** One task as DTO, or 404. */
export function getTaskDTO(db: Db, id: number, schedule?: ScheduleSource): TaskDTO {
  const row = db.get<TaskRow>(`SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} WHERE t.id = :id`, { id });
  if (!row) throw notFound('Task');
  return hydrateTasks(db, [row], schedule)[0]!;
}

/** Tasks by id as DTOs in the order of `ids` (unknown ids are skipped). */
export function getTaskDTOs(db: Db, ids: readonly number[], schedule?: ScheduleSource): TaskDTO[] {
  if (ids.length === 0) return [];
  const rows = new Map(
    db.all<TaskRow>(`SELECT ${TASK_COLUMNS} FROM ${byJsonIds('tasks', 't', 'ids')}`, { ids: jsonList(ids) }).map((r) => [r.id, r]),
  );
  const ordered = [...new Set(ids)].map((id) => rows.get(id)).filter((r): r is TaskRow => r !== undefined);
  return hydrateTasks(db, ordered, schedule);
}

/** Current ref ('KEY-42') of a task row — for activity snapshots such as `{ title, ref }`. */
export function taskRefOf(db: Db, row: Pick<TaskRow, 'project_id' | 'number'>): string {
  const project = db.get<{ key: string }>('SELECT key FROM projects WHERE id = :id', { id: row.project_id });
  if (!project) throw notFound('Project');
  return `${project.key}-${row.number}`;
}

const REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,15})$/;

/** Split 'web-3' into { key: 'WEB', number: 3 }; null when it is not a ref. */
export function parseTaskRef(ref: string): { key: string; number: number } | null {
  const m = REF_RE.exec(ref.trim());
  if (!m) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { key: m[1]!.toUpperCase(), number } : null;
}

/** Task by human ref ('WEB-3', case-insensitive), or null. */
export function findTaskByRef(db: Db, ref: string, schedule?: ScheduleSource): TaskDTO | null {
  const parsed = parseTaskRef(ref);
  if (!parsed) return null;
  const row = db.get<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM ${TASK_FROM} JOIN projects p ON p.id = t.project_id WHERE p.key = :key AND t.number = :number`,
    parsed,
  );
  return row ? hydrateTasks(db, [row], schedule)[0]! : null;
}

// ---------------------------------------------------------------------------
// Filtering & sorting (SQL twins of shared/src/filter.ts)
// ---------------------------------------------------------------------------

export interface TaskWhereContext {
  /** The client's calendar date, for due presets. */
  today: ISODate;
  weekStartsOn: WeekStart;
  /** Epoch ms for closedWithinDays. */
  nowMs: number;
  /**
   * The slipped tasks' adjusted due dates (services/schedule.ts#slips), which replace their due date in the due
   * filters and sorting (effectiveDueDate). None given: every task's own.
   */
  slips?: ReadonlyMap<number, ISODate>;
}

/**
 * SQL expression for a task's due date as filters and sorting see it (effectiveDueDate): t.due_date, or the
 * adjusted due date of a slipped task, looked up in the JSON object bound to :slips (slipsParam). Plain
 * t.due_date when nothing slipped, which keeps the due-date index usable.
 */
export function dueDateSql(slipped: ReadonlyMap<number, ISODate> | undefined): string {
  return slipped && slipped.size > 0 ? `COALESCE(json_extract(:slips, '$."' || t.id || '"'), t.due_date)` : 't.due_date';
}

/** The :slips parameter dueDateSql and the slipped filter read (an empty object when nothing slipped). */
export function slipsParam(slipped: ReadonlyMap<number, ISODate> | undefined): { slips: string } {
  return { slips: JSON.stringify(Object.fromEntries(slipped ?? [])) };
}

export interface SqlFragment {
  sql: string;
  params: Record<string, SqlValue>;
}

function nonEmpty<T>(arr: readonly T[] | undefined): arr is readonly T[] {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * WHERE condition (over TASK_FROM's `t` alone) equivalent to matchesTaskFilter(task, filter, ctx).
 * Parameter names are f0, f1, … — don't reuse them in the surrounding statement. A unary `+` keeps the
 * planner from an index for the conditions that hold for most tasks (not archived, of a project that is
 * not archived): without statistics it takes any indexed equality for selective, and then reads every
 * task through that index and once more to sort them. Likewise for the status conditions when a list of
 * projects is given, which the (project_id, number) index serves: through the status index the query read
 * the tasks of every project in those statuses (a project's page of open tasks: 2,419 rows instead of
 * 1,739, a board that hides closed tasks 2,019 instead of 1,339; Appendix D 47).
 */
export function buildTaskWhere(filter: TaskFilter, ctx: TaskWhereContext): SqlFragment {
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
  /** IN never matches NULL: a null entry becomes `column IS NULL`. */
  const nullableIn = (column: string, ids: readonly (number | null)[]): string => {
    const values = ids.filter((id): id is number => id !== null);
    const parts: string[] = [];
    if (values.length > 0) parts.push(inList(column, values));
    if (ids.includes(null)) parts.push(`${column} IS NULL`);
    return anyOf(parts);
  };
  /** The task's epic is in one of the milestones (null: a task without an epic, or whose epic has none). */
  const inMilestones = (ids: readonly (number | null)[]): string => {
    const values = ids.filter((id): id is number => id !== null);
    const parts: string[] = [];
    if (values.length > 0) parts.push(`t.epic_id IN (SELECT id FROM epics WHERE ${inList('milestone_id', values)})`);
    if (ids.includes(null)) parts.push('(t.epic_id IS NULL OR t.epic_id IN (SELECT id FROM epics WHERE milestone_id IS NULL))');
    return anyOf(parts);
  };
  const tagged = (ids?: readonly number[]): string =>
    `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id${ids ? ` AND ${inList('tt.tag_id', ids)}` : ''})`;
  const status = nonEmpty(filter.projectIds) ? '+t.status_id' : 't.status_id';
  const open = taskOpenSql(status);

  if (nonEmpty(filter.ids)) clauses.push(inList('t.id', filter.ids));
  // Projects: an explicit list wins; otherwise archived projects are hidden unless requested.
  if (nonEmpty(filter.projectIds)) clauses.push(inList('t.project_id', filter.projectIds));
  else if (!filter.includeArchivedProjects) clauses.push("+t.project_id IN (SELECT id FROM projects WHERE status <> 'archived')");

  if (nonEmpty(filter.milestoneIds)) clauses.push(inMilestones(filter.milestoneIds));
  if (nonEmpty(filter.epicIds)) clauses.push(nullableIn('t.epic_id', filter.epicIds));
  if (nonEmpty(filter.statusIds)) clauses.push(inList(status, filter.statusIds));
  if (nonEmpty(filter.statusCategories)) {
    clauses.push(`${status} IN (SELECT id FROM statuses WHERE ${inList('category', filter.statusCategories)})`);
  }
  if (nonEmpty(filter.priorities)) clauses.push(inList('t.priority', filter.priorities));

  if (nonEmpty(filter.tagIds)) {
    const wanted = [...new Set(filter.tagIds.filter((id): id is number => id !== null))];
    const wantsUntagged = filter.tagIds.includes(null);
    if ((filter.tagMode ?? 'any') === 'all') {
      if (wanted.length > 0) {
        // task_tags has PRIMARY KEY (task_id, tag_id), so COUNT(*) counts distinct matches.
        clauses.push(
          `(SELECT COUNT(*) FROM task_tags tt WHERE tt.task_id = t.id AND ${inList('tt.tag_id', wanted)}) = ${param(wanted.length)}`,
        );
      } else if (wantsUntagged) {
        clauses.push(`NOT ${tagged()}`);
      }
    } else {
      const parts: string[] = [];
      if (wanted.length > 0) parts.push(tagged(wanted));
      if (wantsUntagged) parts.push(`NOT ${tagged()}`);
      clauses.push(anyOf(parts));
    }
  }
  if (nonEmpty(filter.excludeTagIds)) clauses.push(`NOT ${tagged(filter.excludeTagIds)}`);

  const due = dueDateSql(ctx.slips);
  if (nonEmpty(filter.due)) {
    const parts = [...new Set(filter.due)].map((preset) => {
      const r = resolveDuePreset(preset, ctx.today, ctx.weekStartsOn);
      switch (r.kind) {
        case 'overdue':
          return `(${due} < ${param(r.before)} AND ${open})`;
        case 'none':
          return `${due} IS NULL`;
        case 'any':
          return `${due} IS NOT NULL`;
        case 'range': {
          const range = [`${due} IS NOT NULL`];
          if (r.from !== null) range.push(`${due} >= ${param(r.from)}`);
          if (r.to !== null) range.push(`${due} <= ${param(r.to)}`);
          return `(${range.join(' AND ')})`;
        }
      }
    });
    clauses.push(anyOf(parts));
  }
  if (filter.dueFrom || filter.dueTo) {
    clauses.push(`${due} IS NOT NULL`);
    if (filter.dueFrom) clauses.push(`${due} >= ${param(filter.dueFrom)}`);
    if (filter.dueTo) clauses.push(`${due} <= ${param(filter.dueTo)}`);
  }

  if (filter.slipped) {
    clauses.push(ctx.slips && ctx.slips.size > 0 ? 't.id IN (SELECT CAST(key AS INTEGER) FROM json_each(:slips))' : '0');
  }

  // The JS reference's haystack is `${title}\n${description}\n${ref}`, lower-cased; here the stored folds
  // (= JS toLowerCase, which folding a concatenation piecewise leaves unchanged), so Unicode folding is
  // identical. The tokens are already folded by searchTokens and hold no whitespace, so a token occurs in
  // the haystack exactly when it occurs in one of its three parts: they are checked one by one, the ref
  // (a read of the project's key) only for a token that is in neither the title nor the description.
  const tokens = searchTokens(filter.search);
  if (tokens.length > 0) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM json_each(${param(JSON.stringify(tokens))}) tk
        WHERE instr(t.title_fold, tk.value) = 0 AND instr(t.description_fold, tk.value) = 0
          AND instr(${TASK_REF_FOLD_SQL}, tk.value) = 0)`,
    );
  }

  const archived = filter.archived ?? 'exclude';
  if (archived === 'exclude') clauses.push('+t.archived_at IS NULL');
  else if (archived === 'only') clauses.push('t.archived_at IS NOT NULL');

  const days = filter.closedWithinDays;
  if (days !== undefined && days !== null) {
    if (days === 0) {
      clauses.push(open);
    } else {
      const cutoffIso = new Date(ctx.nowMs - days * 86_400_000).toISOString();
      clauses.push(`(${open} OR t.completed_at IS NULL OR t.completed_at >= ${param(cutoffIso)})`);
    }
  }

  return { sql: clauses.length > 0 ? clauses.join('\n AND ') : '1', params };
}

/**
 * ORDER BY list (over TASK_FROM's `t`) equivalent to compareTasks(a, b, sort):
 * nulls (and priority 0) always last, ties broken by rank then id (both ascending);
 * 'manual' is rank, id in the requested direction. 'status' looks the position up in the JSON object
 * bound to :statusPositions (statusPositions(db)), which reads no row per task.
 *
 * Known edge: titles compare as UTF-8 bytes in SQLite but UTF-16 code units in JS, which
 * only differ for supplementary-plane characters vs U+E000–U+FFFF at the same position.
 */
export function taskOrderBy(sort: TaskSort, slipped?: ReadonlyMap<number, ISODate>): string {
  const dir = sort.dir === 'desc' ? 'DESC' : 'ASC';
  const tie = 't.rank ASC, t.id ASC';
  switch (sort.field) {
    case 'manual':
      return `t.rank ${dir}, t.id ${dir}`;
    case 'priority':
      return `t.priority = 0, t.priority ${dir}, ${tie}`;
    case 'dueDate': {
      const due = dueDateSql(slipped);
      return `${due} IS NULL, ${due} ${dir}, ${tie}`;
    }
    case 'startDate':
      return `t.start_date IS NULL, t.start_date ${dir}, ${tie}`;
    case 'estimate':
      return `t.estimate IS NULL, t.estimate ${dir}, ${tie}`;
    case 'createdAt':
      return `t.created_at ${dir}, ${tie}`;
    case 'updatedAt':
      return `t.updated_at ${dir}, ${tie}`;
    case 'title':
      // NOCASE folds ASCII only, like the reference's asciiLower().
      return `t.title COLLATE NOCASE ${dir}, ${tie}`;
    case 'number':
      return `t.project_id ${dir}, t.number ${dir}, ${tie}`;
    case 'status':
      return `json_extract(:statusPositions, '$."' || t.status_id || '"') ${dir}, ${tie}`;
  }
}

/** The :statusPositions parameter of taskOrderBy: every status's position by id, as one JSON object. */
export function statusPositions(db: Db): string {
  const rows = db.all<{ id: number; position: number }>('SELECT id, position FROM statuses');
  return JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.position])));
}

export interface TaskQueryOptions {
  /** Epoch ms for closedWithinDays (default Date.now()). */
  nowMs?: number;
  /** Fallback when input.today is absent (default: server UTC date). */
  today?: ISODate;
  /** Fallback when input.weekStartsOn is absent (default 1, Monday). */
  weekStartsOn?: WeekStart;
}

/**
 * The most tasks a request asks for as a page of a longer list: the task list asks for 200 at a time (and 200
 * more on "Show more"), boards and the dashboard's sections for LIMITS.queryLimitMax, which they expect to get
 * all of. queryTasks reads a page and a whole list differently (below).
 */
export const TASK_PAGE_MAX = 500;

/**
 * POST /api/tasks/query. Filter default {} (which still hides archived tasks and archived
 * projects), sort default manual/asc, limit default LIMITS.queryLimitDefault, offset 0.
 *
 * Rows read (a Durable Object bills each, design §11.2, Appendix D 47): a whole list reads its tasks in order
 * (once each, and once more each in a sorter for an order no index gives), and a COUNT(*) of every match only
 * when it was cut short. A page reads the ids of every match in order instead, which gives the total, and then
 * its own rows by id (two rows a task): the sorter has read every match anyway, so the count costs nothing
 * more, where the COUNT(*) read every match again (a page of one 660-task project: 1,739 rows instead of
 * 3,493). Where an index gives the order and the planner stops after the page (the manual order of the whole
 * space), the page costs about one row more per task shown than reading it directly would.
 */
export function queryTasks(db: Db, input: TaskQueryInput = {}, opts: TaskQueryOptions = {}): TaskQueryResult {
  const today = input.today ?? opts.today ?? serverToday();
  const schedule = readSchedule(db, today);
  const slipped = slips(schedule);
  const ctx: TaskWhereContext = {
    today,
    weekStartsOn: input.weekStartsOn ?? opts.weekStartsOn ?? 1,
    nowMs: opts.nowMs ?? Date.now(),
    slips: slipped,
  };
  const where = buildTaskWhere(input.filter ?? {}, ctx);
  const limit = Math.min(Math.max(1, input.limit ?? LIMITS.queryLimitDefault), LIMITS.queryLimitMax);
  const offset = Math.max(0, input.offset ?? 0);
  const sort = input.sort ?? DEFAULT_TASK_SORT;
  const orderBy = taskOrderBy(sort, slipped);
  // Extra named parameters are ignored, so :slips goes with every statement (dueDateSql, the slipped filter).
  const whereParams = { ...where.params, ...slipsParam(slipped) };
  const params = { ...whereParams, ...(sort.field === 'status' ? { statusPositions: statusPositions(db) } : {}) };
  if (limit <= TASK_PAGE_MAX) {
    const ids = db
      .all<{ id: number }>(`SELECT t.id FROM ${TASK_FROM} WHERE ${where.sql} ORDER BY ${orderBy}`, params)
      .map((r) => r.id);
    return { tasks: getTaskDTOs(db, ids.slice(offset, offset + limit), schedule), total: ids.length };
  }
  const rows = db.all<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM ${TASK_FROM}
      WHERE ${where.sql}
      ORDER BY ${orderBy}
      LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  );
  const complete = rows.length < limit && (offset === 0 || rows.length > 0);
  const total = complete
    ? offset + rows.length
    : db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TASK_FROM} WHERE ${where.sql}`, whereParams)!.n;
  return { tasks: hydrateTasks(db, rows, schedule), total };
}
