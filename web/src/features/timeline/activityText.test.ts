import { describe, expect, it } from 'vitest';
import type { ActivityAction, ActivityData, ActivityDTO, ActivityEntityType } from '@shared/types';
import { formatDate } from '../../lib/format';
import { groupActivityRuns, groupByDay } from './activityGroups';
import {
  activityDetail,
  activityPhrases,
  activityTask,
  changePhrase,
  describeActivity,
  joinList,
  type ActivityTextLookups,
} from './activityText';

const AT = '2026-10-13T12:00:00.000Z';
const ALEX = { id: 1, displayName: 'Alex' };

function entry(action: ActivityAction, data: ActivityData = {}, extra: Partial<ActivityDTO> = {}): ActivityDTO {
  const entityType = action.split('.')[0] as ActivityEntityType;
  return {
    id: 1,
    action,
    entityType,
    entityId: 10,
    projectId: 1,
    taskId: entityType === 'project' || entityType === 'milestone' || entityType === 'epic' ? null : 5,
    data,
    actor: ALEX,
    createdAt: AT,
    task: null,
    importedBy: null,
    importedAt: null,
    ...extra,
  };
}

const lookups: ActivityTextLookups = {
  settings: { estimateUnit: 'points' },
  projectById: new Map([
    [1, { name: 'Website' }],
    [2, { name: 'Personal' }],
  ]),
  statusById: new Map([
    [3, { name: 'Todo' }],
    [4, { name: 'In Progress' }],
  ]),
  epicById: new Map([[7, { name: 'Design system' }]]),
  milestoneById: new Map([[8, { name: 'MVP launch' }]]),
};

