import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type Mutation,
  type Query,
  type QueryClient,
} from '@tanstack/react-query';
import { generateKeyBetween } from 'fractional-indexing';
import { isClosedCategory } from '@shared/constants';
import { localToday } from '@shared/dates';
import type {
  RebaselineInput,
  TaskBulkUpdateInput,
  TaskCreateInput,
  TaskQueryInput,
  TaskUpdateInput,
} from '@shared/schemas';
import type { BootstrapDTO, RebaselineItemDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import { useSpaceId } from '../app/space';
import { spaceApi } from './client';
import { invalidateTasks, qk } from './keys';

// ---- Queries -----------------------------------------------------------------

/**
 * POST /tasks/query. Keeps the previous result while a changed filter loads.
 * Pass `today` (localToday()) and weekStartsOn when the filter uses due presets.
 */
export function useTaskQuery(input: TaskQueryInput, opts: { enabled?: boolean } = {}) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: qk.taskQuery(sid, input),
    queryFn: () => spaceApi(sid).post<TaskQueryResult>('/tasks/query', input),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

/** Query options of one task (GET /tasks/:id), shared by useTask and batch lookups (useQueries). */
export function taskDetailQuery(spaceId: string, id: number) {
  // Today's date, for the adjusted dates of a task with blockers (docs/design/task-dependencies.md).
  return {
    queryKey: qk.task(spaceId, id),
    queryFn: () => spaceApi(spaceId).get<TaskDTO>(`/tasks/${id}?today=${localToday()}`),
  };
}

/** `enabled: false` keeps returning cached data without fetching (e.g. a drawer that is closing). */
export function useTask(id: number | null | undefined, opts: { enabled?: boolean } = {}) {
  const sid = useSpaceId();
  return useQuery({
    ...taskDetailQuery(sid, id ?? 0),
    enabled: typeof id === 'number' && id > 0 && (opts.enabled ?? true),
  });
}

/** Look up a task by its human reference, e.g. 'LYR-12'. */
export function useTaskByRef(ref: string | null | undefined) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: qk.taskByRef(sid, ref ?? ''),
    queryFn: () => spaceApi(sid).get<TaskDTO>(`/tasks/ref/${encodeURIComponent(ref ?? '')}`),
    enabled: !!ref,
  });
}

// ---- Optimistic helpers ----------------------------------------------------

type TaskPatch = TaskUpdateInput;

