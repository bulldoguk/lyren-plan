// Task dependencies on the server (docs/design/task-dependencies.md): reading a space's links and working out
// the adjusted dates they imply (shared/src/schedule.ts), adding and removing links, and rebaselining.
//
// Rows read (a Durable Object bills each, design §11.2): readSchedule reads every link, and the linked tasks by
// id, once per request that needs dates. A space without links reads no task row for it.

import { isClosedCategory, type StatusCategory } from '@shared/constants';
import type { ISODate } from '@shared/dates';
import { computeSchedule, wouldCycle, type ScheduledDates, type ScheduleTask, type TaskLink } from '@shared/schedule';
import type { RebaselineInput } from '@shared/schemas';
import type { RebaselineItemDTO, TaskDTO } from '@shared/types';
import type { Db } from '../db';
import { badRequest } from '../http/errors';
import { recordActivity, valueChange, compactChanges } from './activity';
import { requireTask } from './entities';
import type { TaskRow } from './rows';
import { byJsonIds, jsonList } from './sql';
import type { MutationActor } from './taskMutations';

export interface Schedule {
  /** Every link of the space. */
  links: TaskLink[];
  /** The adjusted dates of every linked task (unlinked tasks keep their own). */
  dates: Map<number, ScheduledDates>;
  /** blocked id → its blockers' ids, ascending. */
  blockedBy: Map<number, number[]>;
  /** blocker id → the ids it blocks, ascending. */
  blocks: Map<number, number[]>;
}

export const EMPTY_SCHEDULE: Schedule = { links: [], dates: new Map(), blockedBy: new Map(), blocks: new Map() };

type ScheduleRow = Pick<TaskRow, 'id' | 'start_date' | 'due_date' | 'status_id' | 'completed_at' | 'archived_at'>;

function stateOf(category: StatusCategory | undefined): ScheduleTask['state'] {
  if (category === 'cancelled') return 'cancelled';
  return category !== undefined && isClosedCategory(category) ? 'done' : 'open';
}

function grouped(links: readonly TaskLink[], key: 'blockerId' | 'blockedId', value: 'blockerId' | 'blockedId'): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const l of links) {
    const list = out.get(l[key]);
    if (list) list.push(l[value]);
    else out.set(l[key], [l[value]]);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/** Every link of the space, and the adjusted dates of the linked tasks as of `today`. */
export function readSchedule(db: Db, today: ISODate): Schedule {
  const links = db
    .all<{ blocker_id: number; blocked_id: number }>('SELECT blocker_id, blocked_id FROM task_links')
    .map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id }));
  if (links.length === 0) return EMPTY_SCHEDULE;
  const ids = [...new Set(links.flatMap((l) => [l.blockerId, l.blockedId]))];
  const categories = new Map(
    db.all<{ id: number; category: StatusCategory }>('SELECT id, category FROM statuses').map((s) => [s.id, s.category]),
  );
  const tasks = db
    .all<ScheduleRow>(
      `SELECT t.id, t.start_date, t.due_date, t.status_id, t.completed_at, t.archived_at FROM ${byJsonIds('tasks', 't', 'ids')}`,
      { ids: jsonList(ids) },
    )
    .map(
      (r): ScheduleTask => ({
        id: r.id,
        startDate: r.start_date,
        dueDate: r.due_date,
        state: stateOf(categories.get(r.status_id)),
        completedAt: r.completed_at,
        archived: r.archived_at !== null,
      }),
    );
  return {
    links,
    dates: computeSchedule(tasks, links, today),
    blockedBy: grouped(links, 'blockedId', 'blockerId'),
    blocks: grouped(links, 'blockerId', 'blockedId'),
  };
}