describe('describeActivity — one sentence per action', () => {
  const cases: Record<ActivityAction, [ActivityData, string]> = {
    'project.created': [{ name: 'Website' }, 'Alex created project “Website”'],
    'project.updated': [
      { name: 'Website', changes: [{ field: 'status', from: 'active', to: 'on_hold', fromLabel: 'Active', toLabel: 'On hold' }] },
      'Alex updated project “Website”: changed status from Active → On hold',
    ],
    'project.deleted': [{ name: 'Website', key: 'WEB' }, 'Alex deleted project “Website”'],
    'milestone.created': [{ name: 'MVP launch' }, 'Alex created milestone “MVP launch”'],
    'milestone.updated': [
      { name: 'MVP launch', changes: [{ field: 'dueDate', from: null, to: '2026-11-02' }] },
      `Alex updated milestone “MVP launch”: set the due date to ${formatDate('2026-11-02')}`,
    ],
    'milestone.deleted': [{ name: 'MVP launch' }, 'Alex deleted milestone “MVP launch”'],
    'epic.created': [{ name: 'Design system' }, 'Alex created epic “Design system”'],
    'epic.updated': [
      { name: 'Design system', changes: [{ field: 'milestone', from: null, to: 8, fromLabel: null, toLabel: 'MVP launch' }, { field: 'color' }] },
      'Alex updated epic “Design system”: set the milestone to “MVP launch” and changed the color',
    ],
    'epic.deleted': [{ name: 'Design system' }, 'Alex deleted epic “Design system”'],
    'task.created': [{ title: 'Fix login', ref: 'WEB-3' }, 'Alex created the task'],
    'task.updated': [
      { title: 'Fix login', ref: 'WEB-3', changes: [{ field: 'status', from: 3, to: 4, fromLabel: 'Todo', toLabel: 'In Progress' }] },
      'Alex changed status from Todo → In Progress',
    ],
    'task.moved': [
      { fromProjectId: 1, toProjectId: 2, fromProjectName: 'Website', toProjectName: 'Personal', fromRef: 'WEB-3', toRef: 'ME-7' },
      'Alex moved the task from WEB-3 to ME-7',
    ],
    'task.deleted': [{ title: 'Fix login', ref: 'WEB-3' }, 'Alex deleted the task'],
    'comment.created': [{ excerpt: 'Looks good' }, 'Alex commented'],
    'comment.updated': [{ excerpt: 'Looks better' }, 'Alex edited a comment'],
    'comment.deleted': [{ excerpt: 'Oops' }, 'Alex deleted a comment'],
    'worklog.created': [{ minutes: 90, date: '2026-10-13', note: '' }, 'Alex logged 1h 30m'],
    'worklog.updated': [{ minutes: 45, date: '2026-10-13', note: '' }, `Alex edited logged time (45m on ${formatDate('2026-10-13')})`],
    'worklog.deleted': [{ minutes: 120, date: '2026-10-13', note: '' }, 'Alex removed 2h of logged time'],
  };

  for (const [action, [data, expected]] of Object.entries(cases) as Array<[ActivityAction, [ActivityData, string]]>) {
    it(action, () => {
      // Worklog dates are compared with the local date of createdAt: use local noon.
      const createdAt = action.startsWith('worklog.') ? new Date(2026, 9, 13, 12).toISOString() : AT;
      expect(describeActivity(entry(action, data, { createdAt }), lookups)).toBe(expected);
    });
  }

  it('names a missing actor "Someone"', () => {
    expect(describeActivity(entry('comment.created', {}, { actor: null }))).toBe('Someone commented');
  });

  it('joins several task changes into one sentence', () => {
    const e = entry('task.updated', {
      changes: [
        { field: 'priority', from: 1, to: 3, fromLabel: 'Low', toLabel: 'High' },
        { field: 'tags', added: ['bug', 'idea'], removed: [] },
        { field: 'description' },
      ],
    });
    expect(describeActivity(e, lookups)).toBe(
      'Alex changed priority from Low → High, added tags bug, idea, and edited the description',
    );
  });

  it('falls back to "updated the task" for an empty change list', () => {
    expect(describeActivity(entry('task.updated', { changes: [] }))).toBe('Alex updated the task');
    expect(describeActivity(entry('task.updated', {}))).toBe('Alex updated the task');
  });

  it('describes duplicates', () => {
    expect(describeActivity(entry('task.created', { duplicatedFrom: 'WEB-2' }))).toBe('Alex created the task as a copy of WEB-2');
  });

  it('describes moves without refs using project names (data or lookups)', () => {
    expect(activityPhrases(entry('task.moved', { fromProjectName: 'Website', toProjectName: 'Personal' }))).toEqual([
      'moved the task from Website to Personal',
    ]);
    expect(activityPhrases(entry('task.moved', { fromProjectId: 1, toProjectId: 2 }), lookups)).toEqual([
      'moved the task from Website to Personal',
    ]);
    expect(activityPhrases(entry('task.moved', { toProjectId: 2 }), lookups)).toEqual(['moved the task to Personal']);
    expect(activityPhrases(entry('task.moved', {}))).toEqual(['moved the task to another project']);
  });

  it('describes structural renames and structural entries without data from lookups', () => {
    expect(describeActivity(entry('milestone.updated', { name: 'Beta', changes: [{ field: 'name', from: 'Alpha', to: 'Beta' }] }))).toBe(
      'Alex renamed milestone “Alpha” to “Beta”',
    );
    expect(describeActivity(entry('epic.created', {}, { entityId: 7 }), lookups)).toBe('Alex created epic “Design system”');
    expect(describeActivity(entry('epic.deleted', {}, { entityId: 99 }), lookups)).toBe('Alex deleted epic “untitled”');
    expect(describeActivity(entry('project.updated', { name: 'Website', changes: [] }))).toBe('Alex updated project “Website”');
    expect(
      describeActivity(
        entry('project.updated', {
          name: 'Site',
          changes: [
            { field: 'name', from: 'Website', to: 'Site' },
            { field: 'key', from: 'WEB', to: 'SITE' },
          ],
        }),
      ),
    ).toBe('Alex updated project “Site”: renamed it from “Website” to “Site” and changed the key from WEB → SITE');
  });

  it('describes work logs: other days, notes only, deletions of notes', () => {
    const noon = new Date(2026, 9, 13, 12).toISOString();
    expect(activityPhrases(entry('worklog.created', { minutes: 30, date: '2026-10-10' }, { createdAt: noon }))).toEqual([
      `logged 30m for ${formatDate('2026-10-10')}`,
    ]);
    expect(activityPhrases(entry('worklog.created', { minutes: null, date: '2026-10-13', note: 'Call' }, { createdAt: noon }))).toEqual([
      'added a work log note',
    ]);
    expect(activityPhrases(entry('worklog.created', { minutes: 0, date: '2026-10-12', note: 'Call' }, { createdAt: noon }))).toEqual([
      `added a work log note for ${formatDate('2026-10-12')}`,
    ]);
    expect(activityPhrases(entry('worklog.updated', { minutes: null, note: 'x' }))).toEqual(['edited a work log note']);
    expect(activityPhrases(entry('worklog.deleted', { minutes: null, note: 'x' }))).toEqual(['deleted a work log note']);
  });

  it('describes unknown future actions generically', () => {
    const e = { ...entry('task.updated'), action: 'board.created' as ActivityAction, entityType: 'board' as ActivityEntityType };
    expect(activityPhrases(e)).toEqual(['created a board']);
  });
});