/** Apply the parts of a patch that can be predicted locally. Server response replaces it. */
export function applyTaskPatch(
  task: TaskDTO,
  patch: TaskPatch,
  boot: BootstrapDTO | undefined,
  neighbors?: { after?: TaskDTO; before?: TaskDTO; minRank?: string; maxRank?: string },
): TaskDTO {
  const next: TaskDTO = { ...task };
  let fieldsChanged = false;
  const set = <K extends keyof TaskDTO>(key: K, value: TaskDTO[K]) => {
    if (next[key] !== value) {
      next[key] = value;
      fieldsChanged = true;
    }
  };
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.priority !== undefined) set('priority', patch.priority);
  if (patch.startDate !== undefined) set('startDate', patch.startDate);
  if (patch.dueDate !== undefined) set('dueDate', patch.dueDate);
  // An unslipped task's adjusted dates are its own; a slipped one's wait for the server's answer.
  if (task.slipDays === 0) {
    next.adjustedStartDate = next.startDate;
    next.adjustedDueDate = next.dueDate;
  }
  if (patch.estimate !== undefined) set('estimate', patch.estimate);
  if (patch.archived !== undefined && patch.archived !== (task.archivedAt !== null)) {
    set('archivedAt', patch.archived ? new Date().toISOString() : null);
  }
  if (patch.statusId !== undefined && patch.statusId !== task.statusId) {
    set('statusId', patch.statusId);
    const from = boot?.statuses.find((s) => s.id === task.statusId);
    const to = boot?.statuses.find((s) => s.id === patch.statusId);
    if (from && to) {
      const wasClosed = isClosedCategory(from.category);
      const isClosed = isClosedCategory(to.category);
      if (!wasClosed && isClosed) next.completedAt = new Date().toISOString();
      if (wasClosed && !isClosed) next.completedAt = null;
    }
  }
  if (patch.projectId !== undefined && patch.projectId !== task.projectId) {
    set('projectId', patch.projectId);
    if (patch.epicId === undefined) {
      next.epicId = null;
      next.milestoneId = null;
    }
  }
  if (patch.epicId !== undefined && patch.epicId !== task.epicId) {
    set('epicId', patch.epicId);
    const epic = patch.epicId === null ? undefined : boot?.epics.find((e) => e.id === patch.epicId);
    next.milestoneId = epic?.milestoneId ?? null;
    if (epic) next.projectId = epic.projectId;
  }
  if (boot && (patch.tagIds || patch.addTagIds || patch.removeTagIds)) {
    let ids = patch.tagIds ? [...patch.tagIds] : task.tags.map((t) => t.id);
    if (patch.addTagIds) ids = [...new Set([...ids, ...patch.addTagIds])];
    if (patch.removeTagIds) ids = ids.filter((id) => !patch.removeTagIds!.includes(id));
    const tags = boot.tags
      .filter((t) => ids.includes(t.id))
      .map((t) => ({ id: t.id, name: t.name, color: t.color }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (tags.map((t) => t.id).join() !== task.tags.map((t) => t.id).join()) {
      next.tags = tags;
      fieldsChanged = true;
    }
  }
  // Rank (manual order). Rank-only changes don't bump updatedAt (same as the server).
  try {
    if (patch.position && typeof patch.position === 'object' && 'rank' in patch.position) next.rank = patch.position.rank;
    else if (patch.position === 'top' && neighbors?.minRank) next.rank = generateKeyBetween(null, neighbors.minRank);
    else if (patch.position === 'bottom' && neighbors?.maxRank) next.rank = generateKeyBetween(neighbors.maxRank, null);
    else if (patch.position && typeof patch.position === 'object' && neighbors) {
      const a = neighbors.after?.rank ?? null;
      const b = neighbors.before?.rank ?? null;
      if ((a !== null || b !== null) && (a === null || b === null || a < b)) next.rank = generateKeyBetween(a, b);
    }
  } catch {
    /* the server response will provide the real rank */
  }
  if (fieldsChanged) next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * The patch that puts back what `patch` changed on `task` (the copy from before the change),
 * for "Undo" toasts. Project and epic are restored together, because an epic of another
 * project moves the task and a project move clears the epic (the server gives a task that
 * returns to a project its old number there, so the ref comes back too). Tag edits restore the
 * full tag set. A `position` is undone with the task's old rank (`{ rank }`), which puts it
 * back exactly where it was among all tasks, not just among the ones a view shows.
 */
export function inverseTaskPatch(task: TaskDTO, patch: TaskPatch): TaskPatch {
  const undo: TaskPatch = {};
  if (patch.title !== undefined) undo.title = task.title;
  if (patch.description !== undefined) undo.description = task.description;
  if (patch.priority !== undefined) undo.priority = task.priority;
  if (patch.statusId !== undefined) undo.statusId = task.statusId;
  if (patch.startDate !== undefined) undo.startDate = task.startDate;
  if (patch.dueDate !== undefined) undo.dueDate = task.dueDate;
  if (patch.estimate !== undefined) undo.estimate = task.estimate;
  if (patch.archived !== undefined) undo.archived = task.archivedAt !== null;
  if (patch.projectId !== undefined || patch.epicId !== undefined) {
    undo.projectId = task.projectId;
    undo.epicId = task.epicId;
  }
  if (patch.tagIds !== undefined || patch.addTagIds !== undefined || patch.removeTagIds !== undefined) {
    undo.tagIds = task.tags.map((t) => t.id);
  }
  if (patch.position !== undefined) undo.position = { rank: task.rank };
  return undo;
}

function cachedRankBounds(qc: QueryClient, spaceId: string): { minRank?: string; maxRank?: string } {
  let minRank: string | undefined;
  let maxRank: string | undefined;
  for (const [, data] of qc.getQueriesData<TaskQueryResult>({ queryKey: qk.taskQueries(spaceId) })) {
    for (const t of data?.tasks ?? []) {
      if (minRank === undefined || t.rank < minRank) minRank = t.rank;
      if (maxRank === undefined || t.rank > maxRank) maxRank = t.rank;
    }
  }
  return { minRank, maxRank };
}

/**
 * The freshest cached copy of a task: the detail entry and every list can hold one, and an
 * inactive detail (a drawer closed minutes ago) is not refetched when lists are. Newest
 * `updatedAt` wins; on a tie, the most recently fetched/written query (rank-only changes and
 * counts don't bump updatedAt).
 */
export function findCachedTask(qc: QueryClient, spaceId: string, id: number): TaskDTO | undefined {
  let best: TaskDTO | undefined;
  let bestAt = -1;
  const consider = (task: TaskDTO | undefined, dataUpdatedAt: number) => {
    if (!task) return;
    if (!best || task.updatedAt > best.updatedAt || (task.updatedAt === best.updatedAt && dataUpdatedAt > bestAt)) {
      best = task;
      bestAt = dataUpdatedAt;
    }
  };
  const cache = qc.getQueryCache();
  const detail = cache.find<TaskDTO>({ queryKey: qk.task(spaceId, id), exact: true });
  if (detail) consider(detail.state.data, detail.state.dataUpdatedAt);
  for (const query of cache.findAll({ queryKey: qk.taskQueries(spaceId) })) {
    const data = query.state.data as TaskQueryResult | undefined;
    consider(data?.tasks.find((x) => x.id === id), query.state.dataUpdatedAt);
  }
  return best;
}

/** A task as the URL addresses it: by id (`?task=12`, /tasks/12) or by ref (/tasks/WEB-12). */
export type TaskKey = { id: number } | { ref: string };

/**
 * The freshest cached copy of a task addressed by id or ref, if one is loaded. A ref is first
 * resolved to the task's id through any cached copy carrying it (the by-ref entry of a task
 * page, a detail entry or a list), then findCachedTask picks the newest copy of that id: the
 * by-ref entry is not updated by edits, the detail entry is.
 */
export function findCachedTaskByKey(qc: QueryClient, spaceId: string, key: TaskKey): TaskDTO | undefined {
  if ('id' in key) return findCachedTask(qc, spaceId, key.id);
  const ref = key.ref.toUpperCase();
  const direct = qc.getQueryData<TaskDTO>(qk.taskByRef(spaceId, ref));
  let id = direct?.id;
  if (id === undefined) {
    for (const [, data] of qc.getQueriesData<TaskDTO>({ queryKey: qk.taskDetails(spaceId) })) {
      if (data?.ref.toUpperCase() === ref) {
        id = data.id;
        break;
      }
    }
  }
  if (id === undefined) {
    for (const [, data] of qc.getQueriesData<TaskQueryResult>({ queryKey: qk.taskQueries(spaceId) })) {
      const hit = data?.tasks.find((t) => t.ref.toUpperCase() === ref);
      if (hit) {
        id = hit.id;
        break;
      }
    }
  }
  return id === undefined ? undefined : (findCachedTask(qc, spaceId, id) ?? direct);
}

/** Replace a task everywhere its space caches it (detail + every query list). */
export function writeTaskToCache(qc: QueryClient, spaceId: string, task: TaskDTO): void {
  qc.setQueryData(qk.task(spaceId, task.id), task);
  qc.setQueriesData<TaskQueryResult>({ queryKey: qk.taskQueries(spaceId) }, (old) =>
    old ? { ...old, tasks: old.tasks.map((t) => (t.id === task.id ? task : t)) } : old,
  );
}

// ---- Mutations -----------------------------------------------------------------

export function useCreateTask() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskCreateInput) => spaceApi(sid).post<TaskDTO>('/tasks', input),
    onSuccess: (task) => {
      qc.setQueryData(qk.task(sid, task.id), task);
      return invalidateTasks(qc, sid);
    },
  });
}

