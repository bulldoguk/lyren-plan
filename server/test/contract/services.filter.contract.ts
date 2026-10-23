// Randomized cross-check: the SQL in services/tasks.ts must select and order exactly
// what the reference implementation (shared/src/filter.ts) does, on any Db (design §14.4): run on NodeDb by
// server/test/services.filter.test.ts and on DoDb in workerd by server/test-workers/services.test.ts. Every
// test builds the same world (a fixed seed) on a database of its own.

import { describe, expect, it } from 'vitest';
import { DUE_PRESETS, STATUS_CATEGORIES, type Priority, type StatusCategory } from '@shared/constants';
import { addDays, type WeekStart } from '@shared/dates';
import { buildFilterContext, compareTasks, matchesTaskFilter, type SortContext } from '@shared/filter';
import { TASK_SORT_FIELDS, taskFilterSchema, type TaskFilter, type TaskSort } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import type { Db } from '../../src/db';
import type { StatusRow, TaskRow } from '../../src/services/rows';
import { findTaskByRef, hydrateTasks, queryTasks } from '../../src/services/tasks';
import {
  insertEpic,
  insertMilestone,
  insertProject,
  insertStatus,
  insertTag,
  insertTask,
  prng,
  type SpaceDb,
  type WithSpaceDb,
} from './fixtures';

const NOW_MS = Date.parse('2026-03-15T12:00:00.000Z');
const DAY_MS = 86_400_000;
const TODAYS = ['2026-03-15', '2026-03-16', '2026-03-12', '2026-03-21'];

const WORDS = [
  'Ärger', 'ärger', 'ÉTÉ', 'été', 'Straße', 'alpha', 'Alpha', 'BETA', 'beta', 'Gamma', 'ΣΊΣΥΦΟΣ', 'σίσυφος',
  'naïve', 'İstanbul', 'login', 'Login-Bug', 'fix', 'FIX', 'deploy', 'Zebra', 'zebra', '🚀', 'web', 'API', 'café',
];
const SEARCHES = [
  'ärger', 'ÄRGER', 'été', 'ÉTÉ', 'straße', 'STRASSE', 'σίσυφος', 'ς', 'naïve', 'i̇stanbul', 'istanbul',
  'login bug', 'Login-Bug', 'fix deploy', 'alp', 'web-1', 'web-', '-1', 'Web-12', 'gam-3', 'zebra   🚀',
  'api café', 'nothing-matches', '  ', 'a', 'é', 'bug\tfix', 'delta-2',
];

interface World {
  db: Db;
  /** The tasks as of the server's date. */
  tasks: TaskDTO[];
  /** The tasks as of `today`: their adjusted dates depend on it (task dependencies). */
  at: (today: string) => TaskDTO[];
  /** Draws the slipped criterion of randomFilter. */
  slipRnd: ReturnType<typeof prng>;
  statuses: StatusRow[];
  projects: Array<{ id: number; status: 'active' | 'on_hold' | 'completed' | 'archived' }>;
  projectIds: number[];
  milestoneIds: number[];
  epicIds: number[];
  statusIds: number[];
  tagIds: number[];
}

