// Exporting a space as an archive (design §8.2, §8.3): archivePieces writes the JSON text in a fixed key order,
// reading every table in keyset pages of 1,000 rows (`WHERE id > :after ORDER BY id LIMIT 1000`), so no
// statement or cursor is large and each is drained at once; statuses and boards come whole in their v1 order
// (both are small, and an archive caps them at 1,000 and 10,000). exportArchive runs it on the space's
// consistent read view (Deps.space.readSnapshot: a read transaction of its own on Node, the object's
// blockConcurrencyWhile on Cloudflare) and gzips it as it goes, so it holds the compressed archive and one page.
//
// `users` lists the mirror rows that rows reference (a first pass over the user columns), plus the exporter; the
// address only of live accounts. The derived columns (tasks' tag_ids, comment_count and worklog_minutes; the
// tags come from tag_ids, which the triggers keep equal to task_tags), the fold columns, _meta and the `_`
// settings are left out. Comments, work logs and activity carry importedBy and importedAt only when an import
// gave them a provenance.

import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION } from '@shared/archive';
import { sanitizeActivityData } from '@shared/export';
import type { ArchiveUser, SpaceArchiveDTO } from '@shared/types';
import type { Db } from '../../core/db';
import type { Deps } from '../../env';
import { parseJson, toBoardDTO } from '../../services/mappers';
import type {
  ActivityRow,
  BoardRow,
  CommentRow,
  EpicRow,
  MilestoneRow,
  MirrorUserRow,
  ProjectRow,
  StatusRow,
  TagRow,
  TaskRow,
  WorklogRow,
} from '../../services/rows';
import { getSettings } from '../../services/settings';
import { nowIso } from '../../services/sql';

/** Rows per keyset page. */
export const EXPORT_PAGE_ROWS = 1000;

export interface ArchiveInfo {
  spaceId: string;
  /** The space's name (the directory's). */
  name: string;
  /** The exporting user (a member, so a row of the mirror). */
  exportedBy: number;
  appVersion: string;
  /** Default: now. */
  exportedAt?: string;
}

/** Every row of `table` in id order (its `columns`), a keyset page at a time. */
function* pages<T extends { id: number }>(db: Db, table: string, columns = '*'): Generator<T[]> {
  for (let after = 0; ; ) {
    const rows = db.all<T>(`SELECT ${columns} FROM ${table} WHERE id > :after ORDER BY id LIMIT ${EXPORT_PAGE_ROWS}`, { after });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < EXPORT_PAGE_ROWS) return;
    after = rows[rows.length - 1]!.id;
  }
}

/** The mirror ids that rows of the space reference (tasks, comments, work logs, activity; provenance included). */
function referencedUserIds(db: Db): Set<number> {
  const ids = new Set<number>();
  const add = (...values: Array<number | null>) => {
    for (const v of values) if (v !== null) ids.add(v);
  };
  for (const page of pages<{ id: number; a: number | null }>(db, 'tasks', 'id, created_by AS a')) for (const r of page) add(r.a);
  for (const table of ['comments', 'work_logs', 'activity']) {
    for (const page of pages<{ id: number; a: number | null; b: number | null }>(db, table, 'id, user_id AS a, imported_by AS b')) {
      for (const r of page) add(r.a, r.b);
    }
  }
  return ids;
}

/** A table of the archive as JSON pieces: `,"name":[`, then its rows, a page per piece, then `]`. */
function* list<T>(name: string, rowPages: Iterable<T[]>, toJson: (row: T) => unknown): Generator<string> {
  yield `,${JSON.stringify(name)}:[`;
  let started = false;
  for (const rows of rowPages) {
    if (rows.length === 0) continue;
    yield (started ? ',' : '') + rows.map((row) => JSON.stringify(toJson(row))).join(',');
    started = true;
  }
  yield ']';
}

/** importedBy and importedAt, when an import gave the row a provenance. */
const provenance = (r: { imported_by: number | null; imported_at: string | null }) =>
  r.imported_by === null && r.imported_at === null ? {} : { importedBy: r.imported_by, importedAt: r.imported_at };