/** mutationKey of useUpdateTask in a space (for useMutationState / useIsMutating). */
export const updateTaskMutationKey = (spaceId: string) => ['space', spaceId, 'tasks', 'update'] as const;

export type TaskUpdateVariables = TaskPatch & { id: number };

interface TaskUpdateContext {
  /**
   * The task as cached before this edit (the rollback target); undefined when it was not
   * cached. When an older edit of the same task settles first, it is rebased onto that result.
   */
  previous: TaskDTO | undefined;
  /** Optimistic rank of a `position` edit, kept when the task is rebased. */
  rank: string | undefined;
  hadDetail: boolean;
}

type TaskUpdateMutation = Mutation<TaskDTO, Error, TaskUpdateVariables, TaskUpdateContext>;

/** Still-pending updates of the same task submitted after `vars` in its space, oldest first. */
function newerPendingUpdates(qc: QueryClient, spaceId: string, vars: TaskUpdateVariables): TaskUpdateMutation[] {
  const all = qc.getMutationCache().findAll({ mutationKey: updateTaskMutationKey(spaceId) }) as TaskUpdateMutation[];
  const self = all.find((m) => m.state.variables === vars);
  return all
    .filter(
      (m) =>
        m !== self &&
        m.state.status === 'pending' &&
        m.state.variables?.id === vars.id &&
        (!self || m.mutationId > self.mutationId),
    )
    .sort((a, b) => a.mutationId - b.mutationId);
}