function buildWorld({ db }: SpaceDb): World {
  const rnd = prng(20261013);

  // Extra statuses (one shares a position with 'Todo' to exercise status-sort ties).
  insertStatus(db, 'Icebox', 'backlog', 1);
  insertStatus(db, 'Blocked', 'started');
  insertStatus(db, 'Shipped', 'completed');
  insertStatus(db, "Won't fix", 'cancelled');
  const statuses = db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id');

  const projectIds = [
    insertProject(db, 'WEB'),
    insertProject(db, 'APP', { status: 'on_hold' }),
    insertProject(db, 'GAM', { status: 'archived' }),
    insertProject(db, 'DELTA', { status: 'completed' }),
  ];
  const milestoneIds: number[] = [];
  const epicsByProject = new Map<number, number[]>();
  for (const projectId of projectIds) {
    const ms = Array.from({ length: rnd.int(0, 2) }, () => insertMilestone(db, projectId));
    milestoneIds.push(...ms);
    const epics = Array.from({ length: rnd.int(1, 3) }, () =>
      insertEpic(db, projectId, { milestoneId: ms.length > 0 && rnd.chance(0.7) ? rnd.pick(ms) : null }),
    );
    epicsByProject.set(projectId, epics);
  }
  const epicIds = [...epicsByProject.values()].flat();
  const tagIds = ['bug', 'Ärger', 'été', 'Zeta', 'alpha', 'Beta'].map((n) => insertTag(db, n));

  const timestamps = Array.from({ length: 12 }, (_, i) => new Date(NOW_MS - i * 3_600_000 * 7).toISOString());
  const dateAround = () => addDays('2026-03-15', rnd.int(-20, 40));
  const closedCategory = (statusId: number) =>
    ['completed', 'cancelled'].includes(statuses.find((s) => s.id === statusId)!.category);

  for (let i = 0; i < 220; i++) {
    const projectId = rnd.pick(projectIds);
    const status = rnd.pick(statuses);
    const closed = closedCategory(status.id);
    let completedAt: string | null = null;
    if (closed) {
      const r = rnd.next();
      if (r < 0.12) completedAt = null; // closed without completedAt counts as recent
      else if (r < 0.3) {
        // Exactly on (or 1 ms around) a closedWithinDays cutoff.
        const days = rnd.pick([1, 7, 30]);
        completedAt = new Date(NOW_MS - days * DAY_MS + rnd.pick([-1, 0, 1])).toISOString();
      } else completedAt = new Date(NOW_MS - Math.floor(rnd.next() * 60 * DAY_MS)).toISOString();
    } else if (rnd.chance(0.05)) {
      completedAt = new Date(NOW_MS - 90 * DAY_MS).toISOString(); // inconsistent data must be ignored
    }
    const title = Array.from({ length: rnd.int(1, 4) }, () => rnd.pick(WORDS)).join(rnd.pick([' ', ' ', '-', '  ']));
    insertTask(db, {
      projectId,
      statusId: status.id,
      epicId: rnd.chance(0.65) ? rnd.pick(epicsByProject.get(projectId)!) : null,
      title,
      description: rnd.chance(0.5) ? Array.from({ length: rnd.int(1, 6) }, () => rnd.pick(WORDS)).join(' ') : '',
      priority: rnd.int(0, 4) as Priority,
      startDate: rnd.chance(0.4) ? dateAround() : null,
      dueDate: rnd.chance(0.65) ? dateAround() : null,
      estimate: rnd.chance(0.6) ? rnd.pick([0, 1, 2.5, 3, 8, 13]) : null,
      completedAt,
      archivedAt: rnd.chance(0.15) ? rnd.pick(timestamps) : null,
      createdAt: rnd.pick(timestamps),
      updatedAt: rnd.pick(timestamps),
      tagIds: rnd.subset(tagIds, 0.2).slice(0, 3),
    });
  }
  // Duplicate ranks (legacy data) to exercise the (rank, id) tie-break.
  const ids = db.all<{ id: number }>('SELECT id FROM tasks').map((r) => r.id);
  for (let i = 0; i < 12; i++) {
    db.run('UPDATE tasks SET rank = (SELECT rank FROM tasks WHERE id = :src) WHERE id = :dst', {
      src: rnd.pick(ids),
      dst: rnd.pick(ids),
    });
  }

  // Task dependencies: links from lower to higher ids (so they never loop), some of them in chains, so the
  // adjusted due dates (and the slipped filter) are exercised against the reference too.
  for (let i = 0; i < 80; i++) {
    const [a, b] = [rnd.pick(ids), rnd.pick(ids)].sort((x, y) => x - y);
    if (a === b) continue;
    db.run('INSERT OR IGNORE INTO task_links (blocker_id, blocked_id, created_at) VALUES (:a, :b, :t)', { a, b, t: timestamps[0]! });
  }

  const rows = db.all<TaskRow>('SELECT * FROM tasks ORDER BY id');
  const byDay = new Map<string, TaskDTO[]>();
  const at = (today: string): TaskDTO[] => {
    if (!byDay.has(today)) byDay.set(today, hydrateTasks(db, rows, today));
    return byDay.get(today)!;
  };
  const projects = db.all<{ id: number; status: World['projects'][number]['status'] }>('SELECT id, status FROM projects');
  return {
    db,
    tasks: hydrateTasks(db, rows),
    at,
    slipRnd: prng(4242),
    statuses,
    projects,
    projectIds,
    milestoneIds,
    epicIds,
    statusIds: statuses.map((s) => s.id),
    tagIds,
  };
}

