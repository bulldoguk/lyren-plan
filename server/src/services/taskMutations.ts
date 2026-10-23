// Task writes (SPEC §5.5): create, update (incl. project moves, tags, archive, rank),
// delete, duplicate and the all-or-nothing bulk variants. Every function runs inside one
// db.tx and records its activity (§5.8) in that same transaction. Routes validate the body
// with the shared zod schemas and hand the parsed output to these functions.

import type { z } from 'zod';
import { isClosedCategory, LIMITS } from '@shared/constants';
import type { taskBulkPatchSchema, taskCreateInput, taskUpdateInput } from '@shared/schemas';
import type { TagRef, TaskDTO } from '@shared/types';
import { fold } from '../core/fold';
import type { Db } from '../db';
import { badRequest } from '../http/errors';
import { recordActivity, taskChanges } from './activity';
import { noteBlockerDeleted } from './schedule';
import { defaultStatusId, nextTaskNumber, requireTagIds, requireTask } from './entities';
import { toTagRef } from './mappers';
import { rankForNewTask, rankForPosition } from './rank';
import { truncateText } from './text';
import type { EpicRow, ProjectRow, StatusRow, TagRow, TaskRow } from './rows';
import { inJson, jsonList, nowIso } from './sql';
import { getTaskDTO, getTaskDTOs } from './tasks';

export type TaskCreateData = z.output<typeof taskCreateInput>;
export type TaskUpdateData = z.output<typeof taskUpdateInput>;
export type TaskBulkPatch = z.output<typeof taskBulkPatchSchema>;

/** Who performs the change (activity actor, created_by). */
export interface MutationActor {
  userId: number | null;
}

// ---------------------------------------------------------------------------
// Lookups that turn an unknown referenced id into a field-specific 400
// ---------------------------------------------------------------------------

/** Path of a body field in error details, e.g. 'statusId' or (bulk) 'patch.statusId'. */
type FieldPath = (field: string) => string;
const plainPath: FieldPath = (field) => field;

function invalid(path: string, message: string): never {
  throw badRequest(message, [{ path, message }]);
}

function projectRef(db: Db, id: number, path: string): ProjectRow {
  return db.get<ProjectRow>('SELECT * FROM projects WHERE id = :id', { id }) ?? invalid(path, `Project ${id} does not exist`);
}

function statusRef(db: Db, id: number, path: string): StatusRow {
  return db.get<StatusRow>('SELECT * FROM statuses WHERE id = :id', { id }) ?? invalid(path, `Status ${id} does not exist`);
}

function epicRef(db: Db, id: number, path: string): EpicRow {
  return db.get<EpicRow>('SELECT * FROM epics WHERE id = :id', { id }) ?? invalid(path, `Epic ${id} does not exist`);
}

function statusCategoryClosed(db: Db, statusId: number): boolean {
  const row = db.get<Pick<StatusRow, 'category'>>('SELECT category FROM statuses WHERE id = :id', { id: statusId });
  return row ? isClosedCategory(row.category) : false;
}

function assertDateOrder(startDate: string | null, dueDate: string | null, path: FieldPath): void {
  if (startDate !== null && dueDate !== null && startDate > dueDate) {
    invalid(path('dueDate'), 'Due date must be on or after start date');
  }
}

function taskTags(db: Db, taskId: number): TagRef[] {
  return db
    .all<TagRow>('SELECT g.* FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = :taskId', { taskId })
    .map(toTagRef);
}

/**
 * Make the task's tags exactly `tagIds`, writing only the rows that change: every row written is billed on
 * Cloudflare, and each also rewrites the task's tag list (tasks.tag_ids, by trigger).
 */