/**
 * `base` with the still-pending edits re-applied on top (their predictable parts, plus the
 * optimistic rank of moves). Each pending edit's rollback target becomes the state it now
 * starts from, so a later failure of one of them removes only its own change.
 */
function rebasePending(qc: QueryClient, spaceId: string, base: TaskDTO, pending: readonly TaskUpdateMutation[]): TaskDTO {
  const boot = qc.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId));
  let next = base;
  for (const m of pending) {
    const ctx = m.state.context;
    if (ctx) ctx.previous = next;
    const { id: _id, ...patch } = m.state.variables!;
    next = applyTaskPatch(next, patch, boot);
    if (patch.position !== undefined && ctx?.rank !== undefined) next = { ...next, rank: ctx.rank };
  }
  return next;
}

/**
 * Options of useUpdateTask in `spaceId` (exported for tests). Overlapping edits of one task stay
 * consistent: a response or a failure of an older edit never hides a newer pending one, and a
 * failure rolls back only that task (other tasks' concurrent edits are untouched). Everything it
 * touches is the space's own, also when the edit settles after the page moved to another space.
 */
export function updateTaskOptions(qc: QueryClient, spaceId: string) {
  const mutationKey = updateTaskMutationKey(spaceId);
  return {
    mutationKey,
    mutationFn: ({ id, ...patch }: TaskUpdateVariables) => spaceApi(spaceId).patch<TaskDTO>(`/tasks/${id}`, patch),
    onMutate: async (vars: TaskUpdateVariables): Promise<TaskUpdateContext> => {
      const { id, ...patch } = vars;
      await qc.cancelQueries({ queryKey: qk.tasksAll(spaceId) });
      const hadDetail = qc.getQueryData(qk.task(spaceId, id)) !== undefined;
      const previous = findCachedTask(qc, spaceId, id);
      let rank: string | undefined;
      if (previous) {
        const boot = qc.getQueryData<BootstrapDTO>(qk.bootstrap(spaceId));
        const pos = patch.position && typeof patch.position === 'object' && !('rank' in patch.position) ? patch.position : undefined;
        const neighbors = {
          ...(patch.position === 'top' || patch.position === 'bottom' ? cachedRankBounds(qc, spaceId) : {}),
          after: pos?.afterId ? findCachedTask(qc, spaceId, pos.afterId) : undefined,
          before: pos?.beforeId ? findCachedTask(qc, spaceId, pos.beforeId) : undefined,
        };
        const next = applyTaskPatch(previous, patch, boot, neighbors);
        if (patch.position !== undefined) rank = next.rank;
        writeTaskToCache(qc, spaceId, next);
      }
      return { previous, rank, hadDetail };
    },
    onError: (_err: Error, vars: TaskUpdateVariables, ctx: TaskUpdateContext | undefined) => {
      if (!ctx) return;
      const newer = newerPendingUpdates(qc, spaceId, vars);
      if (ctx.previous) writeTaskToCache(qc, spaceId, newer.length ? rebasePending(qc, spaceId, ctx.previous, newer) : ctx.previous);
      // The optimistic write may have created a detail entry that nobody asked for.
      if (!ctx.hadDetail && !newer.length) {
        qc.removeQueries({ queryKey: qk.task(spaceId, vars.id), exact: true, predicate: (q) => q.getObserversCount() === 0 });
      }
    },
    onSuccess: (task: TaskDTO, vars: TaskUpdateVariables) => {
      const newer = newerPendingUpdates(qc, spaceId, vars);
      writeTaskToCache(qc, spaceId, newer.length ? rebasePending(qc, spaceId, task, newer) : task);
    },
    // Refetch once the LAST concurrent update settles, so rapid edits/drops don't flicker back.
    // Not awaited: the mutation must settle (rollback + error toast) at once, even offline,
    // where these refetches pause until the connection returns.
    onSettled: () => {
      if (qc.isMutating({ mutationKey }) === 1) void invalidateTasks(qc, spaceId);
    },
  };
}