/** The archive of the space in `db` as JSON text, in pieces (see the header). */
export function* archivePieces(db: Db, info: ArchiveInfo): Generator<string> {
  // Each task's blockers (task dependencies), written on the task as `blockedBy`: one read of the links.
  const blockers = new Map<number, number[]>();
  for (const l of db.all<{ blocker_id: number; blocked_id: number }>(
    'SELECT blocker_id, blocked_id FROM task_links ORDER BY blocked_id, blocker_id',
  )) {
    const list = blockers.get(l.blocked_id);
    if (list) list.push(l.blocker_id);
    else blockers.set(l.blocked_id, [l.blocker_id]);
  }
  const referenced = referencedUserIds(db);
  referenced.add(info.exportedBy);
  const users: ArchiveUser[] = db
    .all<MirrorUserRow>('SELECT * FROM users WHERE id IN (SELECT value FROM json_each(:ids)) ORDER BY id', {
      ids: JSON.stringify([...referenced]),
    })
    .map((u) => ({
      id: u.id,
      kind: u.kind,
      displayName: u.display_name,
      email: u.kind === 'account' && u.deleted === 0 ? u.email : null,
    }));
  const exporter = users.some((u) => u.id === info.exportedBy) ? info.exportedBy : null;
  const header: Pick<SpaceArchiveDTO, 'format' | 'formatVersion' | 'exportedAt' | 'appVersion' | 'space' | 'users' | 'settings'> = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: info.exportedAt ?? nowIso(),
    appVersion: info.appVersion,
    space: { id: info.spaceId, name: info.name, exportedBy: exporter },
    users,
    settings: getSettings(db),
  };
  // The header's text without its closing brace; the tables follow.
  yield JSON.stringify(header).slice(0, -1);

  yield* list<StatusRow>('statuses', [db.all<StatusRow>('SELECT * FROM statuses ORDER BY position, id')], (s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    color: s.color,
    position: s.position,
  }));
  yield* list<TagRow>('tags', pages<TagRow>(db, 'tags'), (t) => ({ id: t.id, name: t.name, color: t.color, createdAt: t.created_at }));
  yield* list<ProjectRow>('projects', pages<ProjectRow>(db, 'projects'), (p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    color: p.color,
    status: p.status,
    position: p.position,
    taskCounter: p.task_counter,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
  yield* list<MilestoneRow>('milestones', pages<MilestoneRow>(db, 'milestones'), (m) => ({
    id: m.id,
    projectId: m.project_id,
    name: m.name,
    description: m.description,
    status: m.status,
    startDate: m.start_date,
    dueDate: m.due_date,
    position: m.position,
    completedAt: m.completed_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  }));
  yield* list<EpicRow>('epics', pages<EpicRow>(db, 'epics'), (e) => ({
    id: e.id,
    projectId: e.project_id,
    milestoneId: e.milestone_id,
    name: e.name,
    description: e.description,
    color: e.color,
    status: e.status,
    startDate: e.start_date,
    dueDate: e.due_date,
    position: e.position,
    completedAt: e.completed_at,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  }));
  yield* list<TaskRow>('tasks', pages<TaskRow>(db, 'tasks'), (t) => ({
    id: t.id,
    projectId: t.project_id,
    number: t.number,
    epicId: t.epic_id,
    statusId: t.status_id,
    priority: t.priority,
    title: t.title,
    description: t.description,
    startDate: t.start_date,
    dueDate: t.due_date,
    estimate: t.estimate,
    rank: t.rank,
    completedAt: t.completed_at,
    archivedAt: t.archived_at,
    createdBy: t.created_by,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    tagIds: parseJson(t.tag_ids, []) as number[],
    ...(blockers.has(t.id) ? { blockedBy: blockers.get(t.id)! } : {}),
  }));
  yield* list<CommentRow>('comments', pages<CommentRow>(db, 'comments'), (cm) => ({
    id: cm.id,
    taskId: cm.task_id,
    body: cm.body,
    authorId: cm.user_id,
    createdAt: cm.created_at,
    updatedAt: cm.updated_at,
    editedAt: cm.edited_at,
    ...provenance(cm),
  }));
  yield* list<WorklogRow>('worklogs', pages<WorklogRow>(db, 'work_logs'), (w) => ({
    id: w.id,
    taskId: w.task_id,
    date: w.date,
    minutes: w.minutes,
    note: w.note,
    authorId: w.user_id,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    ...provenance(w),
  }));
  yield* list<ActivityRow>('activity', pages<ActivityRow>(db, 'activity'), (a) => ({
    id: a.id,
    action: a.action,
    entityType: a.entity_type,
    entityId: a.entity_id,
    projectId: a.project_id,
    taskId: a.task_id,
    // Malformed stored data (only possible from older imports) is repaired, so every archive imports again.
    data: sanitizeActivityData(parseJson(a.data, {})),
    actorId: a.user_id,
    createdAt: a.created_at,
    ...provenance(a),
  }));
  yield* list<BoardRow>(
    'boards',
    [db.all<BoardRow>('SELECT * FROM boards ORDER BY project_id IS NOT NULL, project_id, position, id')],
    toBoardDTO,
  );
  yield '}';
}

/** Text gathered before it is handed to the compressor. */
const WRITE_CHARS = 64 * 1024;

/**
 * The space's archive, gzip-compressed (CompressionStream: Node ≥ 18 and workerd), on its consistent read view
 * (see the header); the compressed chunks.
 */
export async function exportArchive(space: Deps['space'], info: ArchiveInfo): Promise<Uint8Array[]> {
  return space.readSnapshot(async (db) => {
    const gzip = new CompressionStream('gzip');
    const writer = gzip.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const reading = (async () => {
      const reader = gzip.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
      }
    })();
    const encoder = new TextEncoder();
    try {
      let text = '';
      for (const piece of archivePieces(db, info)) {
        text += piece;
        if (text.length >= WRITE_CHARS) {
          await writer.write(encoder.encode(text));
          text = '';
        }
      }
      if (text.length > 0) await writer.write(encoder.encode(text));
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    } finally {
      await reading.catch(() => {});
    }
    return chunks;
  });
}
