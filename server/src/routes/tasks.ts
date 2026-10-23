// /api/tasks — query, CRUD, duplicate and bulk edits (SPEC §5.5, §7). The write logic lives
// in services/taskMutations.ts; reading/filtering in services/tasks.ts.

import { Hono } from 'hono';
import {
  rebaselineInput,
  taskBulkDeleteInput,
  taskBulkUpdateInput,
  taskCreateInput,
  taskLinkInput,
  taskQueryInput,
  taskReadQuery,
  taskUpdateInput,
} from '@shared/schemas';
import type { RebaselineItemDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import type { AppEnv, Deps } from '../env';
import { notFound } from '../http/errors';
import { readId, readJson, readQuery } from '../http/validate';
import {
  bulkDeleteTasks,
  bulkUpdateTasks,
  createTask,
  deleteTask,
  duplicateTask,
  updateTask,
} from '../services/taskMutations';
import { addLink, applyRebaseline, rebaselinePlan, removeLink } from '../services/schedule';
import { serverToday } from '../services/sql';
import { findTaskByRef, getTaskDTO, queryTasks } from '../services/tasks';
import { currentUser } from '../space/context';

export function taskRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/query', async (c) => {
    const input = await readJson(c, taskQueryInput);
    return c.json<TaskQueryResult>(queryTasks(db, input));
  });

  r.post('/bulk', async (c) => {
    const { ids, patch } = await readJson(c, taskBulkUpdateInput);
    const tasks = bulkUpdateTasks(db, { userId: currentUser(c).id }, ids, patch);
    return c.json<{ tasks: TaskDTO[] }>({ tasks });
  });

  r.post('/bulk-delete', async (c) => {
    const { ids } = await readJson(c, taskBulkDeleteInput);
    const deleted = bulkDeleteTasks(db, { userId: currentUser(c).id }, ids);
    return c.json<{ deleted: number }>({ deleted });
  });

  r.post('/', async (c) => {
    const input = await readJson(c, taskCreateInput);
    return c.json<TaskDTO>(createTask(db, { userId: currentUser(c).id }, input), 201);
  });

  // Rebaselining (docs/design/task-dependencies.md): the preview is a read, the rebaseline a write.
  r.post('/rebaseline/preview', async (c) => {
    const input = await readJson(c, rebaselineInput);
    return c.json<{ items: RebaselineItemDTO[] }>({ items: rebaselinePlan(db, input, input.today ?? serverToday()) });
  });

  r.post('/rebaseline', async (c) => {
    const input = await readJson(c, rebaselineInput);
    const items = applyRebaseline(db, { userId: currentUser(c).id }, input, input.today ?? serverToday());
    return c.json<{ items: RebaselineItemDTO[] }>({ items });
  });

  r.get('/ref/:ref', (c) => {
    const { today } = readQuery(c, taskReadQuery);
    const task = findTaskByRef(db, c.req.param('ref'), today);
    if (!task) throw notFound('Task');
    return c.json<TaskDTO>(task);
  });

  r.get('/:id', (c) => {
    const { today } = readQuery(c, taskReadQuery);
    return c.json<TaskDTO>(getTaskDTO(db, readId(c), today));
  });

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, taskUpdateInput);
    return c.json<TaskDTO>(updateTask(db, { userId: currentUser(c).id }, id, input));
  });

  r.delete('/:id', (c) => {
    deleteTask(db, { userId: currentUser(c).id }, readId(c));
    return c.json({ ok: true as const });
  });

  // Links (finish-to-start): the task's blockers. Both answer the task as it is now.
  r.post('/:id/blockers', async (c) => {
    const id = readId(c);
    const { blockerId } = await readJson(c, taskLinkInput);
    addLink(db, { userId: currentUser(c).id }, id, blockerId);
    return c.json<TaskDTO>(getTaskDTO(db, id));
  });

  r.delete('/:id/blockers/:blockerId', (c) => {
    const id = readId(c);
    removeLink(db, { userId: currentUser(c).id }, id, readId(c, 'blockerId'));
    return c.json<TaskDTO>(getTaskDTO(db, id));
  });

  r.post('/:id/duplicate', (c) => {
    const id = readId(c);
    return c.json<TaskDTO>(duplicateTask(db, { userId: currentUser(c).id }, id), 201);
  });

  return r;
}
