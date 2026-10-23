// Validating an import file (design §8.7, SPEC §5.10): a v1 export (`lyren-plan-export`/1) or a space archive
// (`lyren-plan-space`/2), already parsed from JSON. Each answers 400 listing the first 50 problems, and nothing
// is changed:
//   1. the format and version;
//   2. the shape: the frame (the header, and each list within its cap: a few issues at most), then each row
//      against its row schema through parseBounded, one at a time, stopping after 50 problems: zod describes
//      every failing item of a list, so a large file of bad rows would make millions of issues, and a whole
//      archive is never parsed at once (Appendix D 44);
//   3. the integrity: every check of SPEC §5.10 for both versions (unique ids and names, references between
//      the tables, the value rules later edits re-check), and for v2 the users: ids unique, the kind matching
//      the sign of the id, every user reference of a row (and space.exportedBy) one of them. Every problem is
//      counted, the first 50 kept.
// What passes becomes an ImportArchive: v1 rows have the v2 shapes without provenance, activity whose task or
// project is missing is dropped, and a defaultBoardId naming no board of the file becomes null.

import type { z } from 'zod';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  archiveFrameSchema,
  archiveRowSchemas,
  archiveUserSchema,
  EXPORT_FORMAT,
  formatVersionText,
  type ArchiveParsed,
} from '@shared/archive';
import { parseBounded } from '@shared/bounded';
import type { EstimateUnit } from '@shared/constants';
import { normalizeEmail } from '@shared/email';
import { EXPORT_TABLES, exportFrameSchema, exportRowSchemas, type ExportTable } from '@shared/export';
import { findCycle as linkCycle, type TaskLink } from '@shared/schedule';
import { badRequest, issueDetail, limitDetails } from '../../http/errors';

/** Problems listed in a 400 response at most (the message states the total). */
export const MAX_PROBLEMS = 50;

type Problem = { path: string; message: string };

/** One of an archive's users, its address normalized (null when it has none, or an invalid one). */
export interface ImportUser {
  id: number;
  kind: 'account' | 'placeholder';
  displayName: string;
  email: string | null;
  /** normalizeEmail's key of `email`, what candidates are matched by (§8.5). */
  emailKey: string | null;
}

/** A file that passed validation, in the v2 shapes. */
export interface ImportArchive {
  version: 1 | 2;
  exportedAt: string;
  appVersion: string;
  /** The archive's space (v2); null for a v1 export. */
  space: { name: string; exportedBy: number | null } | null;
  /** v2's users; [] for v1, whose every reference becomes the importer. */
  users: ImportUser[];
  /** The space's settings, defaultBoardId null unless it names a board of the file. */
  settings: { estimateUnit: EstimateUnit; defaultBoardId: number | null };
  statuses: ArchiveParsed['statuses'];
  tags: ArchiveParsed['tags'];
  projects: ArchiveParsed['projects'];
  milestones: ArchiveParsed['milestones'];
  epics: ArchiveParsed['epics'];
  tasks: ArchiveParsed['tasks'];
  comments: ArchiveParsed['comments'];
  worklogs: ArchiveParsed['worklogs'];
  /** Without the entries whose task or project the file does not have (they are dropped). */
  activity: ArchiveParsed['activity'];
  boards: ArchiveParsed['boards'];
}

/** The format the analysis names (ImportAnalysisDTO.format). */
export const formatOf = (archive: Pick<ImportArchive, 'version'>) =>
  archive.version === 2 ? ('lyren-plan-space/2' as const) : ('lyren-plan-export/1' as const);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ids a problem lists at most (then "and <n> more"). */
const MAX_LISTED_IDS = 10;

/** "4, 5, 6", or the first MAX_LISTED_IDS and "and 98 more". */
function idList(ids: readonly number[]): string {
  const listed = ids.slice(0, MAX_LISTED_IDS).join(', ');
  return ids.length > MAX_LISTED_IDS ? `${listed} and ${ids.length - MAX_LISTED_IDS} more` : listed;
}

