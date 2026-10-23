// Task dependencies: finish-to-start links and the dates they imply (docs/design/task-dependencies.md).
//
// A link says its blocked task can't finish on time until its blocker has finished. Nothing here is stored:
// the adjusted dates are worked out when tasks are read, against the client's `today` (SPEC §4), from the
// tasks' own dates and the links. The server runs this over a space's linked tasks (services/schedule.ts);
// it is pure, so the web can preview with it too.
//
// Rules, in calendar days:
// - A blocker finishes: done (completed category) on its completedAt's date; open on its adjusted due date
//   (its adjusted start without a due date), or today when that has passed; never when it has neither date.
//   A cancelled blocker, and an archived open one, no longer blocks (the link stays).
// - Duration: due − start + 1, inclusive; 1 day without a start date.
// - Adjusted start: the later of the start date and the day after the latest blocker finishes.
// - Adjusted due: adjusted start + duration − 1, never earlier than the due date. A task without a due date
//   has none, and a closed task keeps its own dates: slip is about work still to do.

import { addDays, diffDays, type ISODate } from './dates';

/** What the schedule needs of a task. */
export interface ScheduleTask {
  id: number;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  /** The category of its status, reduced: open, done (completed) or cancelled. */
  state: 'open' | 'done' | 'cancelled';
  /** completedAt (an ISO timestamp), for a done task. */
  completedAt: string | null;
  archived: boolean;
}

/** One link: `blockerId` must finish before `blockedId` can. */
export interface TaskLink {
  blockerId: number;
  blockedId: number;
}

export interface ScheduledDates {
  adjustedStartDate: ISODate | null;
  adjustedDueDate: ISODate | null;
  /** Days the adjusted due date lies after the due date; 0 when it doesn't. */
  slipDays: number;
}

/** The later of two dates, either of which may be missing. */
function later(a: ISODate | null, b: ISODate | null): ISODate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/** Whether a blocker still holds up the tasks it blocks. */
export function blocks(task: Pick<ScheduleTask, 'state' | 'archived'>): boolean {
  return task.state === 'done' || (task.state === 'open' && !task.archived);
}

/**
 * The adjusted dates of every task in `tasks` that `links` reach (a task without links keeps its own dates and
 * isn't in the result). Links to tasks missing from `tasks` are ignored. Cycles can't be created (the server
 * refuses them), but a link that would close one is ignored here too rather than looping.
 */
export function computeSchedule(tasks: Iterable<ScheduleTask>, links: Iterable<TaskLink>, today: ISODate): Map<number, ScheduledDates> {
  const byId = new Map<number, ScheduleTask>();
  for (const t of tasks) byId.set(t.id, t);
  const blockersOf = new Map<number, number[]>();
  for (const { blockerId, blockedId } of links) {
    if (!byId.has(blockerId) || !byId.has(blockedId) || blockerId === blockedId) continue;
    const list = blockersOf.get(blockedId);
    if (list) list.push(blockerId);
    else blockersOf.set(blockedId, [blockerId]);
  }

  const result = new Map<number, ScheduledDates>();
  const visiting = new Set<number>();

  const own = (t: ScheduleTask): ScheduledDates => ({ adjustedStartDate: t.startDate, adjustedDueDate: t.dueDate, slipDays: 0 });

  /** When `t` finishes, as its blocked tasks see it; null when it can't be told. */
  const finish = (t: ScheduleTask): ISODate | null => {
    if (t.state === 'done') return t.completedAt ? t.completedAt.slice(0, 10) : null;
    const d = dates(t.id);
    const end = d.adjustedDueDate ?? d.adjustedStartDate;
    return end === null ? null : later(end, today);
  };

  const dates = (id: number): ScheduledDates => {
    const done = result.get(id);
    if (done) return done;
    const t = byId.get(id)!;
    const blockerIds = blockersOf.get(id);
    if (!blockerIds || t.state !== 'open') {
      const d = own(t);
      if (blockerIds || t.state !== 'open') result.set(id, d);
      return d;
    }
    visiting.add(id);
    let latest: ISODate | null = null;
    for (const blockerId of blockerIds) {
      if (visiting.has(blockerId)) continue; // would close a cycle
      const blocker = byId.get(blockerId)!;
      if (!blocks(blocker)) continue;
      latest = later(latest, finish(blocker));
    }
    visiting.delete(id);
    let d: ScheduledDates;
    if (latest === null) {
      d = own(t);
    } else {
      const start = later(t.startDate, addDays(latest, 1))!;
      const duration = t.startDate !== null && t.dueDate !== null ? diffDays(t.startDate, t.dueDate) + 1 : 1;
      const due = t.dueDate === null ? null : later(t.dueDate, addDays(start, duration - 1));
      d = {
        adjustedStartDate: start,
        adjustedDueDate: due,
        slipDays: due !== null && t.dueDate !== null ? diffDays(t.dueDate, due) : 0,
      };
    }
    result.set(id, d);
    return d;
  };

  for (const id of blockersOf.keys()) dates(id);
  // Blockers that are blocked by nothing: their own dates (so every linked task is in the result).
  for (const ids of blockersOf.values()) for (const id of ids) if (!result.has(id)) result.set(id, own(byId.get(id)!));
  return result;
}

/**
 * Whether linking `blockerId` → `blockedId` would close a cycle: true when `blockedId` already blocks
 * `blockerId`, directly or downstream (or they are the same task).
 */
export function wouldCycle(links: Iterable<TaskLink>, blockerId: number, blockedId: number): boolean {
  if (blockerId === blockedId) return true;
  const blockedBy = new Map<number, number[]>();
  for (const l of links) {
    const list = blockedBy.get(l.blockerId);
    if (list) list.push(l.blockedId);
    else blockedBy.set(l.blockerId, [l.blockedId]);
  }
  // Walk downstream of blockedId; reaching blockerId means blockerId already waits on blockedId.
  const seen = new Set<number>([blockedId]);
  const stack = [blockedId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of blockedBy.get(id) ?? []) {
      if (next === blockerId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** A task on a loop of `links`, or null when they don't loop (an import's links are checked with it). */
export function findCycle(links: Iterable<TaskLink>): number | null {
  const next = new Map<number, number[]>();
  for (const l of links) {
    const list = next.get(l.blockerId);
    if (list) list.push(l.blockedId);
    else next.set(l.blockerId, [l.blockedId]);
  }
  // Depth-first, iteratively: 1 = on the current path, 2 = finished.
  const state = new Map<number, 1 | 2>();
  for (const root of next.keys()) {
    if (state.has(root)) continue;
    const stack: Array<{ id: number; i: number }> = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const out = next.get(top.id) ?? [];
      if (top.i >= out.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const id = out[top.i++]!;
      const s = state.get(id);
      if (s === 1) return id;
      if (s === undefined) {
        state.set(id, 1);
        stack.push({ id, i: 0 });
      }
    }
  }
  return null;
}