/**
 * PATCH /tasks/:id with optimistic cache updates. For drag & drop reordering, pass
 * position {afterId, beforeId} (ascending-rank neighbours); the optimistic rank uses the
 * cached neighbours ({ rank }, an Undo, is applied as is). Lists derived from the cache
 * (boards) re-sort with compareTasks, so the card moves immediately. Refetching waits until the LAST concurrent update settles,
 * so rapid successive edits/drops don't flicker back.
 */
export function useUpdateTask() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation(updateTaskOptions(qc, sid));
}

export function useDeleteTask() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).del<{ ok: true }>(`/tasks/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueriesData<TaskQueryResult>({ queryKey: qk.taskQueries(sid) }, (old) =>
        old ? { ...old, tasks: old.tasks.filter((t) => t.id !== id), total: Math.max(0, old.total - 1) } : old,
      );
      return forgetDeletedTasks(qc, sid, [id]);
    },
  });
}

export function useDuplicateTask() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => spaceApi(sid).post<TaskDTO>(`/tasks/${id}/duplicate`),
    onSuccess: () => invalidateTasks(qc, sid),
  });
}

export function useBulkUpdateTasks() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskBulkUpdateInput) => spaceApi(sid).post<{ tasks: TaskDTO[] }>('/tasks/bulk', input),
    onSuccess: ({ tasks }) => {
      tasks.forEach((t) => writeTaskToCache(qc, sid, t));
      return invalidateTasks(qc, sid);
    },
  });
}

export function useBulkDeleteTasks() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => spaceApi(sid).post<{ deleted: number }>('/tasks/bulk-delete', { ids }),
    onSuccess: (_r, ids) => forgetDeletedTasks(qc, sid, ids),
  });
}

/**
 * After deleting tasks of `spaceId`: drop their own detail/ref/timeline queries and refresh
 * everything else. Queries still observed (the open drawer or task page, which close / navigate
 * away right after) keep their last data instead of being refetched into a 404.
 */
export function forgetDeletedTasks(qc: QueryClient, spaceId: string, ids: readonly number[]): Promise<unknown> {
  const gone = new Set(ids);
  // ['space', spaceId, 'tasks', kind, key]
  const own = (q: Query): boolean => {
    const [, , , kind, key] = q.queryKey;
    if (kind === 'detail' || kind === 'timeline') return gone.has(key as number);
    if (kind === 'ref') return gone.has((q.state.data as TaskDTO | undefined)?.id ?? 0);
    return false;
  };
  qc.removeQueries({ queryKey: qk.tasksAll(spaceId), predicate: (q) => own(q) && q.getObserversCount() === 0 });
  return invalidateTasks(qc, spaceId, own);
}

// ---- Task dependencies (docs/design/task-dependencies.md) -------------------------

/**
 * Make `blockerId` block task `id` (POST /tasks/:id/blockers), or remove that link. A link moves the adjusted
 * dates of everything downstream, so every task list refreshes.
 */
export function useTaskLink() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blockerId, remove }: { id: number; blockerId: number; remove?: boolean }) =>
      remove
        ? spaceApi(sid).del<TaskDTO>(`/tasks/${id}/blockers/${blockerId}`)
        : spaceApi(sid).post<TaskDTO>(`/tasks/${id}/blockers`, { blockerId }),
    onSuccess: (task) => {
      writeTaskToCache(qc, sid, task);
      return invalidateTasks(qc, sid);
    },
  });
}

/** The tasks a rebaseline would move (POST /tasks/rebaseline/preview): a project's, or a selection's. */
export function useRebaselinePreview(input: RebaselineInput, opts: { enabled?: boolean } = {}) {
  const sid = useSpaceId();
  return useQuery({
    queryKey: [...qk.tasksAll(sid), 'rebaseline', input],
    queryFn: () => spaceApi(sid).post<{ items: RebaselineItemDTO[] }>('/tasks/rebaseline/preview', input),
    enabled: opts.enabled ?? true,
  });
}

/** Rebaseline (POST /tasks/rebaseline): copy the adjusted dates over the tasks' own. */
export function useRebaseline() {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RebaselineInput) => spaceApi(sid).post<{ items: RebaselineItemDTO[] }>('/tasks/rebaseline', input),
    onSuccess: () => invalidateTasks(qc, sid),
  });
}