function randomFilter(rnd: ReturnType<typeof prng>, w: World): TaskFilter {
  const f: TaskFilter = {};
  const p = 0.3;
  const UNKNOWN = 99_999;
  const ids = (pool: number[], nullable: boolean): Array<number | null> => {
    const out: Array<number | null> = rnd.subset(pool, 0.35);
    if (nullable && rnd.chance(0.35)) out.push(null);
    if (rnd.chance(0.1)) out.push(UNKNOWN);
    if (rnd.chance(0.1) && out.length > 0) out.push(out[0]!); // duplicates are harmless
    return out;
  };
  const strictIds = (pool: number[]) => ids(pool, false).filter((id): id is number => id !== null);
  if (rnd.chance(0.1)) f.ids = strictIds(w.tasks.map((t) => t.id));
  if (rnd.chance(p)) f.projectIds = strictIds(w.projectIds);
  if (rnd.chance(p)) f.milestoneIds = rnd.chance(0.15) ? [null] : ids(w.milestoneIds, true);
  if (rnd.chance(p)) f.epicIds = rnd.chance(0.15) ? [null] : ids(w.epicIds, true);
  if (rnd.chance(p)) f.statusIds = strictIds(w.statusIds);
  if (rnd.chance(p)) f.statusCategories = rnd.subset(STATUS_CATEGORIES, 0.4) as StatusCategory[];
  if (rnd.chance(p)) f.priorities = rnd.subset([0, 1, 2, 3, 4] as Priority[], 0.4);
  if (rnd.chance(0.4)) {
    f.tagIds = rnd.chance(0.15) ? [null] : ids(w.tagIds, true);
    if (rnd.chance(0.7)) f.tagMode = rnd.pick(['any', 'all'] as const);
  }
  if (rnd.chance(0.2)) f.excludeTagIds = strictIds(w.tagIds);
  if (rnd.chance(0.35)) f.due = rnd.subset(DUE_PRESETS, 0.25);
  if (rnd.chance(0.15)) f.dueFrom = addDays('2026-03-15', rnd.int(-25, 30));
  if (rnd.chance(0.15)) f.dueTo = addDays('2026-03-15', rnd.int(-10, 45));
  if (rnd.chance(0.3)) f.search = rnd.pick(SEARCHES);
  if (rnd.chance(0.45)) f.archived = rnd.pick(['exclude', 'include', 'only'] as const);
  if (rnd.chance(0.35)) f.closedWithinDays = rnd.pick([null, 0, 1, 7, 14, 30, 90]);
  if (rnd.chance(0.3)) f.includeArchivedProjects = rnd.chance(0.6);
  // From a generator of its own, so the other criteria draw the same values as before links existed.
  if (w.slipRnd.chance(0.15)) f.slipped = w.slipRnd.chance(0.8);
  return f;
}

function contexts(w: World, today: string, weekStartsOn: WeekStart) {
  const fctx = buildFilterContext({ statuses: w.statuses, projects: w.projects, today, weekStartsOn, nowMs: NOW_MS });
  const sctx: SortContext = { statusPositionById: new Map(w.statuses.map((s) => [s.id, s.position])) };
  return { fctx, sctx };
}