/** The slipped tasks' adjusted due dates, by id: what replaces their due date in filters and sorting. */
export function slips(schedule: Schedule): Map<number, ISODate> {
  const out = new Map<number, ISODate>();
  for (const [id, d] of schedule.dates) if (d.slipDays > 0 && d.adjustedDueDate !== null) out.set(id, d.adjustedDueDate);
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function refOf(db: Db, row: Pick<TaskRow, 'project_id' | 'number'>): string {
  const key = db.get<{ key: string }>('SELECT key FROM projects WHERE id = :id', { id: row.project_id })?.key ?? '?';
  return `${key}-${row.number}`;
}

/** Record a change of `blocked`'s blockers on it, and bump it (call inside the transaction). */
function recordLinkChange(db: Db, actor: MutationActor | null, blocked: TaskRow, change: { added?: string[]; removed?: string[] }): void {
  db.run('UPDATE tasks SET updated_at = :now WHERE id = :id', { id: blocked.id, now: new Date().toISOString() });
  recordActivity(db, {
    userId: actor?.userId ?? null,
    projectId: blocked.project_id,
    taskId: blocked.id,
    entityType: 'task',
    entityId: blocked.id,
    action: 'task.updated',
    data: {
      changes: [{ field: 'blockedBy', added: change.added ?? [], removed: change.removed ?? [] }],
      title: blocked.title,
      ref: refOf(db, blocked),
    },
  });
}

/**
 * Link `blockerId` → `blockedId`. Adding a link that exists changes nothing. 400 for a link to itself, an
 * unknown blocker, or one that would close a cycle (the blocker already waits on the blocked task).
 */
export function addLink(db: Db, actor: MutationActor, blockedId: number, blockerId: number): void {
  db.tx(() => {
    const blocked = requireTask(db, blockedId);
    if (blockerId === blockedId) {
      throw badRequest('A task cannot block itself', [{ path: 'blockerId', message: 'A task cannot block itself' }]);
    }
    const blocker = db.get<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id: blockerId });
    if (!blocker) throw badRequest('Unknown task', [{ path: 'blockerId', message: `Unknown task ${blockerId}` }]);
    const exists = db.get('SELECT 1 AS x FROM task_links WHERE blocker_id = :blockerId AND blocked_id = :blockedId', {
      blockerId,
      blockedId,
    });
    if (exists) return;
    const links = db
      .all<{ blocker_id: number; blocked_id: number }>('SELECT blocker_id, blocked_id FROM task_links')
      .map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id }));
    if (wouldCycle(links, blockerId, blockedId)) {
      const message = `${refOf(db, blocker)} can't block ${refOf(db, blocked)}: it already waits on it`;
      throw badRequest(message, [{ path: 'blockerId', message }]);
    }
    db.run('INSERT INTO task_links (blocker_id, blocked_id, created_at) VALUES (:blockerId, :blockedId, :now)', {
      blockerId,
      blockedId,
      now: new Date().toISOString(),
    });
    recordLinkChange(db, actor, blocked, { added: [refOf(db, blocker)] });
  });
}

/** Remove the link `blockerId` → `blockedId`; removing one that doesn't exist changes nothing. */
export function removeLink(db: Db, actor: MutationActor, blockedId: number, blockerId: number): void {
  db.tx(() => {
    const blocked = requireTask(db, blockedId);
    const { changes } = db.run('DELETE FROM task_links WHERE blocker_id = :blockerId AND blocked_id = :blockedId', {
      blockerId,
      blockedId,
    });
    if (changes === 0) return;
    const blocker = db.get<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id: blockerId });
    recordLinkChange(db, actor, blocked, { removed: [blocker ? refOf(db, blocker) : `#${blockerId}`] });
  });
}

/**
 * Before a task is deleted (its links go by cascade): note on each task it blocked that the blocker went.
 * Call inside the deleting transaction, before the DELETE.
 */
export function noteBlockerDeleted(db: Db, actor: MutationActor, deleted: TaskRow): void {
  const blocked = db.all<TaskRow>(
    'SELECT t.* FROM tasks t WHERE t.id IN (SELECT blocked_id FROM task_links WHERE blocker_id = :id)',
    { id: deleted.id },
  );
  if (blocked.length === 0) return;
  const ref = refOf(db, deleted);
  for (const row of blocked) recordLinkChange(db, actor, row, { removed: [ref] });
}

