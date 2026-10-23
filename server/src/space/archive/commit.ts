// Writing an import (design §8.6): the mapping of the archive's users checked against the candidates (asked of
// the directory again at commit time), then the whole space replaced in ONE transaction, today's replaceAll
// generalized:
//   1. every domain row and the space's settings deleted (a new space's seeded defaults too), the tasks first:
//      their task_tags, comments and work logs go with them by cascade, whose triggers then find no task row to
//      rewrite (estimate.ts);
//   2. the users mirror: rows of people who are not members, and every placeholder, deleted (nothing references
//      them any more); every account a user is mapped to upserted from the candidate data (is_member stays 1 for
//      members, 0 for others); a new placeholder (the archive's name) for each user mapped to one, its id below
//      every other;
//   3. the rows inserted with their original ids, fold columns computed, task ranks assigned in the archive's
//      (rank, id) order (what renormalizeRanks produced, without writing every task a second time), comments, work
//      logs and activity attributed to someone other than the importer given its provenance (imported_by, the
//      importer, and imported_at, now; an archive's own provenance is kept only when it names the importer, the
//      one person the import can vouch for, Appendix D 62). task_tags, comments and work logs are
//      inserted before their tasks (foreign keys deferred), and each task with its tag list, comment count and
//      logged minutes, so the triggers that keep those write nothing (Appendix D 42, 46). Rows are inserted
//      through json_each, INSERT_BATCH_ROWS at a time: one sqlite_sequence write per statement, not per row;
//   4. today's fix-ups (task_counter, completedAt, lenient board configs with project boards forced to their
//      project, defaultBoardId, the sqlite_sequence heal above IMPORT_INT_MAX), and an empty foreign_key_check
//      (else 400, rolled back: on a Durable Object the check inside the transaction is what keeps a violation
//      from resetting the object at its implicit commit);
//   5. _meta.imported_at and _meta.import_result, the idempotent retry's answer (§8.4 step 5).
// v1 files carry no users: every non-null reference becomes the importer, and comments and work logs always do
// (only their author may edit them).

import { generateNKeysBetween } from 'fractional-indexing';
import { defaultBoardConfig, IMPORT_REPAIR_COLUMNS, parseBoardConfigLenient, type RepairBudget } from '@shared/board';
import { isClosedCategory, type StatusCategory } from '@shared/constants';
import { ACTIVITY_DATA_MAX_CHARS, IMPORT_INT_MAX } from '@shared/export';
import type { importMappingInput } from '@shared/schemas';
import type { ImportCandidateDTO, ImportCounts, ImportResultDTO, ImportTarget, SafetyPointDTO } from '@shared/types';
import type { z } from 'zod';
import type { Db } from '../../core/db';
import { fold } from '../../core/fold';
import { withDeferredForeignKeys } from '../../core/migrate';
import { badRequest, limitDetails } from '../../http/errors';
import { compareText } from '../../services/sql';
import { importCounts, referencedUsers } from './analysis';
import { INSERT_BATCH_ROWS, noRows, type TableRows } from './estimate';
import { MAX_PROBLEMS, type ImportArchive } from './validate';

export type ImportMapping = z.output<typeof importMappingInput>;

/** What a commit writes: the checked archive, and where its users' rows go. */
export interface ImportPlan {
  archive: ImportArchive;
  importerId: number;
  /** v2: the target of every user rows reference; null for v1 (everything is the importer's). */
  targets: Map<number, ImportTarget> | null;
  /** The accounts users are mapped to, as the candidates describe them. */
  accounts: ImportCandidateDTO[];
  skipActivity: boolean;
}

/** The commit's record in _meta (import_result): the answer, and what importCommitted is told. */
export interface StoredImport {
  result: ImportResultDTO;
  mappedUserIds: number[];
}

const META_UPSERT = `INSERT INTO _meta (key, value) VALUES (:key, :value)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE _meta.value IS NOT excluded.value`;