describe('changePhrase — every task field', () => {
  const p = (change: Parameters<typeof changePhrase>[0], l: ActivityTextLookups = lookups) => changePhrase(change, l);

  it('title and description', () => {
    expect(p({ field: 'title', from: 'Old', to: 'New' })).toBe('changed the title from “Old” to “New”');
    expect(p({ field: 'title' })).toBe('changed the title');
    expect(p({ field: 'description' })).toBe('edited the description');
    const long = 'x'.repeat(200);
    expect(p({ field: 'title', from: long, to: 'New' })).toBe(`changed the title from “${'x'.repeat(79)}…” to “New”`);
  });

  it('status and priority use the snapshot labels, then lookups', () => {
    expect(p({ field: 'status', from: 3, to: 4, fromLabel: 'Todo', toLabel: 'Doing' })).toBe('changed status from Todo → Doing');
    expect(p({ field: 'status', from: 3, to: 4 })).toBe('changed status from Todo → In Progress');
    expect(p({ field: 'status', from: 98, to: 99 })).toBe('changed status from none → none');
    expect(p({ field: 'priority', from: 0, to: 4 })).toBe('changed priority from No priority → Urgent');
    expect(p({ field: 'priority', from: 2, to: 1, fromLabel: 'Medium', toLabel: 'Low' })).toBe('changed priority from Medium → Low');
  });

  it('epic: set, removed, changed, deleted', () => {
    expect(p({ field: 'epic', from: null, to: 7, fromLabel: null, toLabel: 'Design system' })).toBe('set the epic to “Design system”');
    expect(p({ field: 'epic', from: 7, to: null })).toBe('removed the epic “Design system”');
    expect(p({ field: 'epic', from: 7, to: 9, fromLabel: 'Design system', toLabel: 'Content' })).toBe(
      'changed the epic from “Design system” to “Content”',
    );
    expect(p({ field: 'epic', from: 42, to: null, fromLabel: null })).toBe('removed the epic');
    expect(p({ field: 'epic', from: 42, to: 7, toLabel: 'Design system' })).toBe('changed the epic from a deleted epic to “Design system”');
  });

  it('dates', () => {
    expect(p({ field: 'dueDate', from: null, to: '2026-10-20' })).toBe(`set the due date to ${formatDate('2026-10-20')}`);
    expect(p({ field: 'dueDate', from: '2026-10-20', to: null })).toBe('removed the due date');
    expect(p({ field: 'startDate', from: '2026-10-20', to: '2026-10-22' })).toBe(
      `changed the start date from ${formatDate('2026-10-20')} to ${formatDate('2026-10-22')}`,
    );
  });

  it('blockers (task dependencies)', () => {
    expect(p({ field: 'blockedBy', added: ['WEB-3'], removed: [] })).toBe('made it wait on WEB-3');
    expect(p({ field: 'blockedBy', added: [], removed: ['WEB-3'] })).toBe('removed the link to WEB-3');
  });

  it('estimate in the configured unit', () => {
    expect(p({ field: 'estimate', from: null, to: 3 })).toBe('set the estimate to 3 pts');
    expect(p({ field: 'estimate', from: 1, to: 1.5 }, { settings: { estimateUnit: 'hours' } })).toBe('changed the estimate from 1h to 1.5h');
    expect(p({ field: 'estimate', from: 5, to: null })).toBe('removed the estimate');
  });

  it('tags', () => {
    expect(p({ field: 'tags', added: ['bug', 'idea'], removed: [] })).toBe('added tags bug, idea');
    expect(p({ field: 'tags', added: ['bug'], removed: ['idea'] })).toBe('added tag bug and removed tag idea');
    expect(p({ field: 'tags', added: [], removed: ['quick win'] })).toBe('removed tag quick win');
    expect(p({ field: 'tags' })).toBe('changed the tags');
  });

  it('archived and unknown fields', () => {
    expect(p({ field: 'archived', from: false, to: true })).toBe('archived the task');
    expect(p({ field: 'archived', from: true, to: false })).toBe('restored the task from the archive');
    expect(p({ field: 'someNewField', from: 1, to: 2 })).toBe('changed some new field');
  });
});