export function defineFilterContract(kind: string, withSpaceDb: WithSpaceDb): void {
  const withWorld = <T>(body: (w: World) => T) => withSpaceDb((space) => body(buildWorld(space)));

  describe(`task filter SQL ≡ matchesTaskFilter (${kind})`, () => {
    it('hydrates every task (sanity)', () =>
      withWorld((w) => {
        expect(w.tasks).toHaveLength(220);
        expect(w.tasks.some((t) => t.tags.length > 1)).toBe(true);
        expect(w.tasks.some((t) => t.milestoneId !== null)).toBe(true);
        expect(w.at(TODAYS[0]!).filter((t) => t.slipDays > 0).length).toBeGreaterThan(5);
      }));

    it('selects the same set for 600 random filters', () =>
      withWorld((w) => {
        const rnd = prng(42);
        let nonEmpty = 0;
        let narrowed = 0;
        for (let i = 0; i < 600; i++) {
          const filter = taskFilterSchema.parse(randomFilter(rnd, w));
          const today = rnd.pick(TODAYS);
          const weekStartsOn = rnd.pick([0, 1] as const);
          const { fctx } = contexts(w, today, weekStartsOn);
          const expected = w.at(today).filter((t) => matchesTaskFilter(t, filter, fctx)).map((t) => t.id).sort((a, b) => a - b);
          const result = queryTasks(w.db, { filter, today, weekStartsOn, limit: 5000 }, { nowMs: NOW_MS });
          const actual = result.tasks.map((t) => t.id).sort((a, b) => a - b);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
              `Mismatch for filter ${JSON.stringify(filter)} today=${today} ws=${weekStartsOn}\n` +
                `missing in SQL: ${expected.filter((id) => !actual.includes(id)).join(',')}\n` +
                `extra in SQL: ${actual.filter((id) => !expected.includes(id)).join(',')}`,
            );
          }
          expect(result.total).toBe(expected.length);
          if (expected.length > 0) nonEmpty++;
          if (expected.length > 0 && expected.length < 150) narrowed++;
        }
        // The generator must actually exercise the filters (not only empty / full results).
        expect(nonEmpty).toBeGreaterThan(200);
        expect(narrowed).toBeGreaterThan(150);
      }));

    it('handles every single criterion on its own, incl. edge values', () =>
      withWorld((w) => {
        const filters: TaskFilter[] = [
          {},
          { ids: [] },
          { ids: [w.tasks[0]!.id, w.tasks[5]!.id, 99_999] },
          { ids: w.tasks.slice(0, 40).map((t) => t.id), archived: 'include', includeArchivedProjects: true },
          { projectIds: [] },
          { projectIds: [w.projectIds[2]!] },
          { includeArchivedProjects: true },
          { milestoneIds: [null] },
          { epicIds: [null] },
          { tagIds: [null] },
          { tagIds: [null], tagMode: 'all' },
          { tagIds: [null, w.tagIds[0]!], tagMode: 'all' },
          { tagIds: [null, w.tagIds[0]!], tagMode: 'any' },
          { tagIds: [w.tagIds[0]!, w.tagIds[1]!], tagMode: 'all' },
          { tagIds: [w.tagIds[0]!, w.tagIds[0]!], tagMode: 'all' },
          { excludeTagIds: [w.tagIds[0]!, w.tagIds[2]!] },
          ...DUE_PRESETS.map((d) => ({ due: [d] })),
          { due: ['overdue', 'no_date'] },
          { dueFrom: '2026-03-15' },
          { dueTo: '2026-03-15' },
          { dueFrom: '2026-03-20', dueTo: '2026-03-10' },
          { archived: 'only' },
          { archived: 'include' },
          { closedWithinDays: 0 },
          { closedWithinDays: 1 },
          { closedWithinDays: 7 },
          { closedWithinDays: 30 },
          { closedWithinDays: null },
          { search: 'ÄRGER été' },
          { search: 'σίσυφος' },
          { search: 'ς' },
          { search: 'web-1' },
          { slipped: true },
          { slipped: false },
          { slipped: true, due: ['overdue'] },
        ];
        for (const today of TODAYS) {
          for (const weekStartsOn of [0, 1] as const) {
            const { fctx } = contexts(w, today, weekStartsOn);
            for (const filter of filters) {
              const expected = w.at(today).filter((t) => matchesTaskFilter(t, filter, fctx)).map((t) => t.id);
              const actual = queryTasks(w.db, { filter, today, weekStartsOn, limit: 5000 }, { nowMs: NOW_MS }).tasks.map(
                (t) => t.id,
              );
              expect({ filter, today, ids: [...actual].sort((a, b) => a - b) }).toEqual({
                filter,
                today,
                ids: [...expected].sort((a, b) => a - b),
              });
            }
          }
        }
      }));
  });

  describe(`task sort SQL ≡ compareTasks (${kind})`, () => {
    it('orders identically for every field and direction', () =>
      withWorld((w) => {
        const rnd = prng(7);
        const all: TaskFilter = { archived: 'include', includeArchivedProjects: true };
        const { sctx } = contexts(w, '2026-03-15', 1);
        for (const field of TASK_SORT_FIELDS) {
          for (const dir of ['asc', 'desc'] as const) {
            const sort: TaskSort = { field, dir };
            const expected = [...w.tasks].sort((a, b) => compareTasks(a, b, sort, sctx)).map((t) => t.id);
            const actual = queryTasks(w.db, { filter: all, sort, limit: 5000 }, { nowMs: NOW_MS }).tasks.map((t) => t.id);
            expect({ sort, actual }).toEqual({ sort, actual: expected });
          }
        }
        // Random filter + sort combinations, plus pagination.
        for (let i = 0; i < 300; i++) {
          const filter = randomFilter(rnd, w);
          const sort: TaskSort = { field: rnd.pick(TASK_SORT_FIELDS), dir: rnd.pick(['asc', 'desc'] as const) };
          const today = rnd.pick(TODAYS);
          const weekStartsOn = rnd.pick([0, 1] as const);
          const { fctx } = contexts(w, today, weekStartsOn);
          const expected = w
            .at(today)
            .filter((t) => matchesTaskFilter(t, filter, fctx))
            .sort((a, b) => compareTasks(a, b, sort, sctx))
            .map((t) => t.id);
          const limit = rnd.pick([1, 5, 20, 5000]);
          const offset = rnd.pick([0, 0, 3, 17, 400]);
          const result = queryTasks(w.db, { filter, sort, today, weekStartsOn, limit, offset }, { nowMs: NOW_MS });
          expect({ filter, sort, ids: result.tasks.map((t) => t.id) }).toEqual({
            filter,
            sort,
            ids: expected.slice(offset, offset + limit),
          });
          expect(result.total).toBe(expected.length);
        }
      }));

    it('defaults: manual order, archived tasks and archived projects hidden', () =>
      withWorld((w) => {
        const { fctx, sctx } = contexts(w, '2026-03-15', 1);
        const expected = w.tasks
          .filter((t) => matchesTaskFilter(t, {}, fctx))
          .sort((a, b) => compareTasks(a, b, { field: 'manual', dir: 'asc' }, sctx))
          .map((t) => t.id);
        expect(queryTasks(w.db, {}, { nowMs: NOW_MS }).tasks.map((t) => t.id)).toEqual(expected);
      }));
  });

  describe(`hydration and refs (${kind})`, () => {
    it('returns DTOs with sorted tags, milestone via epic and refs', () =>
      withWorld((w) => {
        for (const t of w.tasks) {
          const names = t.tags.map((g) => g.name);
          expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
          expect(t.ref).toMatch(/^[A-Z]+-\d+$/);
        }
      }));

    it('finds tasks by case-insensitive ref', () =>
      withWorld((w) => {
        const task = w.tasks.find((t) => t.ref.startsWith('WEB-'))!;
        expect(findTaskByRef(w.db, task.ref.toLowerCase())?.id).toBe(task.id);
        expect(findTaskByRef(w.db, ` ${task.ref} `)?.id).toBe(task.id);
        expect(findTaskByRef(w.db, 'WEB-99999')).toBeNull();
        expect(findTaskByRef(w.db, 'nonsense')).toBeNull();
        expect(findTaskByRef(w.db, 'WEB-0')).toBeNull();
      }));
  });
}