/**
 * Check the mapping (§8.6; 400 validation_error at `mapping`, the first problems listed): every user rows
 * reference appears once (other entries are ignored), and a `user` target is one of `candidates`, which the
 * caller asked the directory for now. v1 ignores the mapping (but not skipActivity).
 */
export function planImport(
  archive: ImportArchive,
  o: { mapping: ImportMapping | null; candidates: readonly ImportCandidateDTO[]; importerId: number },
): ImportPlan {
  const skipActivity = o.mapping?.skipActivity ?? false;
  if (archive.version === 1) return { archive, importerId: o.importerId, targets: null, accounts: [], skipActivity };
  const referenced = referencedUsers(archive);
  const candidates = new Map(o.candidates.map((c) => [c.userId, c]));
  const targets = new Map<number, ImportTarget>();
  const seen = new Set<number>();
  const problems: Array<{ path: string; message: string }> = [];
  let count = 0;
  const add = (path: string, message: string) => {
    if (++count <= MAX_PROBLEMS) problems.push({ path, message });
  };
  (o.mapping?.mapping ?? []).forEach((entry, i) => {
    if (!referenced.has(entry.archiveId)) return;
    if (seen.has(entry.archiveId)) return add(`mapping.${i}.archiveId`, `Archive user ${entry.archiveId} is mapped twice`);
    seen.add(entry.archiveId);
    if (entry.target.kind === 'user' && !candidates.has(entry.target.userId)) {
      return add(`mapping.${i}.target.userId`, `Archive user ${entry.archiveId}: account ${entry.target.userId} is not one you can choose`);
    }
    targets.set(entry.archiveId, entry.target);
  });
  for (const [archiveId, { user }] of referenced) {
    if (!seen.has(archiveId)) add('mapping', `${user.displayName} (archive user ${archiveId}) is not mapped`);
  }
  if (count > 0) {
    throw badRequest(
      `Invalid mapping (${count} problem${count === 1 ? '' : 's'}): ${problems[0]!.message}`,
      limitDetails(problems, MAX_PROBLEMS, count),
    );
  }
  const userIds = new Set([...targets.values()].flatMap((t) => (t.kind === 'user' ? [t.userId] : [])));
  const accounts = [...userIds].map((id) => candidates.get(id)!);
  return { archive, importerId: o.importerId, targets, accounts, skipActivity };
}

/** Distinct blocker ids of an archived task, ascending (its task_links rows; none in archives before them). */
const linksOf = (t: { blockedBy?: readonly number[] }) => [...new Set(t.blockedBy ?? [])].sort((a, b) => a - b);

/** Distinct tag ids of a task, ascending (its task_tags rows, and its tag_ids as the trigger writes them). */
const tagsOf = (tagIds: readonly number[]) => [...new Set(tagIds)].sort((a, b) => a - b);

/** The rows the commit inserts, per table (for estimateRowWrites). */
export function rowsToInsert(plan: ImportPlan): TableRows {
  const { archive } = plan;
  const counts = importCounts(archive, plan);
  const placeholders = plan.targets === null ? 0 : [...plan.targets.values()].filter((t) => t.kind === 'placeholder').length;
  return {
    ...noRows(),
    statuses: counts.statuses,
    tags: counts.tags,
    projects: counts.projects,
    milestones: counts.milestones,
    epics: counts.epics,
    tasks: counts.tasks,
    task_tags: archive.tasks.reduce((n, t) => n + tagsOf(t.tagIds).length, 0),
    task_links: archive.tasks.reduce((n, t) => n + linksOf(t).length, 0),
    comments: counts.comments,
    work_logs: counts.worklogs,
    activity: counts.activity,
    boards: counts.boards,
    settings: 2,
    // At most one row each (a member's row is written only when its name or address changed).
    users: plan.accounts.length + placeholders,
    _meta: 2,
  };
}

/**
 * Insert `rows` (objects keyed by column) into `table` through json_each, INSERT_BATCH_ROWS at a time and at most
 * about 1 MB of JSON per statement (a Durable Object's strings are limited to 2 MB). Each statement writes the
 * table's sqlite_sequence row once when it raises the largest id, where row-by-row inserts would write it for
 * every row.
 */