// ---------------------------------------------------------------------------
// Rebaseline
// ---------------------------------------------------------------------------

/**
 * The slipped open tasks in scope (a project, or tasks by id) and the dates rebaselining gives them: the
 * adjusted start (when the task has a start date) and the adjusted due date, which keeps the duration.
 * Ordered by the new due date, then ref.
 */
export function rebaselinePlan(db: Db, input: RebaselineInput, today: ISODate): RebaselineItemDTO[] {
  const schedule = readSchedule(db, today);
  const slipped = [...schedule.dates].filter(([, d]) => d.slipDays > 0).map(([id]) => id);
  if (slipped.length === 0) return [];
  const scope = input.ids ? new Set(input.ids) : null;
  const rows = db
    .all<TaskRow>(`SELECT t.* FROM ${byJsonIds('tasks', 't', 'ids')}`, { ids: jsonList(slipped) })
    .filter((r) => (scope ? scope.has(r.id) : r.project_id === input.projectId) && r.archived_at === null);
  const keys = new Map(db.all<{ id: number; key: string }>('SELECT id, key FROM projects').map((p) => [p.id, p.key]));
  return rows
    .map((r) => {
      const d = schedule.dates.get(r.id)!;
      return {
        taskId: r.id,
        ref: `${keys.get(r.project_id) ?? '?'}-${r.number}`,
        title: r.title,
        from: { startDate: r.start_date, dueDate: r.due_date },
        to: { startDate: r.start_date === null ? null : d.adjustedStartDate, dueDate: d.adjustedDueDate },
        slipDays: d.slipDays,
      };
    })
    .sort((a, b) => (a.to.dueDate ?? '').localeCompare(b.to.dueDate ?? '') || a.ref.localeCompare(b.ref));
}

/**
 * Rebaseline: copy the plan's dates over the tasks' own, so their slip becomes zero. Each task records a
 * task.updated with its date changes and `rebaseline: true`. Returns what changed.
 */
export function applyRebaseline(db: Db, actor: MutationActor, input: RebaselineInput, today: ISODate): RebaselineItemDTO[] {
  return db.tx(() => {
    const plan = rebaselinePlan(db, input, today);
    const now = new Date().toISOString();
    for (const item of plan) {
      const row = requireTask(db, item.taskId);
      db.run('UPDATE tasks SET start_date = :startDate, due_date = :dueDate, updated_at = :now WHERE id = :id', {
        id: row.id,
        startDate: item.to.startDate,
        dueDate: item.to.dueDate,
        now,
      });
      recordActivity(db, {
        userId: actor.userId,
        projectId: row.project_id,
        taskId: row.id,
        entityType: 'task',
        entityId: row.id,
        action: 'task.updated',
        data: {
          changes: compactChanges([
            valueChange('startDate', row.start_date, item.to.startDate),
            valueChange('dueDate', row.due_date, item.to.dueDate),
          ]),
          title: row.title,
          ref: item.ref,
          rebaseline: true,
        },
      });
    }
    return plan;
  });
}

/** The link fields of a TaskDTO, from a schedule. */
export function linkFields(
  schedule: Schedule,
  row: Pick<TaskRow, 'id' | 'start_date' | 'due_date'>,
): Pick<TaskDTO, 'blockedBy' | 'blocks' | 'adjustedStartDate' | 'adjustedDueDate' | 'slipDays'> {
  const d = schedule.dates.get(row.id);
  return {
    blockedBy: schedule.blockedBy.get(row.id) ?? [],
    blocks: schedule.blocks.get(row.id) ?? [],
    adjustedStartDate: d ? d.adjustedStartDate : row.start_date,
    adjustedDueDate: d ? d.adjustedDueDate : row.due_date,
    slipDays: d ? d.slipDays : 0,
  };
}