describe('activityTask / activityDetail', () => {
  it('prefers the live task, falls back to the snapshot for deleted tasks', () => {
    expect(activityTask(entry('comment.created', {}, { task: { id: 5, ref: 'WEB-3', title: 'Now' } }))).toEqual({
      id: 5,
      ref: 'WEB-3',
      title: 'Now',
    });
    expect(activityTask(entry('task.deleted', { ref: 'WEB-3', title: 'Gone' }, { taskId: null }))).toEqual({
      id: null,
      ref: 'WEB-3',
      title: 'Gone',
    });
    expect(activityTask(entry('task.deleted', {}, { taskId: null }))).toBeNull();
    expect(activityTask(entry('epic.created', { name: 'E' }))).toBeNull();
  });

  it('returns a plain-text comment excerpt or the work-log note', () => {
    expect(activityDetail(entry('comment.created', { excerpt: 'Looks **good** — see [docs](https://x.y)' }))).toBe('Looks good — see docs');
    expect(activityDetail(entry('comment.deleted', { excerpt: 'x' }))).toBeNull();
    expect(activityDetail(entry('worklog.created', { minutes: 5, note: 'Pairing' }))).toBe('Pairing');
    expect(activityDetail(entry('worklog.created', { minutes: 5, note: '' }))).toBeNull();
    expect(activityDetail(entry('task.created'))).toBeNull();
  });
});

describe('joinList', () => {
  it('uses English conjunctions', () => {
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c');
  });
});

describe('groupByDay', () => {
  it('keeps order and splits on date changes', () => {
    const items = [
      { d: '2026-10-13', n: 1 },
      { d: '2026-10-13', n: 2 },
      { d: '2026-10-12', n: 3 },
      { d: '2026-10-10', n: 4 },
    ];
    expect(groupByDay(items, (i) => i.d)).toEqual([
      { date: '2026-10-13', items: [items[0], items[1]] },
      { date: '2026-10-12', items: [items[2]] },
      { date: '2026-10-10', items: [items[3]] },
    ]);
    expect(groupByDay([], (i: { d: string }) => i.d)).toEqual([]);
  });
});

describe('groupActivityRuns', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();
  const e = (id: number, min: number, actor: ActivityDTO['actor'] = ALEX) => entry('task.updated', {}, { id, createdAt: at(min), actor });

  it('groups consecutive entries by the same actor within the window', () => {
    const sam = { id: 2, displayName: 'Sam' };
    const runs = groupActivityRuns([e(1, 0), e(2, 3), e(3, 7), e(4, 20), e(5, 21, sam), e(6, 22)]);
    expect(runs.map((r) => r.entries.map((x) => x.id))).toEqual([[1, 2, 3], [4], [5], [6]]);
    expect(runs[0]).toMatchObject({ key: 1, actor: ALEX, lastAt: at(7) });
  });

  it('treats unknown actors as one actor and respects a custom window', () => {
    expect(groupActivityRuns([e(1, 0, null), e(2, 1, null)]).length).toBe(1);
    expect(groupActivityRuns([e(1, 0), e(2, 2)], 60_000).length).toBe(2);
    expect(groupActivityRuns([])).toEqual([]);
  });
});
