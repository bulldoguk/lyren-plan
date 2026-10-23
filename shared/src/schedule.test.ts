import { describe, expect, it } from 'vitest';
import { computeSchedule, findCycle, wouldCycle, type ScheduleTask, type TaskLink } from './schedule';

const TODAY = '2026-10-23';

const task = (id: number, over: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id,
  startDate: null,
  dueDate: null,
  state: 'open',
  completedAt: null,
  archived: false,
  ...over,
});

const link = (blockerId: number, blockedId: number): TaskLink => ({ blockerId, blockedId });

describe('computeSchedule', () => {
  it('leaves a task whose blocker finishes in time alone', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-10-25' }), task(2, { startDate: '2026-10-27', dueDate: '2026-10-30' })],
      [link(1, 2)],
      TODAY,
    );
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-27', adjustedDueDate: '2026-10-30', slipDays: 0 });
    expect(s.get(1)).toEqual({ adjustedStartDate: null, adjustedDueDate: '2026-10-25', slipDays: 0 });
  });

  it('pushes the blocked task to the day after its blocker, keeping its duration', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-10-28' }), task(2, { startDate: '2026-10-26', dueDate: '2026-10-29' })],
      [link(1, 2)],
      TODAY,
    );
    // 4 days long (26–29), now starting the 29th.
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-29', adjustedDueDate: '2026-11-01', slipDays: 3 });
  });

  it('counts a task without a start date as one day long', () => {
    const s = computeSchedule([task(1, { dueDate: '2026-10-28' }), task(2, { dueDate: '2026-10-27' })], [link(1, 2)], TODAY);
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-29', adjustedDueDate: '2026-10-29', slipDays: 2 });
  });

  it('never moves the due date earlier', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-10-24' }), task(2, { dueDate: '2026-11-10' })],
      [link(1, 2)],
      TODAY,
    );
    // Starts the 25th at the earliest, which a one-day task due on the 10th of next month absorbs.
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-25', adjustedDueDate: '2026-11-10', slipDays: 0 });
  });

  it('propagates downstream through a chain', () => {
    const s = computeSchedule(
      [
        task(1, { dueDate: '2026-10-30' }),
        task(2, { startDate: '2026-10-27', dueDate: '2026-10-28' }),
        task(3, { startDate: '2026-10-29', dueDate: '2026-10-29' }),
      ],
      [link(1, 2), link(2, 3)],
      TODAY,
    );
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-31', adjustedDueDate: '2026-11-01', slipDays: 4 });
    expect(s.get(3)).toEqual({ adjustedStartDate: '2026-11-02', adjustedDueDate: '2026-11-02', slipDays: 4 });
  });

  it('waits for the latest of several blockers', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-10-26' }), task(2, { dueDate: '2026-10-29' }), task(3, { dueDate: '2026-10-27' })],
      [link(1, 3), link(2, 3)],
      TODAY,
    );
    expect(s.get(3)?.adjustedDueDate).toBe('2026-10-30');
  });

  it('treats an open overdue blocker as finishing today', () => {
    const s = computeSchedule([task(1, { dueDate: '2026-10-20' }), task(2, { dueDate: '2026-10-21' })], [link(1, 2)], TODAY);
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-24', adjustedDueDate: '2026-10-24', slipDays: 3 });
  });

  it('uses a done blocker’s completion date', () => {
    const done = task(1, { dueDate: '2026-10-20', state: 'done', completedAt: '2026-10-25T09:00:00.000Z' });
    const s = computeSchedule([done, task(2, { dueDate: '2026-10-24' })], [link(1, 2)], TODAY);
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-26', adjustedDueDate: '2026-10-26', slipDays: 2 });
  });

  it('still counts an archived done blocker, but not a cancelled or an archived open one', () => {
    const done = task(1, { state: 'done', completedAt: '2026-10-25T00:00:00.000Z', archived: true });
    const cancelled = task(3, { dueDate: '2026-11-30', state: 'cancelled' });
    const archivedOpen = task(4, { dueDate: '2026-11-30', archived: true });
    const s = computeSchedule(
      [done, task(2, { dueDate: '2026-10-24' }), cancelled, archivedOpen, task(5, { dueDate: '2026-10-24' })],
      [link(1, 2), link(3, 5), link(4, 5)],
      TODAY,
    );
    expect(s.get(2)?.slipDays).toBe(2);
    expect(s.get(5)).toEqual({ adjustedStartDate: null, adjustedDueDate: '2026-10-24', slipDays: 0 });
  });

  it('gives a closed blocked task its own dates', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-11-30' }), task(2, { dueDate: '2026-10-24', state: 'done', completedAt: '2026-10-22T00:00:00.000Z' })],
      [link(1, 2)],
      TODAY,
    );
    expect(s.get(2)).toEqual({ adjustedStartDate: null, adjustedDueDate: '2026-10-24', slipDays: 0 });
  });

  it('gives a blocked task without a due date an adjusted start only, and carries it downstream', () => {
    const s = computeSchedule(
      [task(1, { dueDate: '2026-10-30' }), task(2), task(3, { dueDate: '2026-10-30' })],
      [link(1, 2), link(2, 3)],
      TODAY,
    );
    expect(s.get(2)).toEqual({ adjustedStartDate: '2026-10-31', adjustedDueDate: null, slipDays: 0 });
    expect(s.get(3)).toEqual({ adjustedStartDate: '2026-11-01', adjustedDueDate: '2026-11-01', slipDays: 2 });
  });

  it('ignores a blocker with no dates at all', () => {
    const s = computeSchedule([task(1), task(2, { dueDate: '2026-10-24' })], [link(1, 2)], TODAY);
    expect(s.get(2)?.slipDays).toBe(0);
  });

  it('does not loop on a cycle', () => {
    const s = computeSchedule([task(1, { dueDate: '2026-10-30' }), task(2, { dueDate: '2026-10-30' })], [link(1, 2), link(2, 1)], TODAY);
    expect(s.size).toBe(2);
  });
});

describe('wouldCycle', () => {
  const links = [link(1, 2), link(2, 3)];
  it('refuses a task blocking itself', () => expect(wouldCycle(links, 4, 4)).toBe(true));
  it('refuses closing a loop, directly or downstream', () => {
    expect(wouldCycle(links, 2, 1)).toBe(true);
    expect(wouldCycle(links, 3, 1)).toBe(true);
  });
  it('allows anything else', () => {
    expect(wouldCycle(links, 1, 3)).toBe(false);
    expect(wouldCycle(links, 4, 1)).toBe(false);
  });
});

describe('findCycle', () => {
  it('finds a loop, and none in a tree', () => {
    expect(findCycle([link(1, 2), link(2, 3), link(1, 3)])).toBeNull();
    expect(findCycle([link(1, 2), link(2, 3), link(3, 1)])).not.toBeNull();
    expect(findCycle([link(4, 4)])).toBe(4);
  });
});