/** Validate a parsed import file (see the header); throws 400. */
export function validateArchive(body: unknown): ImportArchive {
  if (!isPlainObject(body) || (body.format !== ARCHIVE_FORMAT && body.format !== EXPORT_FORMAT)) {
    throw badRequest('This is not a Lyren Plan export file', [
      { path: 'format', message: `Expected "${ARCHIVE_FORMAT}" or "${EXPORT_FORMAT}"` },
    ]);
  }
  const version = body.format === ARCHIVE_FORMAT ? ARCHIVE_FORMAT_VERSION : 1;
  if (body.formatVersion !== version) {
    const named = formatVersionText(body.formatVersion);
    throw badRequest(`Unsupported export format version${named === null ? '' : ` ${named}`}`, [
      { path: 'formatVersion', message: 'Only versions 1 and 2 are supported' },
    ]);
  }
  return checkIntegrity(version, readRows(version, body));
}

type Rows = Record<ExportTable, unknown[]> & { users: unknown[] };
type Frame = z.output<typeof archiveFrameSchema> | z.output<typeof exportFrameSchema>;

/** Step 2: the frame, then every row on its own (parseBounded), until more than MAX_PROBLEMS are found. */
function readRows(version: 1 | 2, body: Record<string, unknown>): { frame: Frame; rows: Rows } {
  const problems: Problem[] = [];
  const frame = (version === 2 ? archiveFrameSchema : exportFrameSchema).safeParse(body);
  const frameIssues = frame.success ? [] : frame.error.issues;
  for (const issue of frameIssues) problems.push(issueDetail(issue));
  const schemas: Array<[ExportTable | 'users', z.ZodType]> = [
    ...(version === 2 ? [['users', archiveUserSchema] as [ExportTable | 'users', z.ZodType]] : []),
    ...EXPORT_TABLES.map((table): [ExportTable, z.ZodType] => [table, (version === 2 ? archiveRowSchemas : exportRowSchemas)[table]]),
  ];
  const rows = { users: [] } as unknown as Rows;
  for (const [table, schema] of schemas) {
    const list = body[table];
    const parsed: unknown[] = (rows[table] = []);
    // A list that is not one, or is too long, is the frame's problem.
    if (!Array.isArray(list) || frameIssues.some((issue) => issue.path[0] === table)) continue;
    for (let i = 0; i < list.length && problems.length <= MAX_PROBLEMS; i++) {
      const row = parseBounded(schema, list[i]);
      if (row === null) problems.push({ path: `${table}.${i}`, message: 'Invalid row (too many values to list its problems)' });
      else if (!row.success) for (const issue of row.error.issues) problems.push(issueDetail(issue, `${table}.${i}`));
      // An activity entry's data stays the file's own object, which the parse's equals but for its key order (it
      // lists the known keys first): an export imported and exported again is the same, byte for byte. The commit
      // leaves out __proto__ keys, as the parse does.
      else parsed.push(table === 'activity' ? { ...(row.data as object), data: (list[i] as { data: unknown }).data } : row.data);
    }
  }
  if (problems.length > 0) {
    const first = problems[0]!;
    const more = problems.length > MAX_PROBLEMS;
    const count = more ? `more than ${MAX_PROBLEMS} problems` : `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
    throw badRequest(
      `Invalid export file (${count}): ${first.path ? `${first.path}: ${first.message}` : first.message}`,
      more ? [...problems.slice(0, MAX_PROBLEMS), { path: '', message: '…and more problems' }] : problems,
    );
  }
  return { frame: frame.data!, rows };
}

/** Step 3 (see the header); throws 400 listing the first problems. */
function checkIntegrity(version: 1 | 2, { frame, rows }: { frame: Frame; rows: Rows }): ImportArchive {
  const d = rows as unknown as Omit<ImportArchive, 'users'> & { users: z.output<typeof archiveUserSchema>[] };
  // Every problem is counted; the first MAX_PROBLEMS are kept (a file can hold a million inconsistent rows).
  const problems: Problem[] = [];
  let count = 0;
  const add = (p: string, message: string) => {
    if (++count <= MAX_PROBLEMS) problems.push({ path: p, message });
  };

  function uniqueIds(table: string, list: ReadonlyArray<{ id: number }>, label: string): Set<number> {
    const seen = new Set<number>();
    list.forEach((row, i) => {
      if (seen.has(row.id)) add(`${table}.${i}.id`, `Duplicate ${label} id ${row.id}`);
      seen.add(row.id);
    });
    return seen;
  }

  function uniqueNames(table: string, list: ReadonlyArray<Record<string, unknown>>, field: string, label: string) {
    const seen = new Set<string>();
    list.forEach((row, i) => {
      const value = String(row[field]);
      const folded = value.toLowerCase();
      if (seen.has(folded)) add(`${table}.${i}.${field}`, `Duplicate ${label} “${value}”`);
      seen.add(folded);
    });
  }

  // v2: the users, and every reference to them.
  const userIds = uniqueIds('users', d.users, 'user');
  d.users.forEach((u, i) => {
    if ((u.kind === 'placeholder') !== u.id < 0) {
      add(`users.${i}.kind`, `User ${u.id}: an account has a positive id, a placeholder a negative one`);
    }
  });
  const userRef = (path: string, label: string, ref: number | null | undefined) => {
    if (version === 2 && ref !== null && ref !== undefined && !userIds.has(ref)) add(path, `${label}: user ${ref} is not in users`);
  };
  if (version === 2) {
    const exportedBy = (frame as z.output<typeof archiveFrameSchema>).space.exportedBy;
    if (exportedBy !== null && !userIds.has(exportedBy)) add('space.exportedBy', `The exporting user ${exportedBy} is not in users`);
  }

  const statusIds = uniqueIds('statuses', d.statuses, 'status');
  uniqueNames('statuses', d.statuses, 'name', 'status name');
  const tagIds = uniqueIds('tags', d.tags, 'tag');
  uniqueNames('tags', d.tags, 'name', 'tag name');
  const projectIds = uniqueIds('projects', d.projects, 'project');
  uniqueNames('projects', d.projects, 'key', 'project key');
  uniqueIds('milestones', d.milestones, 'milestone');
  uniqueIds('epics', d.epics, 'epic');
  const taskIds = uniqueIds('tasks', d.tasks, 'task');
  uniqueIds('comments', d.comments, 'comment');
  uniqueIds('worklogs', d.worklogs, 'work log');
  uniqueIds('activity', d.activity, 'activity');
  const boardIds = uniqueIds('boards', d.boards, 'board');

  const milestoneProject = new Map<number, number>();
  d.milestones.forEach((m, i) => {
    if (!projectIds.has(m.projectId)) add(`milestones.${i}.projectId`, `Milestone ${m.id}: project ${m.projectId} does not exist`);
    milestoneProject.set(m.id, m.projectId);
  });

  const epicProject = new Map<number, number>();
  d.epics.forEach((e, i) => {
    if (!projectIds.has(e.projectId)) add(`epics.${i}.projectId`, `Epic ${e.id}: project ${e.projectId} does not exist`);
    if (e.milestoneId !== null) {
      const mp = milestoneProject.get(e.milestoneId);
      if (mp === undefined) add(`epics.${i}.milestoneId`, `Epic ${e.id}: milestone ${e.milestoneId} does not exist`);
      else if (mp !== e.projectId) {
        add(`epics.${i}.milestoneId`, `Epic ${e.id}: milestone ${e.milestoneId} belongs to another project`);
      }
    }
    epicProject.set(e.id, e.projectId);
  });

  const numbers = new Set<string>();
  const links: TaskLink[] = [];
  d.tasks.forEach((t, i) => {
    if (!projectIds.has(t.projectId)) add(`tasks.${i}.projectId`, `Task ${t.id}: project ${t.projectId} does not exist`);
    if (!statusIds.has(t.statusId)) add(`tasks.${i}.statusId`, `Task ${t.id}: status ${t.statusId} does not exist`);
    if (t.epicId !== null) {
      const ep = epicProject.get(t.epicId);
      if (ep === undefined) add(`tasks.${i}.epicId`, `Task ${t.id}: epic ${t.epicId} does not exist`);
      else if (ep !== t.projectId) add(`tasks.${i}.epicId`, `Task ${t.id}: epic ${t.epicId} belongs to another project`);
    }
    const unknownTags = [...new Set(t.tagIds)].filter((id) => !tagIds.has(id));
    if (unknownTags.length > 0) {
      add(`tasks.${i}.tagIds`, `Task ${t.id}: unknown tag id${unknownTags.length > 1 ? 's' : ''} ${idList(unknownTags)}`);
    }
    const numberKey = `${t.projectId}:${t.number}`;
    if (numbers.has(numberKey)) add(`tasks.${i}.number`, `Task ${t.id}: number ${t.number} is used twice in project ${t.projectId}`);
    numbers.add(numberKey);
    userRef(`tasks.${i}.createdBy`, `Task ${t.id}`, t.createdBy);
    const blockedBy = 'blockedBy' in t && Array.isArray(t.blockedBy) ? (t.blockedBy as number[]) : [];
    const unknownBlockers = [...new Set(blockedBy)].filter((id) => !taskIds.has(id) || id === t.id);
    if (unknownBlockers.length > 0) {
      add(`tasks.${i}.blockedBy`, `Task ${t.id}: unknown or own blocker id${unknownBlockers.length > 1 ? 's' : ''} ${idList(unknownBlockers)}`);
    } else {
      for (const blockerId of blockedBy) links.push({ blockerId, blockedId: t.id });
    }
  });
  // The links must not loop (task dependencies): one walk of them.
  const looped = linkCycle(links);
  if (looped !== null) add('tasks', `Task ${looped}: its blockers loop back to it`);

  d.comments.forEach((cm, i) => {
    if (!taskIds.has(cm.taskId)) add(`comments.${i}.taskId`, `Comment ${cm.id}: task ${cm.taskId} does not exist`);
    userRef(`comments.${i}.authorId`, `Comment ${cm.id}`, cm.authorId);
    userRef(`comments.${i}.importedBy`, `Comment ${cm.id}`, cm.importedBy);
  });
  d.worklogs.forEach((w, i) => {
    if (!taskIds.has(w.taskId)) add(`worklogs.${i}.taskId`, `Work log ${w.id}: task ${w.taskId} does not exist`);
    // The rule every later edit re-checks on the merged row (SPEC §5.6).
    if (!((w.minutes ?? 0) > 0 || w.note.trim().length > 0)) {
      add(`worklogs.${i}.note`, `Work log ${w.id}: has neither time spent nor a note`);
    }
    userRef(`worklogs.${i}.authorId`, `Work log ${w.id}`, w.authorId);
    userRef(`worklogs.${i}.importedBy`, `Work log ${w.id}`, w.importedBy);
  });
  d.activity.forEach((a, i) => {
    userRef(`activity.${i}.actorId`, `Activity ${a.id}`, a.actorId);
    userRef(`activity.${i}.importedBy`, `Activity ${a.id}`, a.importedBy);
  });

  // startDate <= dueDate: every later edit of such a row (even a status change) re-checks it.
  const dateOrder = (table: 'tasks' | 'milestones' | 'epics', label: string) =>
    d[table].forEach((row, i) => {
      if (row.startDate !== null && row.dueDate !== null && row.startDate > row.dueDate) {
        add(`${table}.${i}.dueDate`, `${label} ${row.id}: due date ${row.dueDate} is before start date ${row.startDate}`);
      }
    });
  dateOrder('milestones', 'Milestone');
  dateOrder('epics', 'Epic');
  dateOrder('tasks', 'Task');
  d.boards.forEach((b, i) => {
    if (b.projectId !== null && !projectIds.has(b.projectId)) {
      add(`boards.${i}.projectId`, `Board ${b.id}: project ${b.projectId} does not exist`);
    }
  });

  if (count > 0) {
    throw badRequest(
      `The export file is inconsistent (${count} problem${count === 1 ? '' : 's'}): ${problems[0]!.message}`,
      limitDetails(problems, MAX_PROBLEMS, count),
    );
  }

  const { defaultBoardId, estimateUnit } = frame.settings;
  const space = version === 2 ? (frame as z.output<typeof archiveFrameSchema>).space : null;
  return {
    ...d,
    version,
    exportedAt: frame.exportedAt,
    appVersion: frame.appVersion,
    space: space && { name: space.name, exportedBy: space.exportedBy },
    users: d.users.map((u) => {
      // Placeholders have no address; an invalid one counts as none (§8.2).
      const email = u.kind === 'account' && u.email !== null ? normalizeEmail(u.email) : null;
      return email?.ok
        ? { id: u.id, kind: u.kind, displayName: u.displayName, email: email.address, emailKey: email.key }
        : { id: u.id, kind: u.kind, displayName: u.displayName, email: null, emailKey: null };
    }),
    settings: { estimateUnit, defaultBoardId: defaultBoardId !== null && boardIds.has(defaultBoardId) ? defaultBoardId : null },
    activity: d.activity.filter(
      (a) => (a.taskId === null || taskIds.has(a.taskId)) && (a.projectId === null || projectIds.has(a.projectId)),
    ),
  };
}
