// The rows an import commit writes, estimated before it runs (design §8.9): checked against
// IMPORT_MAX_ROW_WRITES and reserved from the instance's IMPORT_DAILY_ROW_WRITES. A Durable Object bills a row
// written for every table row and every index entry an insert writes, so an inserted row weighs 1 plus its
// table's indexes (UNIQUE ones included; server/test/importEstimate.test.ts checks the table against PRAGMA
// index_list of the space schema), and a deleted row 1, its index entries and the rows its cascades delete
// with it included (measured in workerd, Appendix D 60: a delete counts the rows it removes, not their index
// entries). Each insert statement into a table with AUTOINCREMENT also writes its sqlite_sequence row.
// server/test-workers/importCost.test.ts checks the whole estimate against the meter.
//
// The derived task columns (tag_ids, comment_count, worklog_minutes, Appendix D 42 and 46) cost nothing more:
// the commit deletes the tasks before their task_tags, comments and work logs (the cascades' triggers then find
// no task row to update) and inserts those before their tasks (whose rows carry the derived values), so the
// triggers that still fire write no row. Ranks are written once, with the tasks (§8.6).

import type { Db } from '../../core/db';

/** 1 + the indexes of each table the commit writes (PRAGMA index_list; a WITHOUT ROWID table's key is the table). */
export const ROW_WEIGHTS = {
  statuses: 3,
  tags: 3,
  projects: 2,
  milestones: 2,
  epics: 3,
  tasks: 8,
  task_tags: 2,
  task_links: 2,
  comments: 2,
  work_logs: 3,
  activity: 3,
  boards: 2,
  settings: 2,
  users: 1,
  _meta: 1,
} as const;

export type WrittenTable = keyof typeof ROW_WEIGHTS;
export type TableRows = Record<WrittenTable, number>;

/** The tables with an AUTOINCREMENT id (each insert statement that raises the largest id writes sqlite_sequence). */
export const SEQUENCED_TABLES = [
  'statuses',
  'tags',
  'projects',
  'milestones',
  'epics',
  'tasks',
  'comments',
  'work_logs',
  'activity',
  'boards',
] as const;

/** Rows one insert statement takes at most (commit.ts), so a statement's JSON parameter stays small. */
export const INSERT_BATCH_ROWS = 500;

/** The write generation's row, which the gate writes after the commit (§6.4.2). */
const WRITE_STATE_ROWS = 1;

/** No rows: the start of a TableRows. */
export const noRows = (): TableRows =>
  Object.fromEntries(Object.keys(ROW_WEIGHTS).map((table) => [table, 0])) as TableRows;

/**
 * Σ over tables of rows inserted × weight + rows deleted, plus one sqlite_sequence write per insert statement
 * of a sequenced table, plus the write generation.
 */
export function estimateRowWrites(inserted: TableRows, deleted: TableRows): number {
  let rows = WRITE_STATE_ROWS;
  for (const table of Object.keys(ROW_WEIGHTS) as WrittenTable[]) {
    rows += inserted[table] * ROW_WEIGHTS[table] + deleted[table];
  }
  for (const table of SEQUENCED_TABLES) rows += Math.ceil(inserted[table] / INSERT_BATCH_ROWS);
  return rows;
}

/**
 * The rows the commit deletes from this space: every domain row, the space's settings, and the mirror's rows of
 * people who are not members (former members, deleted accounts, placeholders). One read of each table.
 */
export function rowsToDelete(db: Db): TableRows {
  const counted = db.get<Omit<TableRows, '_meta'>>(
    `SELECT (SELECT COUNT(*) FROM statuses) AS statuses, (SELECT COUNT(*) FROM tags) AS tags,
            (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM milestones) AS milestones,
            (SELECT COUNT(*) FROM epics) AS epics, (SELECT COUNT(*) FROM tasks) AS tasks,
            (SELECT COUNT(*) FROM task_tags) AS task_tags, (SELECT COUNT(*) FROM task_links) AS task_links,
            (SELECT COUNT(*) FROM comments) AS comments,
            (SELECT COUNT(*) FROM work_logs) AS work_logs, (SELECT COUNT(*) FROM activity) AS activity,
            (SELECT COUNT(*) FROM boards) AS boards,
            (SELECT COUNT(*) FROM settings WHERE substr(key, 1, 1) <> '_') AS settings,
            (SELECT COUNT(*) FROM users WHERE is_member = 0 OR kind = 'placeholder') AS users`,
  )!;
  return { ...counted, _meta: 0 };
}
