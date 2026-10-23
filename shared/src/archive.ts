// The space archive, format version 2 (design §8.2): the portable form of one space, the same on both
// runtimes, and how data moves between instances. Its rows have the v1 shapes (./export.ts), with original ids,
// except that every user reference (tasks' createdBy, comments' and work logs' authorId, activity's actorId,
// and the provenance `importedBy` of comments, work logs and activity) is null or the id of one of `users`:
// positive for accounts, negative for placeholders ("former members" known by name only). The archive is
// written gzip-compressed (archiveFileName); an import also takes it, and v1 exports, uncompressed (isGzip).
// Shapes only: the server checks referential integrity, the users included (server/src/space/archive/).

import { z } from 'zod';
import { ESTIMATE_UNITS } from './constants';
import {
  EXPORT_TABLES,
  exportIdSchema,
  exportRowSchemasFor,
  exportTableList,
  exportTimestampSchema,
  IMPORT_INT_MAX,
  type ExportTable,
} from './export';

export const ARCHIVE_FORMAT = 'lyren-plan-space';
export const ARCHIVE_FORMAT_VERSION = 2;
/** The format of today's v1 exports, which an import still takes. */
export const EXPORT_FORMAT = 'lyren-plan-export';

/** Users an archive lists at most. */
export const ARCHIVE_USERS_MAX = 10_000;

/** A user reference of an archive: an id of its `users`, never 0, within ±IMPORT_INT_MAX. */
export const archiveUserRefSchema = z
  .number()
  .int()
  .min(-IMPORT_INT_MAX)
  .max(IMPORT_INT_MAX)
  .refine((v) => v !== 0, 'Must not be 0');

/** One of an archive's users: an account (positive id) or a placeholder (negative id). */
export const archiveUserSchema = z.object({
  id: archiveUserRefSchema,
  kind: z.enum(['account', 'placeholder']),
  displayName: z.string().trim().min(1).max(200),
  /** The mirror's address of a live account; normalized when it is used, and treated as null when invalid. */
  email: z.string().max(320).nullable(),
});

/** Who an earlier import attributed a row to someone else for (design §8.6), kept through the archive. */
const provenance = {
  importedBy: archiveUserRefSchema.nullable().optional(),
  importedAt: exportTimestampSchema.nullable().optional(),
};

const rows = exportRowSchemasFor(archiveUserRefSchema);

/** One row of each table of an archive (checked one at a time, as a v1 export's are). */
export const archiveRowSchemas = {
  ...rows,
  /** `blockedBy`: the task's blockers (task dependencies), absent in archives written before them. */
  tasks: rows.tasks.extend({ blockedBy: z.array(exportIdSchema).max(10_000).optional() }),
  comments: rows.comments.extend(provenance),
  worklogs: rows.worklogs.extend(provenance),
  activity: rows.activity.extend(provenance),
};

/** The fields of an archive besides its users and tables. */
const archiveHeader = {
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  exportedAt: exportTimestampSchema,
  appVersion: z.string().max(50),
  space: z.object({
    id: z.string().max(100),
    name: z.string().trim().min(1).max(200),
    exportedBy: archiveUserRefSchema.nullable(),
  }),
  /** The space's settings (SpaceSettings); other keys are ignored. */
  settings: z.object({
    estimateUnit: z.enum(ESTIMATE_UNITS),
    defaultBoardId: exportIdSchema.nullable(),
  }),
};

export const spaceArchiveSchema = z.object({
  ...archiveHeader,
  users: z.array(archiveUserSchema).max(ARCHIVE_USERS_MAX),
  statuses: exportTableList('statuses', archiveRowSchemas.statuses),
  tags: exportTableList('tags', archiveRowSchemas.tags),
  projects: exportTableList('projects', archiveRowSchemas.projects),
  milestones: exportTableList('milestones', archiveRowSchemas.milestones),
  epics: exportTableList('epics', archiveRowSchemas.epics),
  tasks: exportTableList('tasks', archiveRowSchemas.tasks),
  comments: exportTableList('comments', archiveRowSchemas.comments),
  worklogs: exportTableList('worklogs', archiveRowSchemas.worklogs),
  activity: exportTableList('activity', archiveRowSchemas.activity),
  boards: exportTableList('boards', archiveRowSchemas.boards),
});

/** An archive with its users and rows left unchecked: the header, and each list within its cap. */
export const archiveFrameSchema = z.object({
  ...archiveHeader,
  users: z.array(z.unknown()).max(ARCHIVE_USERS_MAX),
  ...(Object.fromEntries(EXPORT_TABLES.map((table) => [table, exportTableList(table, z.unknown())])) as Record<
    ExportTable,
    z.ZodArray<z.ZodUnknown>
  >),
});

export type ArchiveInput = z.input<typeof spaceArchiveSchema>;
export type ArchiveParsed = z.output<typeof spaceArchiveSchema>;

/**
 * A file's formatVersion as a refusal names it: a number, or a string of at most 20 characters, as JSON; null for
 * anything else, which the refusal leaves unnamed, so that it never repeats the file (a version of 4 MB).
 */
export function formatVersionText(value: unknown): string | null {
  return typeof value === 'number' || (typeof value === 'string' && value.length <= 20) ? JSON.stringify(value) : null;
}

/** Whether `bytes` start with the gzip magic bytes 1f 8b (an archive as exported; a .json file is not). */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * The space's name as a file name part: lower-cased, every run of characters outside [a-z0-9] one `-`,
 * trimmed of them, at most 40 characters; `space` when nothing is left.
 */
export function archiveSlug(name: string): string {
  const trim = (s: string) => s.replace(/^-+|-+$/g, '');
  return trim(trim(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 40)) || 'space';
}

/** `lyren-space-<slug>-<YYYY-MM-DD>.json.gz`; `date` is the server's UTC date. */
export function archiveFileName(spaceName: string, date: string): string {
  return `lyren-space-${archiveSlug(spaceName)}-${date}.json.gz`;
}