function insertRows(db: Db, table: string, columns: readonly string[], rows: Iterable<Record<string, unknown>>): void {
  const sql = `INSERT INTO ${table} (${columns.join(', ')})
    SELECT ${columns.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(:rows)`;
  let batch: string[] = [];
  let chars = 0;
  const flush = () => {
    if (batch.length === 0) return;
    db.run(sql, { rows: `[${batch.join(',')}]` });
    batch = [];
    chars = 0;
  };
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (batch.length >= INSERT_BATCH_ROWS || (batch.length > 0 && chars + text.length > MAX_BATCH_CHARS)) flush();
    batch.push(text);
    chars += text.length + 1;
  }
  flush();
}

/** JSON text of one insert statement's rows at most (a row larger than it goes alone). */
const MAX_BATCH_CHARS = 1_000_000;

/** A board config's JSON text at most (UTF-16 units: at most 768 KB of UTF-8), the bound of activity data's too. */
const MAX_CONFIG_CHARS = ACTIVITY_DATA_MAX_CHARS;

/** The domain tables, deleted in this order: the tasks first (see the header). */
const DELETE_ORDER = [
  'tasks',
  'task_tags',
  'task_links',
  'comments',
  'work_logs',
  'activity',
  'epics',
  'milestones',
  'boards',
  'projects',
  'tags',
  'statuses',
] as const;

/** Domain tables with an AUTOINCREMENT id (everything but task_tags and task_links). */
const SEQUENCED = DELETE_ORDER.filter((t) => t !== 'task_tags' && t !== 'task_links');

/** A JSON.stringify replacer that leaves out `__proto__` keys (activity data is the file's object, validate.ts). */
const withoutProto = (key: string, value: unknown) => (key === '__proto__' ? undefined : value);

/** completedAt invariant: set (kept, else now) while closed; NULL otherwise. */
const closedAt = (closed: boolean, completedAt: string | null, now: string) => (closed ? (completedAt ?? now) : null);