function replaceTaskTags(db: Db, taskId: number, tagIds: readonly number[]): void {
  const ids = jsonList(tagIds);
  db.run(`DELETE FROM task_tags WHERE task_id = :taskId AND tag_id NOT IN (SELECT value FROM json_each(:ids))`, { taskId, ids });
  if (tagIds.length > 0) {
    db.run(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT :taskId, value FROM json_each(:ids)`, { taskId, ids });
  }
}

function projectKey(db: Db, projectId: number): string {
  return db.get<{ key: string }>('SELECT key FROM projects WHERE id = :id', { id: projectId })!.key;
}

const TASK_INSERT = `INSERT INTO tasks (project_id, number, epic_id, status_id, title, title_fold, description, description_fold,
                     priority, start_date, due_date, estimate, rank, completed_at, archived_at, created_by, created_at,
                     updated_at)
  VALUES (:project_id, :number, :epic_id, :status_id, :title, :title_fold, :description, :description_fold,
          :priority, :start_date, :due_date, :estimate, :rank, :completed_at, :archived_at, :created_by, :created_at,
          :updated_at)`;

/** The fold columns of a task's title and description (TASK_INSERT, the full UPDATE; design §3.4). */
function taskFolds(values: Pick<TaskRow, 'title' | 'description'>): Pick<TaskRow, 'title_fold' | 'description_fold'> {
  return { title_fold: fold(values.title), description_fold: fold(values.description) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** POST /api/tasks. Returns the new task's id. */
export function createTaskRow(db: Db, actor: MutationActor, input: TaskCreateData): number {
  return db.tx(() => {
    const project = projectRef(db, input.projectId, 'projectId');
    if (input.epicId !== undefined && input.epicId !== null) {
      const epic = epicRef(db, input.epicId, 'epicId');
      if (epic.project_id !== project.id) invalid('epicId', 'The epic belongs to another project');
    }
    const statusId = input.statusId !== undefined ? statusRef(db, input.statusId, 'statusId').id : defaultStatusId(db);
    const startDate = input.startDate ?? null;
    const dueDate = input.dueDate ?? null;
    assertDateOrder(startDate, dueDate, plainPath);
    const tags = requireTagIds(db, input.tagIds ?? [], 'tagIds');
    const rank = rankForNewTask(db, input.position);
    const number = nextTaskNumber(db, project.id);
    const now = nowIso();

    const values = {
      project_id: project.id,
      number,
      epic_id: input.epicId ?? null,
      status_id: statusId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 0,
      start_date: startDate,
      due_date: dueDate,
      estimate: input.estimate ?? null,
      rank,
      completed_at: statusCategoryClosed(db, statusId) ? now : null,
      archived_at: null,
      created_by: actor.userId,
      created_at: now,
      updated_at: now,
    };
    const id = db.run(TASK_INSERT, { ...values, ...taskFolds(values) }).lastInsertRowid;
    replaceTaskTags(
      db,
      id,
      tags.map((t) => t.id),
    );
    recordActivity(db, {
      userId: actor.userId,
      projectId: project.id,
      taskId: id,
      entityType: 'task',
      entityId: id,
      action: 'task.created',
      data: { title: input.title, ref: `${project.key}-${number}` },
      createdAt: now,
    });
    return id;
  });
}

export function createTask(db: Db, actor: MutationActor, input: TaskCreateData): TaskDTO {
  return getTaskDTO(db, createTaskRow(db, actor, input));
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateTaskOptions {
  /** Prefix for error detail paths (bulk uses 'patch.'). */
  pathPrefix?: string;
  /**
   * Bulk rule: never move projects. An epic of another project is a 400 instead of an
   * implicit move (the bulk route reports all offenders up front).
   */
  forbidMove?: boolean;
}

export interface UpdateTaskResult {
  /** False for a no-op (or rank-only) update: no activity, updated_at untouched. */
  changed: boolean;
  /** True when the task moved to another project. */
  moved: boolean;
}

/**
 * Apply a TaskUpdateInput to one task (SPEC §5.5): implicit/explicit project moves (new
 * number, epic cleared, `task.moved`), completedAt transitions, tag replace/add/remove,
 * archive, date order, rank positions. Rank-only and no-op updates write no activity and
 * keep updated_at. Runs in its own (nested) transaction.
 */
export function applyTaskUpdate(
  db: Db,
  actor: MutationActor,
  id: number,
  input: TaskUpdateData,
  opts: UpdateTaskOptions = {},
): UpdateTaskResult {
  const path: FieldPath = (field) => `${opts.pathPrefix ?? ''}${field}`;
  return db.tx(() => {
    const before = requireTask(db, id);

    // ---- Tag operands (validated before anything is written) -----------------------
    if (input.tagIds !== undefined && (input.addTagIds !== undefined || input.removeTagIds !== undefined)) {
      invalid(path('tagIds'), 'Use either tagIds or addTagIds/removeTagIds, not both');
    }
    const replaceTags = input.tagIds !== undefined ? requireTagIds(db, input.tagIds, path('tagIds')) : null;
    const addTags = input.addTagIds !== undefined ? requireTagIds(db, input.addTagIds, path('addTagIds')) : [];
    const removeTags = input.removeTagIds !== undefined ? requireTagIds(db, input.removeTagIds, path('removeTagIds')) : [];
    const removeIds = new Set(removeTags.map((t) => t.id));
    if (addTags.some((t) => removeIds.has(t.id))) {
      invalid(path('removeTagIds'), 'A tag cannot be both added and removed');
    }

    // ---- Project & epic ---------------------------------------------------------------
    const epic = input.epicId !== undefined && input.epicId !== null ? epicRef(db, input.epicId, path('epicId')) : null;
    let projectId = before.project_id;
    if (input.projectId !== undefined) {
      projectId = projectRef(db, input.projectId, path('projectId')).id;
      if (epic && epic.project_id !== projectId) invalid(path('epicId'), 'The epic belongs to another project');
    } else if (epic && epic.project_id !== before.project_id) {
      if (opts.forbidMove) invalid(path('epicId'), 'The epic belongs to another project');
      projectId = epic.project_id; // implicit move to the epic's project
    }
    const moved = projectId !== before.project_id;
    // A move clears the epic unless a valid epic of the target project is part of the request.
    const epicId = input.epicId !== undefined ? input.epicId : moved ? null : before.epic_id;

    // ---- Status & completedAt -----------------------------------------------------------
    let statusId = before.status_id;
    let completedAt = before.completed_at;
    if (input.statusId !== undefined && input.statusId !== before.status_id) {
      const next = statusRef(db, input.statusId, path('statusId'));
      const wasClosed = statusCategoryClosed(db, before.status_id);
      const isClosed = isClosedCategory(next.category);
      statusId = next.id;
      if (!wasClosed && isClosed) completedAt = nowIso();
      else if (wasClosed && !isClosed) completedAt = null;
    }

    // ---- Dates --------------------------------------------------------------------------
    const startDate = input.startDate !== undefined ? input.startDate : before.start_date;
    const dueDate = input.dueDate !== undefined ? input.dueDate : before.due_date;
    assertDateOrder(startDate, dueDate, path);

    // ---- Archive ------------------------------------------------------------------------
    let archivedAt = before.archived_at;
    if (input.archived === true && archivedAt === null) archivedAt = nowIso();
    if (input.archived === false) archivedAt = null;

    // ---- Rank (validated even when nothing else changes) ------------------------------
    const rank = input.position !== undefined ? (rankForPosition(db, input.position, id) ?? before.rank) : before.rank;

    // ---- Tags -----------------------------------------------------------------------------
    const tagsBefore = taskTags(db, id);
    let tagsAfter: TagRef[] = tagsBefore;
    if (replaceTags) {
      tagsAfter = replaceTags.map(toTagRef);
    } else if (addTags.length > 0 || removeTags.length > 0) {
      const kept = tagsBefore.filter((t) => !removeIds.has(t.id));
      const keptIds = new Set(kept.map((t) => t.id));
      tagsAfter = [...kept, ...addTags.filter((t) => !keptIds.has(t.id)).map(toTagRef)];
    }

    const after: TaskRow = {
      ...before,
      project_id: projectId,
      epic_id: epicId,
      status_id: statusId,
      title: input.title ?? before.title,
      description: input.description ?? before.description,
      priority: input.priority ?? before.priority,
      start_date: startDate,
      due_date: dueDate,
      estimate: input.estimate !== undefined ? input.estimate : before.estimate,
      rank,
      completed_at: completedAt,
      archived_at: archivedAt,
    };
    const changes = taskChanges(db, before, after, { before: tagsBefore, after: tagsAfter });
    const changed = moved || changes.length > 0;

    if (!changed) {
      // Rank-only (or nothing): keep updated_at, log nothing.
      if (rank !== before.rank) db.run('UPDATE tasks SET rank = :rank WHERE id = :id', { id, rank });
      return { changed: false, moved: false };
    }

    const now = nowIso();
    const fromRef = `${projectKey(db, before.project_id)}-${before.number}`;
    if (moved) after.number = returningNumber(db, id, projectId) ?? nextTaskNumber(db, projectId);
    after.updated_at = now;
    db.run(
      `UPDATE tasks SET project_id = :project_id, number = :number, epic_id = :epic_id, status_id = :status_id,
              title = :title, title_fold = :title_fold, description = :description,
              description_fold = :description_fold, priority = :priority, start_date = :start_date,
              due_date = :due_date, estimate = :estimate, rank = :rank, completed_at = :completed_at,
              archived_at = :archived_at, updated_at = :updated_at
        WHERE id = :id`,
      { ...after, ...taskFolds(after) },
    );
    if (changes.some((c) => c.field === 'tags')) {
      replaceTaskTags(
        db,
        id,
        tagsAfter.map((t) => t.id),
      );
    }

    const ref = `${projectKey(db, projectId)}-${after.number}`;
    if (moved) {
      const names = new Map(
        db
          .all<{ id: number; name: string }>(`SELECT id, name FROM projects WHERE ${inJson('id', 'ids')}`, {
            ids: jsonList([before.project_id, projectId]),
          })
          .map((p) => [p.id, p.name]),
      );
      recordActivity(db, {
        userId: actor.userId,
        projectId,
        taskId: id,
        entityType: 'task',
        entityId: id,
        action: 'task.moved',
        data: {
          title: after.title,
          ref,
          fromProjectId: before.project_id,
          fromProjectName: names.get(before.project_id) ?? '',
          toProjectId: projectId,
          toProjectName: names.get(projectId) ?? '',
          fromRef,
          toRef: ref,
        },
        createdAt: now,
      });
    }
    if (changes.length > 0) {
      recordActivity(db, {
        userId: actor.userId,
        projectId,
        taskId: id,
        entityType: 'task',
        entityId: id,
        action: 'task.updated',
        data: { changes, title: after.title, ref },
        createdAt: now,
      });
    }
    return { changed: true, moved };
  });
}

/**
 * The number a task had in `projectId` the last time it left that project (its latest
 * `task.moved` away from there), when no task holds it now. Numbers are never issued twice
 * (task_counter only grows), so moving a task back — e.g. undoing a move — gives it its old
 * ref again and links to it keep working. Null when it never was there (or the number is taken).
 */
function returningNumber(db: Db, taskId: number, projectId: number): number | null {
  const row = db.get<{ fromRef: string | null }>(
    `SELECT json_extract(data, '$.fromRef') AS fromRef FROM activity
      WHERE task_id = :taskId AND action = 'task.moved' AND json_extract(data, '$.fromProjectId') = :projectId
      ORDER BY id DESC LIMIT 1`,
    { taskId, projectId },
  );
  const m = /-(\d+)$/.exec(row?.fromRef ?? '');
  const number = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) return null;
  // Only numbers the project issued (a later one would collide with a future task).
  const issued = db.get<{ task_counter: number }>('SELECT task_counter FROM projects WHERE id = :projectId', { projectId });
  if (!issued || number > issued.task_counter) return null;
  const taken = db.get<{ id: number }>('SELECT id FROM tasks WHERE project_id = :projectId AND number = :number', { projectId, number });
  return taken ? null : number;
}

/** PATCH /api/tasks/:id → the task after the update (unchanged for a no-op). */
export function updateTask(db: Db, actor: MutationActor, id: number, input: TaskUpdateData): TaskDTO {
  applyTaskUpdate(db, actor, id, input);
  return getTaskDTO(db, id);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Delete a task (comments, work logs, tags and its activity cascade); logs `task.deleted`. */
export function deleteTask(db: Db, actor: MutationActor, id: number): void {
  db.tx(() => {
    const row = requireTask(db, id);
    // Its links go by cascade; the tasks it blocked note that their blocker went.
    noteBlockerDeleted(db, actor, row);
    recordActivity(db, {
      userId: actor.userId,
      projectId: row.project_id,
      taskId: null,
      entityType: 'task',
      entityId: row.id,
      action: 'task.deleted',
      data: { title: row.title, ref: `${projectKey(db, row.project_id)}-${row.number}` },
    });
    db.run('DELETE FROM tasks WHERE id = :id', { id });
  });
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

const COPY_SUFFIX = ' (copy)';

/** Title of a duplicate: `<title> (copy)`, shortened so it stays within LIMITS.titleMax. */
export function copyTitle(title: string): string {
  const room = LIMITS.titleMax - COPY_SUFFIX.length;
  return `${title.length > room ? truncateText(title, room).trimEnd() : title}${COPY_SUFFIX}`;
}

/**
 * Copy a task (same project, epic, fields and tags), titled "… (copy)", placed right after
 * the original. A closed status becomes the default status; never archived. Logs
 * `task.created` with `duplicatedFrom`.
 */
export function duplicateTask(db: Db, actor: MutationActor, id: number): TaskDTO {
  const newId = db.tx(() => {
    const original = requireTask(db, id);
    const statusId = statusCategoryClosed(db, original.status_id) ? defaultStatusId(db) : original.status_id;
    const key = projectKey(db, original.project_id);
    const rank = rankForNewTask(db, { afterId: original.id });
    const number = nextTaskNumber(db, original.project_id);
    const now = nowIso();
    const title = copyTitle(original.title);
    const copy = {
      ...original,
      number,
      status_id: statusId,
      title,
      rank,
      // Only set when even the default status is closed (keeps the completedAt invariant).
      completed_at: statusCategoryClosed(db, statusId) ? now : null,
      archived_at: null,
      created_by: actor.userId,
      created_at: now,
      updated_at: now,
    };
    const copyId = db.run(TASK_INSERT, { ...copy, ...taskFolds(copy) }).lastInsertRowid;
    db.run('INSERT INTO task_tags (task_id, tag_id) SELECT :copyId, tag_id FROM task_tags WHERE task_id = :id', {
      copyId,
      id: original.id,
    });
    recordActivity(db, {
      userId: actor.userId,
      projectId: original.project_id,
      taskId: copyId,
      entityType: 'task',
      entityId: copyId,
      action: 'task.created',
      data: { title, ref: `${key}-${number}`, duplicatedFrom: `${key}-${original.number}` },
      createdAt: now,
    });
    return copyId;
  });
  return getTaskDTO(db, newId);
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

/** Rows of `ids` (deduplicated, input order); 400 listing unknown ids. */
function requireTaskRows(db: Db, ids: readonly number[]): TaskRow[] {
  const unique = [...new Set(ids)];
  const rows = new Map(
    db.all<TaskRow>(`SELECT * FROM tasks WHERE ${inJson('id', 'ids')}`, { ids: jsonList(unique) }).map((r) => [r.id, r]),
  );
  const missing = unique.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    invalid('ids', `Unknown task id${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  }
  return unique.map((id) => rows.get(id)!);
}

/**
 * POST /api/tasks/bulk: apply one patch to many tasks, all or nothing. Unknown ids → 400
 * listing them; an epic must belong to every task's project (400 listing the offending
 * refs) — bulk edits never move tasks between projects. One activity entry per changed task.
 */
export function bulkUpdateTasks(db: Db, actor: MutationActor, ids: readonly number[], patch: TaskBulkPatch): TaskDTO[] {
  const unique = db.tx(() => {
    const rows = requireTaskRows(db, ids);
    if (patch.epicId !== undefined && patch.epicId !== null) {
      const epic = epicRef(db, patch.epicId, 'patch.epicId');
      const offenders = rows.filter((r) => r.project_id !== epic.project_id);
      if (offenders.length > 0) {
        const refs = offenders.map((r) => `${projectKey(db, r.project_id)}-${r.number}`);
        invalid(
          'patch.epicId',
          `The epic “${epic.name}” is not in the project of ${refs.length > 1 ? 'tasks' : 'task'} ${refs.join(', ')}`,
        );
      }
    }
    for (const row of rows) applyTaskUpdate(db, actor, row.id, patch, { pathPrefix: 'patch.', forbidMove: true });
    return rows.map((r) => r.id);
  });
  return getTaskDTOs(db, unique);
}

/** POST /api/tasks/bulk-delete: all or nothing; unknown ids → 400. Returns the number deleted. */
export function bulkDeleteTasks(db: Db, actor: MutationActor, ids: readonly number[]): number {
  return db.tx(() => {
    const rows = requireTaskRows(db, ids);
    for (const row of rows) deleteTask(db, actor, row.id);
    return rows.length;
  });
}
