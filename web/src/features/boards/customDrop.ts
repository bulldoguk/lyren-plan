// Custom column / lane helpers for the config panel: a drop patch suggested by a match filter
// ("pre-filled from the match when it pins one value") and warnings when a drop patch would
// not land a task in its column. Pure; unit-tested in customDrop.test.ts.

import { resolveDropPatch, type DropPatch } from '@shared/board';
import type { DuePreset } from '@shared/constants';
import { matchesTaskFilter, type FilterContext } from '@shared/filter';
import type { TaskFilter } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import type { BoardLookups } from './grouping';

const DUE_FROM_PRESET: Partial<Record<DuePreset, NonNullable<DropPatch['due']>>> = {
  today: 'today',
  tomorrow: 'tomorrow',
  next_week: 'next_week',
  no_date: 'clear',
};

/** The drop patch implied by a match filter that pins single values (status, priority, epic, project, tags, due, archived). */
export function dropPatchFromMatch(match: TaskFilter, lookups: Pick<BoardLookups, 'statuses' | 'epicById'>): DropPatch {
  const p: DropPatch = {};
  if (match.statusIds?.length === 1) p.statusId = match.statusIds[0]!;
  else if (!match.statusIds?.length && match.statusCategories?.length === 1) {
    const first = lookups.statuses.find((s) => s.category === match.statusCategories![0]);
    if (first) p.statusId = first.id;
  }
  if (match.priorities?.length === 1) p.priority = match.priorities[0]!;
  if (match.projectIds?.length === 1) p.projectId = match.projectIds[0]!;
  if (match.epicIds?.length === 1) {
    const epicId = match.epicIds[0]!;
    const epic = epicId === null ? undefined : lookups.epicById.get(epicId);
    if (epicId === null || (epic && (p.projectId === undefined || epic.projectId === p.projectId))) p.epicId = epicId;
  }
  const wanted = (match.tagIds ?? []).filter((id): id is number => id !== null);
  if ((match.tagMode ?? 'any') === 'all' ? wanted.length > 0 : wanted.length === 1) p.addTagIds = wanted;
  if (match.due?.length === 1) {
    const due = DUE_FROM_PRESET[match.due[0]!];
    if (due) p.due = due;
  }
  if (match.archived === 'only') p.archived = true;
  return p;
}

type Criterion = keyof TaskFilter;

/** Which task field(s) a criterion looks at, for wording and "does the drop set it?". */
const CRITERIA: Array<{ keys: Criterion[]; field: string; sets: (p: DropPatch) => boolean }> = [
  { keys: ['statusIds', 'statusCategories', 'closedWithinDays'], field: 'status', sets: (p) => p.statusId !== undefined },
  { keys: ['priorities'], field: 'priority', sets: (p) => p.priority !== undefined },
  { keys: ['projectIds'], field: 'project', sets: (p) => p.projectId !== undefined },
  { keys: ['epicIds', 'milestoneIds'], field: 'epic', sets: (p) => p.epicId !== undefined },
  { keys: ['tagIds', 'excludeTagIds'], field: 'tags', sets: (p) => (p.addTagIds?.length ?? 0) > 0 || (p.removeTagIds?.length ?? 0) > 0 },
  { keys: ['due', 'dueFrom', 'dueTo'], field: 'due date', sets: (p) => p.due !== undefined || p.dueDate !== undefined },
  { keys: ['archived'], field: 'archived state', sets: (p) => p.archived !== undefined },
];

function present(match: TaskFilter, key: Criterion): boolean {
  const v = match[key];
  if (v === undefined || v === null || v === false || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return !(key === 'tagMode');
}

/**
 * Warnings when tasks dropped here would not (reliably) match the column. A criterion the drop
 * doesn't set depends on the task ("keeps its …"); a criterion it sets is checked on a probe task.
 */
export function dropPatchWarnings(
  match: TaskFilter,
  onDrop: DropPatch,
  ctx: { lookups: Pick<BoardLookups, 'epicById' | 'tagById'>; fctx: FilterContext },
): string[] {
  const warnings: string[] = [];
  if (match.search?.trim()) warnings.push('A drop can’t make a task match the search text.');
  const patch = resolveDropPatch(onDrop, ctx.fctx.today, ctx.fctx.weekStartsOn);
  const epic = typeof patch.epicId === 'number' ? ctx.lookups.epicById.get(patch.epicId) : undefined;
  const probe: TaskDTO = {
    id: 0,
    projectId: patch.projectId ?? epic?.projectId ?? 0,
    number: 0,
    ref: '',
    epicId: patch.epicId ?? null,
    milestoneId: epic?.milestoneId ?? null,
    statusId: patch.statusId ?? 0,
    priority: patch.priority ?? 0,
    title: '',
    description: '',
    startDate: null,
    dueDate: patch.dueDate ?? null,
    estimate: null,
    rank: '',
    completedAt: null,
    archivedAt: patch.archived ? '1970-01-01T00:00:00.000Z' : null,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
    tags: (patch.addTagIds ?? []).map((id) => ({ id, name: ctx.lookups.tagById.get(id)?.name ?? '', color: '#000000' })),
    commentCount: 0,
    worklogMinutes: 0,
    blockedBy: [],
    blocks: [],
    adjustedStartDate: null,
    adjustedDueDate: patch.dueDate ?? null,
    slipDays: 0,
  };
  for (const c of CRITERIA) {
    const keys = c.keys.filter((k) => present(match, k));
    if (keys.length === 0) continue;
    if (!c.sets(onDrop)) {
      warnings.push(`Dropped tasks keep their ${c.field}, so they land here only if it already matches.`);
      continue;
    }
    const sub: TaskFilter = { archived: 'include', includeArchivedProjects: true };
    for (const k of keys) (sub as Record<string, unknown>)[k] = match[k];
    if (keys.includes('tagIds') && match.tagMode) sub.tagMode = match.tagMode;
    if (!matchesTaskFilter(probe, sub, ctx.fctx)) warnings.push(`The drop sets the ${c.field} to a value this group doesn’t match.`);
  }
  return warnings;
}
