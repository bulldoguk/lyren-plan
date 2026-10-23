import { describe, expect, it } from 'vitest';
import {
  activePrefs,
  boardConfigSchema,
  customGroupKey,
  defaultBoardConfig,
  IMPORT_REPAIR_COLUMNS,
  parseBoardConfigLenient,
  remapBoardConfigIds,
  resolveDropPatch,
  updateActivePrefs,
} from './board';
import { buildFilterContext, matchesTaskFilter } from './filter';
import type { TaskDTO } from './types';

const task = (over: Partial<TaskDTO> = {}): TaskDTO => ({
  id: 1, projectId: 1, number: 1, ref: 'P-1', epicId: null, milestoneId: null, statusId: 1, priority: 0,
  title: 't', description: '', startDate: null, dueDate: null, estimate: null, rank: 'a0', completedAt: null,
  archivedAt: null, createdBy: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [], commentCount: 0, worklogMinutes: 0, blockedBy: [], blocks: [], adjustedStartDate: null,
  adjustedDueDate: null, slipDays: 0, ...over,
});

const ctx = buildFilterContext({
  statuses: [{ id: 1, category: 'unstarted' }, { id: 2, category: 'completed' }],
  projects: [{ id: 1, status: 'archived' }],
  today: '2026-10-13',
  weekStartsOn: 1,
  nowMs: Date.parse('2026-10-13T12:00:00Z'),
});