/** Replace the space's content with the plan's (see the header); throws 400 on a failed integrity check. */
export function writeImport(db: Db, plan: ImportPlan, o: { now: string; safety: SafetyPointDTO | null }): StoredImport {
  const { archive: d, importerId, targets } = plan;
  const { now } = o;
  return withDeferredForeignKeys(db, () => {
    // 1. Everything goes.
    for (const table of DELETE_ORDER) db.run(`DELETE FROM ${table}`);
    db.run("DELETE FROM settings WHERE substr(key, 1, 1) <> '_'");

    // 2. The mirror: members stay; the accounts and placeholders rows will name.
    db.run("DELETE FROM users WHERE is_member = 0 OR kind = 'placeholder'");
    const members = new Set(db.all<{ id: number }>('SELECT id FROM users WHERE is_member = 1').map((r) => r.id));
    db.run(
      `INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at)
       SELECT json_extract(value, '$.id'), 'account', json_extract(value, '$.name'), json_extract(value, '$.email'), 0, 0, :now
         FROM json_each(:accounts) WHERE 1
       ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email, updated_at = excluded.updated_at
       WHERE users.display_name IS NOT excluded.display_name OR users.email IS NOT excluded.email`,
      { accounts: JSON.stringify(plan.accounts.map((a) => ({ id: a.userId, name: a.displayName, email: a.email }))), now },
    );
    const userMap = new Map<number, number>();
    if (targets !== null) {
      let next = db.get<{ low: number }>('SELECT min(coalesce(min(id), 0), 0) AS low FROM users')!.low - 1;
      const users = new Map(d.users.map((u) => [u.id, u]));
      const placeholders: Array<{ id: number; name: string }> = [];
      for (const [archiveId, target] of targets) {
        if (target.kind === 'user') {
          userMap.set(archiveId, target.userId);
        } else {
          placeholders.push({ id: next, name: users.get(archiveId)?.displayName || 'Former member' });
          userMap.set(archiveId, next--);
        }
      }
      db.run(
        `INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at)
         SELECT json_extract(value, '$.id'), 'placeholder', json_extract(value, '$.name'), NULL, 0, 0, :now FROM json_each(:placeholders)`,
        { placeholders: JSON.stringify(placeholders), now },
      );
    }

    // 3. References: v2's through the mapping; v1's to the importer (comment and work-log authors always).
    const ref = (id: number | null | undefined): number | null =>
      id === null || id === undefined ? null : targets === null ? importerId : userMap.get(id)!;
    const author = (id: number | null): number | null => (targets === null ? importerId : ref(id));
    /**
     * imported_by/imported_at of a comment, work log or activity entry attributed to `by`. The importer is the one
     * person this import can vouch for: an archive's provenance is kept only when it names the importer (their own
     * earlier import, moved here), and anything the importer attributes to someone else names the importer, now.
     */
    const provenance = (by: number | null, row: { importedBy?: number | null; importedAt?: string | null }) => {
      if (ref(row.importedBy) === importerId) return { imported_by: importerId, imported_at: row.importedAt ?? now };
      return by !== null && by !== importerId ? { imported_by: importerId, imported_at: now } : { imported_by: null, imported_at: null };
    };

    const statusCategory = new Map<number, StatusCategory>();
    insertRows(
      db,
      'statuses',
      ['id', 'name', 'name_fold', 'category', 'color', 'position', 'created_at', 'updated_at'],
      d.statuses.map((s) => {
        statusCategory.set(s.id, s.category);
        const { id, name, category, color, position } = s;
        return { id, name, name_fold: fold(name), category, color, position, created_at: now, updated_at: now };
      }),
    );
    insertRows(
      db,
      'tags',
      ['id', 'name', 'name_fold', 'color', 'created_at', 'updated_at'],
      d.tags.map((t) => ({
        id: t.id,
        name: t.name,
        name_fold: fold(t.name),
        color: t.color,
        created_at: t.createdAt,
        updated_at: t.createdAt,
      })),
    );

    const maxNumber = new Map<number, number>();
    for (const t of d.tasks) maxNumber.set(t.projectId, Math.max(maxNumber.get(t.projectId) ?? 0, t.number));
    insertRows(
      db,
      'projects',
      [
        ...['id', 'key', 'name', 'name_fold', 'description', 'description_fold', 'color', 'status', 'position'],
        ...['task_counter', 'created_at', 'updated_at'],
      ],
      d.projects.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        name_fold: fold(p.name),
        description: p.description,
        description_fold: fold(p.description),
        color: p.color,
        status: p.status,
        position: p.position,
        task_counter: Math.max(p.taskCounter, maxNumber.get(p.id) ?? 0),
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      })),
    );
    const named = [
      ...['name', 'name_fold', 'description', 'description_fold', 'status', 'start_date', 'due_date', 'position'],
      ...['completed_at', 'created_at', 'updated_at'],
    ];
    insertRows(
      db,
      'milestones',
      ['id', 'project_id', ...named],
      d.milestones.map((m) => ({
        id: m.id,
        project_id: m.projectId,
        name: m.name,
        name_fold: fold(m.name),
        description: m.description,
        description_fold: fold(m.description),
        status: m.status,
        start_date: m.startDate,
        due_date: m.dueDate,
        position: m.position,
        completed_at: closedAt(m.status === 'completed' || m.status === 'cancelled', m.completedAt, now),
        created_at: m.createdAt,
        updated_at: m.updatedAt,
      })),
    );
    insertRows(
      db,
      'epics',
      ['id', 'project_id', 'milestone_id', 'color', ...named],
      d.epics.map((e) => ({
        id: e.id,
        project_id: e.projectId,
        milestone_id: e.milestoneId,
        color: e.color,
        name: e.name,
        name_fold: fold(e.name),
        description: e.description,
        description_fold: fold(e.description),
        status: e.status,
        start_date: e.startDate,
        due_date: e.dueDate,
        position: e.position,
        completed_at: closedAt(e.status === 'done' || e.status === 'cancelled', e.completedAt, now),
        created_at: e.createdAt,
        updated_at: e.updatedAt,
      })),
    );

    // Before their tasks (see the header): the triggers' updates find no task.
    insertRows(
      db,
      'task_tags',
      ['task_id', 'tag_id'],
      d.tasks.flatMap((t) => tagsOf(t.tagIds).map((tagId) => ({ task_id: t.id, tag_id: tagId }))),
    );
    const commentCount = new Map<number, number>();
    insertRows(
      db,
      'comments',
      ['id', 'task_id', 'user_id', 'body', 'created_at', 'updated_at', 'edited_at', 'imported_by', 'imported_at'],
      d.comments.map((cm) => {
        commentCount.set(cm.taskId, (commentCount.get(cm.taskId) ?? 0) + 1);
        const by = author(cm.authorId);
        return {
          id: cm.id,
          task_id: cm.taskId,
          user_id: by,
          body: cm.body,
          created_at: cm.createdAt,
          updated_at: cm.updatedAt,
          edited_at: cm.editedAt,
          ...provenance(by, cm),
        };
      }),
    );
    const loggedMinutes = new Map<number, number>();
    insertRows(
      db,
      'work_logs',
      ['id', 'task_id', 'user_id', 'date', 'minutes', 'note', 'created_at', 'updated_at', 'imported_by', 'imported_at'],
      d.worklogs.map((w) => {
        loggedMinutes.set(w.taskId, (loggedMinutes.get(w.taskId) ?? 0) + (w.minutes ?? 0));
        const by = author(w.authorId);
        return {
          id: w.id,
          task_id: w.taskId,
          user_id: by,
          date: w.date,
          minutes: w.minutes,
          note: w.note,
          created_at: w.createdAt,
          updated_at: w.updatedAt,
          ...provenance(by, w),
        };
      }),
    );

    // Fresh, evenly spaced ranks in the exported (rank, id) order, as SQLite orders them.
    const ranked = [...d.tasks].sort((a, b) => compareText(a.rank, b.rank) || a.id - b.id);
    const keys = generateNKeysBetween(null, null, ranked.length);
    const rankOf = new Map(ranked.map((t, i) => [t.id, keys[i]!]));
    insertRows(
      db,
      'tasks',
      [
        ...['id', 'project_id', 'number', 'epic_id', 'status_id', 'title', 'title_fold', 'description', 'description_fold'],
        ...['priority', 'start_date', 'due_date', 'estimate', 'rank', 'completed_at', 'archived_at', 'created_by'],
        ...['created_at', 'updated_at', 'tag_ids', 'comment_count', 'worklog_minutes'],
      ],
      d.tasks.map((t) => ({
        id: t.id,
        project_id: t.projectId,
        number: t.number,
        epic_id: t.epicId,
        status_id: t.statusId,
        title: t.title,
        title_fold: fold(t.title),
        description: t.description,
        description_fold: fold(t.description),
        priority: t.priority,
        start_date: t.startDate,
        due_date: t.dueDate,
        estimate: t.estimate,
        rank: rankOf.get(t.id)!,
        completed_at: closedAt(isClosedCategory(statusCategory.get(t.statusId)!), t.completedAt, now),
        archived_at: t.archivedAt,
        created_by: ref(t.createdBy),
        created_at: t.createdAt,
        updated_at: t.updatedAt,
        tag_ids: JSON.stringify(tagsOf(t.tagIds)),
        comment_count: commentCount.get(t.id) ?? 0,
        worklog_minutes: loggedMinutes.get(t.id) ?? 0,
      })),
    );
    // Task dependencies, after both ends exist (no trigger reads them).
    insertRows(
      db,
      'task_links',
      ['blocker_id', 'blocked_id', 'created_at'],
      d.tasks.flatMap((t) => linksOf(t).map((blockerId) => ({ blocker_id: blockerId, blocked_id: t.id, created_at: now }))),
    );

    const activity = plan.skipActivity ? [] : d.activity;
    insertRows(
      db,
      'activity',
      ['id', 'user_id', 'project_id', 'task_id', 'entity_type', 'entity_id', 'action', 'data', 'created_at', 'imported_by', 'imported_at'],
      activity.map((a) => {
        const by = ref(a.actorId);
        return {
          id: a.id,
          user_id: by,
          project_id: a.projectId,
          task_id: a.taskId,
          entity_type: a.entityType,
          entity_id: a.entityId,
          action: a.action,
          data: JSON.stringify(a.data, withoutProto),
          created_at: a.createdAt,
          ...provenance(by, a),
        };
      }),
    );

    // The repairs of every board together are bounded (Appendix D 62).
    const repairs: RepairBudget = { columns: IMPORT_REPAIR_COLUMNS };
    insertRows(
      db,
      'boards',
      ['id', 'project_id', 'name', 'description', 'config', 'position', 'created_at', 'updated_at'],
      d.boards.map((b) => {
        const parsed = parseBoardConfigLenient(b.config, repairs);
        // Project boards always show exactly their project (SPEC §8).
        const forced = (c: typeof parsed) => (b.projectId === null ? c : { ...c, filter: { ...c.filter, projectIds: [b.projectId] } });
        let config = JSON.stringify(forced(parsed));
        // A valid config can still be as large as the file; one no editor would make gets the defaults, so that no
        // row comes near a Durable Object's 2 MB (Appendix D 62).
        if (config.length > MAX_CONFIG_CHARS) config = JSON.stringify(forced(defaultBoardConfig()));
        return {
          id: b.id,
          project_id: b.projectId,
          name: b.name,
          description: b.description,
          config,
          position: b.position,
          created_at: b.createdAt,
          updated_at: b.updatedAt,
        };
      }),
    );

    // 4. The space's settings (validated: defaultBoardId names a board of the file, or is null).
    db.run("INSERT INTO settings (key, value) VALUES ('estimateUnit', :estimateUnit), ('defaultBoardId', :defaultBoardId)", {
      estimateUnit: JSON.stringify(d.settings.estimateUnit),
      defaultBoardId: JSON.stringify(d.settings.defaultBoardId),
    });

    // Imported ids are capped (IMPORT_INT_MAX), but an earlier import may have pushed an AUTOINCREMENT counter
    // towards 2^53, where new ids can't be read back as JS numbers. Deleting rows never lowers the counter, so
    // heal over-limit counters here; normal ones are left alone so ids are still never reused.
    for (const table of SEQUENCED) {
      db.run(
        `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM ${table})
          WHERE name = :table AND seq > :max`,
        { table, max: IMPORT_INT_MAX },
      );
    }

    const violations = db.all<{ table: string; rowid: number | null; parent: string }>('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw badRequest(
        'The imported data failed the database integrity check',
        limitDetails(
          violations.map((v) => ({ path: v.table, message: `Row ${v.rowid ?? '?'} references a missing ${v.parent} row` })),
          MAX_PROBLEMS,
        ),
      );
    }

    // 5. The record of this import.
    const counts: ImportCounts = importCounts(d, plan);
    const stored: StoredImport = {
      result: {
        ok: true,
        counts,
        safety: o.safety,
        nonMemberAuthors: plan.accounts.filter((a) => !members.has(a.userId)),
      },
      mappedUserIds: targets === null ? [importerId] : plan.accounts.map((a) => a.userId),
    };
    db.run(META_UPSERT, { key: 'imported_at', value: now });
    db.run(META_UPSERT, { key: 'import_result', value: JSON.stringify(stored) });
    return stored;
  });
}

/** The record of the import that filled this space (_meta), or null when none has. */
export function storedImport(db: Db): StoredImport | null {
  if (!db.get("SELECT 1 AS done FROM _meta WHERE key = 'imported_at'")) return null;
  const row = db.get<{ value: string }>("SELECT value FROM _meta WHERE key = 'import_result'");
  try {
    return row ? (JSON.parse(row.value) as StoredImport) : null;
  } catch {
    return null;
  }
}