describe('board config', () => {
  it('fills defaults and keeps prefs per groupBy field', () => {
    let cfg = defaultBoardConfig();
    expect(cfg.columns.groupBy).toBe('status');
    cfg = updateActivePrefs(cfg, 'columns', { hidden: ['2'] });
    cfg = { ...cfg, columns: { ...cfg.columns, groupBy: 'priority' } };
    expect(activePrefs(cfg.columns).hidden).toEqual([]);
    cfg = { ...cfg, columns: { ...cfg.columns, groupBy: 'status' } };
    expect(activePrefs(cfg.columns).hidden).toEqual(['2']);
  });

  it('normalizes clashing swimlanes', () => {
    expect(defaultBoardConfig({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'statusCategory' } }).swimlanes.groupBy).toBe('none');
    expect(defaultBoardConfig({ columns: { groupBy: 'tag' }, swimlanes: { groupBy: 'tag' } }).swimlanes.groupBy).toBe('none');
    expect(defaultBoardConfig({ columns: { groupBy: 'status' }, swimlanes: { groupBy: 'project' } }).swimlanes.groupBy).toBe('project');
  });

  it('dedupes custom column ids and rejects reserved ids', () => {
    const cfg = defaultBoardConfig({
      columns: { groupBy: 'custom', custom: [{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }] },
    });
    expect(cfg.columns.custom.map((c) => c.name)).toEqual(['A']);
    expect(boardConfigSchema.safeParse({ columns: { custom: [{ id: '__other', name: 'x' }] } }).success).toBe(false);
  });

  it('parses leniently section by section', () => {
    const cfg = parseBoardConfigLenient({
      layout: 'list',
      sort: { field: 'bogus' },
      columns: { groupBy: 'priority', custom: [{ id: 'ok', name: 'Ok' }, { id: '!!', name: 'bad' }] },
    });
    expect(cfg.layout).toBe('list');
    expect(cfg.sort).toEqual({ field: 'manual', dir: 'asc' });
    expect(cfg.columns.groupBy).toBe('priority');
    expect(cfg.columns.custom.map((c) => c.id)).toEqual(['ok']);
    expect(parseBoardConfigLenient('garbage').columns.groupBy).toBe('status');
  });

  it('lenient parsing keeps an axis whose prefs name fields it does not have, and gives up on a long custom list', () => {
    const order = { order: ['3'], hidden: [], collapsed: [], wipLimits: {} };
    const cfg = parseBoardConfigLenient({
      columns: { groupBy: 'tag', prefs: { tag: { order: ['3'] }, bogus: {}, none: { order: ['1'] } } },
      swimlanes: { groupBy: 'custom', custom: [...Array(199).fill({}), { id: 'x', name: 'X' }] },
    });
    expect(cfg.columns.groupBy).toBe('tag');
    expect(cfg.columns.prefs).toEqual({ tag: order });
    expect(cfg.swimlanes.custom.map((c) => c.id)).toEqual(['x']);
    const long = parseBoardConfigLenient({ swimlanes: { groupBy: 'custom', custom: [...Array(200).fill({}), { id: 'x', name: 'X' }] } });
    expect(long.swimlanes).toEqual(defaultBoardConfig().swimlanes);
  });

  it("an import's boards share one repair budget: once it is spent, an axis that needs repairs gets its defaults", () => {
    const broken = { layout: 'list', columns: { groupBy: 'custom', custom: [...Array(199).fill({}), { id: 'x', name: 'X' }] } };
    const budget = { columns: IMPORT_REPAIR_COLUMNS };
    const parsed = Array.from({ length: IMPORT_REPAIR_COLUMNS / 200 + 2 }, () => parseBoardConfigLenient(broken, budget));
    expect(budget.columns).toBe(0);
    expect(parsed.slice(0, IMPORT_REPAIR_COLUMNS / 200).every((c) => c.columns.custom.map((col) => col.id).join() === 'x')).toBe(true);
    // The rest of the config is still read leniently, and a valid config needs no budget.
    expect(parsed.at(-1)).toMatchObject({ layout: 'list', columns: defaultBoardConfig().columns });
    expect(parseBoardConfigLenient({ columns: { groupBy: 'custom', custom: [{ id: 'y', name: 'Y' }] } }, budget).columns.custom).toHaveLength(1);
    // A stored config (no budget) is repaired whatever came before.
    expect(parseBoardConfigLenient(broken).columns.custom.map((c) => c.id)).toEqual(['x']);
  });

  it('custom grouping ignores archive defaults', () => {
    const t = task({ archivedAt: '2026-10-01T00:00:00.000Z' });
    expect(matchesTaskFilter(t, {}, ctx)).toBe(false);
    expect(customGroupKey(t, [{ id: 'a', name: 'A', color: null, match: {}, onDrop: null }], ctx)).toBe('a');
    expect(customGroupKey(t, [{ id: 'a', name: 'A', color: null, match: { priorities: [4] }, onDrop: null }], ctx)).toBe('__other');
  });

  it('resolves drop patches', () => {
    expect(resolveDropPatch({ due: 'next_week', addTagIds: [1, 1] }, '2026-10-13', 1)).toEqual({ dueDate: '2026-10-19', addTagIds: [1] });
    expect(resolveDropPatch({ due: 'clear', statusId: 3 }, '2026-10-13', 1)).toEqual({ dueDate: null, statusId: 3 });
    expect(resolveDropPatch({ due: 'tomorrow' }, '2026-10-13', 0)).toEqual({ dueDate: '2026-10-14' });
  });

  it('remaps ids on merge and delete', () => {
    let cfg = defaultBoardConfig({
      filter: { tagIds: [5, 6] },
      columns: {
        groupBy: 'tag',
        prefs: { tag: { order: ['5', '7'], hidden: [], collapsed: ['5'], wipLimits: { '5': 3 } } },
        custom: [{ id: 'x', name: 'X', match: { tagIds: [5] }, onDrop: { addTagIds: [5], statusId: 2 } }],
      },
    });
    const merged = remapBoardConfigIds(cfg, 'tag', 5, 6);
    expect(merged.filter.tagIds).toEqual([6]);
    // The source group's display prefs are dropped; the target keeps its own (none here).
    expect(merged.columns.prefs.tag).toEqual({ order: ['7'], hidden: [], collapsed: [], wipLimits: {} });
    expect(merged.columns.custom[0]!.match.tagIds).toEqual([6]);
    expect(merged.columns.custom[0]!.onDrop).toEqual({ addTagIds: [6], statusId: 2 });
    const deleted = remapBoardConfigIds(cfg, 'status', 2, null);
    expect(deleted.columns.custom[0]!.onDrop).toEqual({ addTagIds: [5] });
    cfg = defaultBoardConfig();
    expect(remapBoardConfigIds(cfg, 'epic', 1, null)).toBe(cfg);
  });

  it('status reassignment never hides, collapses or limits the target group', () => {
    // Users commonly hide "Cancelled" (6); deleting it into "Done" (5) must leave Done visible.
    const cfg = defaultBoardConfig({
      columns: {
        groupBy: 'status',
        prefs: { status: { order: ['1', '6', '5'], hidden: ['6'], collapsed: ['6'], wipLimits: { '6': 2 } } },
      },
      swimlanes: { groupBy: 'custom', custom: [{ id: 'l', name: 'L', match: { statusIds: [6] }, onDrop: { statusId: 6 } }] },
    });
    const next = remapBoardConfigIds(cfg, 'status', 6, 5);
    expect(next.columns.prefs.status).toEqual({ order: ['1', '5'], hidden: [], collapsed: [], wipLimits: {} });
    expect(next.swimlanes.custom[0]!.match.statusIds).toEqual([5]);
    expect(next.swimlanes.custom[0]!.onDrop).toEqual({ statusId: 5 });
    // The target's own prefs are kept as they were.
    const own = defaultBoardConfig({
      columns: { groupBy: 'status', prefs: { status: { hidden: ['6'], collapsed: ['5'], wipLimits: { '5': 4, '6': 2 } } } },
    });
    expect(remapBoardConfigIds(own, 'status', 6, 5).columns.prefs.status).toEqual({
      order: [], hidden: [], collapsed: ['5'], wipLimits: { '5': 4 },
    });
  });

  it('tag merge keeps drop patches valid (adding the target wins over removing it)', () => {
    const A = 1;
    const B = 2;
    const cfg = defaultBoardConfig({
      columns: {
        groupBy: 'custom',
        custom: [
          { id: 'todo', name: 'To review', match: { tagIds: [A] }, onDrop: { addTagIds: [A], removeTagIds: [B] } },
          { id: 'done', name: 'Reviewed', match: { tagIds: [B] }, onDrop: { addTagIds: [B], removeTagIds: [A] } },
          { id: 'both', name: 'Both', match: {}, onDrop: { addTagIds: [3], removeTagIds: [A, B, 4] } },
        ],
      },
    });
    const next = remapBoardConfigIds(cfg, 'tag', A, B);
    expect(next.columns.custom.map((c) => c.onDrop)).toEqual([
      { addTagIds: [B] },
      { addTagIds: [B] },
      { addTagIds: [3], removeTagIds: [B, 4] },
    ]);
    expect(boardConfigSchema.safeParse(next).success).toBe(true);
    // Round-trips through the lenient reader without losing columns.
    expect(parseBoardConfigLenient(JSON.parse(JSON.stringify(next))).columns.custom.map((c) => c.id)).toEqual([
      'todo', 'done', 'both',
    ]);
  });

  it('lenient parsing repairs an invalid drop patch instead of dropping the column', () => {
    const cfg = parseBoardConfigLenient({
      columns: {
        groupBy: 'custom',
        custom: [
          { id: 'a', name: 'A', match: { tagIds: [2] }, onDrop: { addTagIds: [2], removeTagIds: [2, 3] } },
          { id: 'b', name: 'B', onDrop: { due: 'today', dueDate: '2026-10-20', priority: 3 } },
          { id: 'c', name: 'C', onDrop: { statusId: 'nope', priority: 2 } },
          { id: 'd', name: 'D', onDrop: 'garbage', color: 'red' },
          { id: 'e', name: 'E', match: { priorities: ['bogus'] } },
        ],
      },
      swimlanes: { groupBy: 'custom', custom: [{ id: 'x', name: 'X', onDrop: { addTagIds: [7], removeTagIds: [7] } }] },
    });
    expect(cfg.columns.custom.map((c) => [c.id, c.onDrop, c.color])).toEqual([
      ['a', { addTagIds: [2], removeTagIds: [3] }, null],
      ['b', { dueDate: '2026-10-20', priority: 3 }, null],
      ['c', { priority: 2 }, null],
      ['d', null, null],
    ]);
    expect(cfg.columns.custom[0]!.match.tagIds).toEqual([2]);
    expect(cfg.swimlanes.custom.map((c) => c.onDrop)).toEqual([{ addTagIds: [7] }]);
  });

  it('closedWithinDays semantics', () => {
    const closed = task({ statusId: 2, completedAt: '2026-10-13T12:00:00.000Z' });
    expect(matchesTaskFilter(closed, { closedWithinDays: 0, includeArchivedProjects: true }, ctx)).toBe(false);
    expect(matchesTaskFilter(closed, { closedWithinDays: 1, includeArchivedProjects: true }, ctx)).toBe(true);
    expect(matchesTaskFilter({ ...closed, completedAt: null }, { closedWithinDays: 1, includeArchivedProjects: true }, ctx)).toBe(true);
    expect(matchesTaskFilter({ ...closed, completedAt: '2026-10-10T00:00:00.000Z' }, { closedWithinDays: 2, includeArchivedProjects: true }, ctx)).toBe(false);
  });
});
