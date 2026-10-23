// Zod schemas for every API input. The server validates requests with these and
// the web client reuses them for form validation, so they are the API contract.
//
// zod v4 notes (important):
//  - Input schemas deliberately contain NO .default() values. Servers apply
//    defaults explicitly. (In zod 4, defaults inside .optional()/.partial() are
//    still applied, which would make PATCH requests overwrite fields.)
//  - Use .prefault() (not .default()) when a nested object default must itself
//    be parsed through the schema (see board.ts).

import { z } from 'zod';
import {
  DUE_PRESETS,
  EPIC_STATUSES,
  ESTIMATE_UNITS,
  LIMITS,
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  SIGNUP_POLICIES,
  STATUS_CATEGORIES,
} from './constants';
import { isValidISODate, type WeekStart } from './dates';
import { emailSchema } from './email';
import { INVITABLE_ROLES, SPACE_ROLES } from './roles';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** For ids that arrive as strings (route params, query strings). */
export const idParamSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const isoDateSchema = z.string().refine(isValidISODate, 'Expected a date in YYYY-MM-DD format');
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a color like #3b82f6')
  .transform((v) => v.toLowerCase());
export const prioritySchema = z.literal([0, 1, 2, 3, 4]);
export const statusCategorySchema = z.enum(STATUS_CATEGORIES);
export const weekStartSchema = z.literal([0, 1]);
/** weekStartsOn in a query string: '0' (Sunday) or '1' (Monday). */
export const weekStartParamSchema = z.enum(['0', '1']).transform((v): WeekStart => (v === '0' ? 0 : 1));
export const homePageSchema = z.enum(['dashboard', 'default_board']);
export const spaceRoleSchema = z.enum(SPACE_ROLES);

const nameSchema = z.string().trim().min(1, 'Required').max(LIMITS.nameMax);
const descriptionSchema = z.string().max(LIMITS.descriptionMax);
const estimateSchema = z.number().min(0).max(100_000);

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[A-Z][A-Z0-9]{${LIMITS.projectKeyMin - 1},${LIMITS.projectKeyMax - 1}}$`),
    `Key must be ${LIMITS.projectKeyMin}-${LIMITS.projectKeyMax} letters/digits and start with a letter`,
  );

// ---------------------------------------------------------------------------
// Auth & account
// ---------------------------------------------------------------------------

export const usernameSchema = z
  .string()
  .trim()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, dashes or underscores');
export const passwordSchema = z.string().min(LIMITS.passwordMin, `At least ${LIMITS.passwordMin} characters`).max(LIMITS.passwordMax);
export const displayNameSchema = z.string().trim().min(1, 'Required').max(LIMITS.displayNameMax);

/** POST /api/auth/setup: the first account (an instance admin). New installs sign in by email. */
export const setupInput = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  createSampleData: z.boolean().optional(),
  /** First-run setup code printed in the server log (required unless the server disables it). */
  setupCode: z.string().max(200).optional(),
  /** The client's local date; sample data is dated relative to it (default: server UTC date). */
  today: isoDateSchema.optional(),
});
export type SetupInput = z.input<typeof setupInput>;

const identifierSchema = z.string().trim().min(1, 'Required').max(LIMITS.identifierMax);

/**
 * POST /api/auth/login: an email address or a legacy username in `identifier`. The body of clients
 * from before the multi-user upgrade, `{ username, password }`, is accepted too (an open tab can
 * still sign in). Parses to `{ identifier, password }`.
 */
export const loginInput = z
  .object({
    identifier: identifierSchema.optional(),
    username: identifierSchema.optional(),
    password: z.string().min(1, 'Required').max(LIMITS.passwordMax),
  })
  .refine((v) => v.identifier !== undefined || v.username !== undefined, { message: 'Required', path: ['identifier'] })
  .transform(({ identifier, username, password }) => ({ identifier: (identifier ?? username)!, password }));
export type LoginInput = z.input<typeof loginInput>;

/** PATCH /api/account. */
export const updateAccountInput = z.object({ displayName: displayNameSchema });
export type UpdateAccountInput = z.input<typeof updateAccountInput>;

/**
 * POST /api/account/password. `currentPassword` is required (and checked by the server) when the
 * account has a password; an account without one needs the re-auth window instead.
 */
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, 'Required').max(LIMITS.passwordMax).optional(),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.input<typeof changePasswordInput>;

/** POST /api/account/reauth/password: refreshes the re-auth window. */
export const reauthPasswordInput = z.object({ password: z.string().min(1, 'Required').max(LIMITS.passwordMax) });
export type ReauthPasswordInput = z.input<typeof reauthPasswordInput>;

/** DELETE /api/account: `confirm` is the account's email address, or its username when it has none. */
export const accountDeleteInput = z.object({ confirm: z.string().trim().min(1, 'Required').max(LIMITS.identifierMax) });
export type AccountDeleteInput = z.input<typeof accountDeleteInput>;

// ---------------------------------------------------------------------------
// Spaces and members
// ---------------------------------------------------------------------------

const spaceNameSchema = z.string().trim().min(1, 'Required').max(LIMITS.spaceNameMax);

/** POST /api/spaces. */
export const spaceCreateInput = z.object({
  name: spaceNameSchema,
  createSampleData: z.boolean().optional(),
  /** The client's local date; sample data is dated relative to it (default: server UTC date). */
  today: isoDateSchema.optional(),
  /** Create the space empty and 'importing', for an archive import into a new space (§8.4). */
  forImport: z.boolean().optional(),
});
export type SpaceCreateInput = z.input<typeof spaceCreateInput>;

/** PATCH /api/spaces/:spaceId (owner). */
export const spaceUpdateInput = z.object({ name: spaceNameSchema });
export type SpaceUpdateInput = z.input<typeof spaceUpdateInput>;

/** DELETE /api/spaces/:spaceId (owner, re-auth): `confirmName` must equal the space's name. */
export const spaceDeleteInput = z.object({ confirmName: z.string().trim().min(1, 'Required').max(LIMITS.spaceNameMax) });
export type SpaceDeleteInput = z.input<typeof spaceDeleteInput>;

/** PATCH /api/spaces/:spaceId/members/:userId (who may set what: roles.ts canChangeRole). */
export const memberRoleInput = z.object({ role: spaceRoleSchema });
export type MemberRoleInput = z.input<typeof memberRoleInput>;

/**
 * POST /api/spaces/:spaceId/transfer (owner, re-auth): `userId`, a member, becomes an owner; with
 * `demoteSelfTo` the caller then takes that role, in the same transaction.
 */
export const transferInput = z.object({
  userId: idSchema,
  demoteSelfTo: z.enum(INVITABLE_ROLES).optional(),
});
export type TransferInput = z.input<typeof transferInput>;

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** Full ordered list of ids in a scope (e.g. all milestones of one project). */
export const reorderInput = z.object({ ids: z.array(idSchema).min(1).max(10_000) });
export type ReorderInput = z.infer<typeof reorderInput>;

// ---------------------------------------------------------------------------
// Projects / milestones / epics
// ---------------------------------------------------------------------------

export const projectCreateInput = z.object({
  name: nameSchema,
  key: projectKeySchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectCreateInput = z.input<typeof projectCreateInput>;

export const projectUpdateInput = z.object({
  name: nameSchema.optional(),
  key: projectKeySchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectUpdateInput = z.input<typeof projectUpdateInput>;

export const milestoneCreateInput = z.object({
  projectId: idSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type MilestoneCreateInput = z.input<typeof milestoneCreateInput>;

export const milestoneUpdateInput = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type MilestoneUpdateInput = z.input<typeof milestoneUpdateInput>;

export const epicCreateInput = z.object({
  projectId: idSchema,
  milestoneId: idSchema.nullable().optional(),
  name: nameSchema,
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(EPIC_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type EpicCreateInput = z.input<typeof epicCreateInput>;

export const epicUpdateInput = z.object({
  milestoneId: idSchema.nullable().optional(),
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  color: colorSchema.optional(),
  status: z.enum(EPIC_STATUSES).optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});
export type EpicUpdateInput = z.input<typeof epicUpdateInput>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Manual ordering, always in ASCENDING-RANK terms: `afterId` = the neighbour with the
 * lower rank, `beforeId` = the neighbour with the higher rank. (In a view sorted
 * manual/desc, pass the card visually BELOW as afterId and the one ABOVE as beforeId.)
 * The server places the task directly after `afterId` in the GLOBAL rank order (or
 * directly before `beforeId` when only that is given); both null/omitted = no-op.
 * 'top' / 'bottom' place it globally first / last. See SPEC §5.5.
 */
const neighbourPositionShape = {
  afterId: idSchema.nullable().optional(),
  beforeId: idSchema.nullable().optional(),
};
export const rankPositionSchema = z.union([z.literal('top'), z.literal('bottom'), z.object(neighbourPositionShape)]);
export type RankPosition = z.infer<typeof rankPositionSchema>;

/**
 * Task updates also take `{ rank }`: put the task back at a rank it had before (the Undo of a
 * move). The server keeps that exact rank when no other task holds it, else places the task
 * directly after the one that does. See SPEC §5.5.
 */
export const rankRestoreSchema = z.object({
  rank: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[0-9A-Za-z]+$/, 'Not a rank'),
});
// Strict neighbours here, so a malformed `rank` is a 400 rather than a silent no-op `{}`.
export const taskPositionSchema = z.union([
  z.literal('top'),
  z.literal('bottom'),
  rankRestoreSchema,
  z.strictObject(neighbourPositionShape),
]);
export type TaskPosition = z.infer<typeof taskPositionSchema>;

const tagIdsSchema = z.array(idSchema).max(100);

export const taskCreateInput = z.object({
  projectId: idSchema,
  epicId: idSchema.nullable().optional(),
  statusId: idSchema.optional(),
  title: z.string().trim().min(1, 'Required').max(LIMITS.titleMax),
  description: descriptionSchema.optional(),
  priority: prioritySchema.optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  estimate: estimateSchema.nullable().optional(),
  tagIds: tagIdsSchema.optional(),
  position: rankPositionSchema.optional(),
});
export type TaskCreateInput = z.input<typeof taskCreateInput>;

export const taskUpdateInput = z.object({
  projectId: idSchema.optional(),
  epicId: idSchema.nullable().optional(),
  statusId: idSchema.optional(),
  title: z.string().trim().min(1, 'Required').max(LIMITS.titleMax).optional(),
  description: descriptionSchema.optional(),
  priority: prioritySchema.optional(),
  startDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  estimate: estimateSchema.nullable().optional(),
  /** Replaces the full tag set. Mutually exclusive with addTagIds/removeTagIds. */
  tagIds: tagIdsSchema.optional(),
  addTagIds: tagIdsSchema.optional(),
  removeTagIds: tagIdsSchema.optional(),
  archived: z.boolean().optional(),
  position: taskPositionSchema.optional(),
});
export type TaskUpdateInput = z.input<typeof taskUpdateInput>;

export const taskBulkPatchSchema = z.object({
  statusId: idSchema.optional(),
  priority: prioritySchema.optional(),
  epicId: idSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  addTagIds: tagIdsSchema.optional(),
  removeTagIds: tagIdsSchema.optional(),
  archived: z.boolean().optional(),
});
export const taskBulkUpdateInput = z.object({
  ids: z.array(idSchema).min(1).max(LIMITS.bulkMax),
  patch: taskBulkPatchSchema,
});
export type TaskBulkUpdateInput = z.input<typeof taskBulkUpdateInput>;

export const taskBulkDeleteInput = z.object({ ids: z.array(idSchema).min(1).max(LIMITS.bulkMax) });
export type TaskBulkDeleteInput = z.input<typeof taskBulkDeleteInput>;

// ---------------------------------------------------------------------------
// Task filter & sort (used by /api/tasks/query and stored inside board configs)
// ---------------------------------------------------------------------------

/**
 * All present criteria are ANDed. Within an array criterion values are ORed.
 * An omitted or EMPTY array means "no constraint". `null` inside milestoneIds /
 * epicIds / tagIds means "has none". See SPEC.md §Filter semantics and
 * matchesTaskFilter() in ./filter.ts (the reference implementation).
 */
export const taskFilterSchema = z.object({
  /** Only these tasks (e.g. the palette refreshing its Recent list). */
  ids: z.array(idSchema).max(1000).optional(),
  projectIds: z.array(idSchema).max(1000).optional(),
  milestoneIds: z.array(idSchema.nullable()).max(1000).optional(),
  epicIds: z.array(idSchema.nullable()).max(1000).optional(),
  statusIds: z.array(idSchema).max(200).optional(),
  statusCategories: z.array(statusCategorySchema).optional(),
  priorities: z.array(prioritySchema).optional(),
  tagIds: z.array(idSchema.nullable()).max(500).optional(),
  tagMode: z.enum(['any', 'all']).optional(),
  excludeTagIds: z.array(idSchema).max(500).optional(),
  due: z.array(z.enum(DUE_PRESETS)).optional(),
  dueFrom: isoDateSchema.optional(),
  dueTo: isoDateSchema.optional(),
  search: z.string().max(LIMITS.searchMax).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(),
  /** When set, closed tasks are only included if completedAt is within the last N days (0 = hide all closed). */
  closedWithinDays: z.number().int().min(0).max(3650).nullable().optional(),
  /** Tasks of projects whose status is 'archived' are excluded unless this is true or projectIds lists them. */
  includeArchivedProjects: z.boolean().optional(),
  /** true: only slipped tasks (their blockers push the due date later; docs/design/task-dependencies.md). */
  slipped: z.boolean().optional(),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const TASK_SORT_FIELDS = [
  'manual', 'priority', 'dueDate', 'startDate', 'createdAt', 'updatedAt', 'title', 'number', 'estimate', 'status',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const taskSortSchema = z.object({
  field: z.enum(TASK_SORT_FIELDS),
  dir: z.enum(['asc', 'desc']),
});
export type TaskSort = z.infer<typeof taskSortSchema>;

export const taskQueryInput = z.object({
  filter: taskFilterSchema.optional(),
  sort: taskSortSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.queryLimitMax).optional(),
  offset: z.number().int().min(0).optional(),
  /** Client's local date, used to resolve due presets. Defaults to the server's UTC date. */
  today: isoDateSchema.optional(),
  /** The viewer's preference (UserPreferences.weekStartsOn), for the week presets; default 1 (Monday). */
  weekStartsOn: weekStartSchema.optional(),
});
export type TaskQueryInput = z.input<typeof taskQueryInput>;

// ---------------------------------------------------------------------------
// Comments, work logs, activity
// ---------------------------------------------------------------------------

export const commentCreateInput = z.object({
  body: z.string().trim().min(1, 'Required').max(LIMITS.commentMax),
});
export type CommentCreateInput = z.input<typeof commentCreateInput>;
export const commentUpdateInput = commentCreateInput;
export type CommentUpdateInput = CommentCreateInput;

export const worklogCreateInput = z
  .object({
    date: isoDateSchema,
    minutes: z.number().int().min(0).max(LIMITS.worklogMinutesMax).nullable().optional(),
    note: z.string().trim().max(LIMITS.worklogNoteMax).optional(),
  })
  .refine((v) => (v.minutes ?? 0) > 0 || (v.note ?? '').length > 0, {
    message: 'Enter time spent or a note',
    path: ['note'],
  });
export type WorklogCreateInput = z.input<typeof worklogCreateInput>;

export const worklogUpdateInput = z.object({
  date: isoDateSchema.optional(),
  minutes: z.number().int().min(0).max(LIMITS.worklogMinutesMax).nullable().optional(),
  note: z.string().trim().max(LIMITS.worklogNoteMax).optional(),
});
export type WorklogUpdateInput = z.input<typeof worklogUpdateInput>;

export const activityQueryInput = z.object({
  projectId: idParamSchema.optional(),
  taskId: idParamSchema.optional(),
  /** Cursor: return entries with id < before. */
  before: idParamSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ActivityQueryInput = z.infer<typeof activityQueryInput>;

/** GET /api/worklogs — work-log report across tasks. Dates inclusive. */
export const worklogReportQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  projectId: idParamSchema.optional(),
  /** Client's local date; when from/to are omitted the range is [today-29, today]. */
  today: isoDateSchema.optional(),
  /** Only this user's work logs. */
  userId: idParamSchema.optional(),
});
export type WorklogReportQuery = z.infer<typeof worklogReportQuery>;

// ---------------------------------------------------------------------------
// Tags & statuses
// ---------------------------------------------------------------------------

export const tagCreateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.tagNameMax),
  color: colorSchema.optional(),
});
export type TagCreateInput = z.input<typeof tagCreateInput>;

export const tagUpdateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.tagNameMax).optional(),
  color: colorSchema.optional(),
});
export type TagUpdateInput = z.input<typeof tagUpdateInput>;

/** POST /api/tags/:id/merge — move every task tagged :id to targetId, then delete :id. */
export const tagMergeInput = z.object({ targetId: idSchema });
export type TagMergeInput = z.input<typeof tagMergeInput>;

export const statusCreateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.statusNameMax),
  category: statusCategorySchema,
  color: colorSchema.optional(),
});
export type StatusCreateInput = z.input<typeof statusCreateInput>;

export const statusUpdateInput = z.object({
  name: z.string().trim().min(1, 'Required').max(LIMITS.statusNameMax).optional(),
  category: statusCategorySchema.optional(),
  color: colorSchema.optional(),
});
export type StatusUpdateInput = z.input<typeof statusUpdateInput>;

/** DELETE /api/statuses/:id?reassignTo=<id> — required when tasks use the status. */
export const statusDeleteQuery = z.object({ reassignTo: idParamSchema.optional() });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Settings are split (design §3.6): each space has its own SpaceSettings (GET/PATCH
// /api/s/:spaceId/settings), each account its UserPreferences (PATCH /api/account/preferences).
// Settings is the client's merged view of both.

export const spaceSettingsSchema = z.object({
  estimateUnit: z.enum(ESTIMATE_UNITS),
  defaultBoardId: idSchema.nullable(),
});
export type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

export const userPreferencesSchema = z.object({
  weekStartsOn: weekStartSchema,
  homePage: homePageSchema,
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const settingsSchema = z.object({
  weekStartsOn: userPreferencesSchema.shape.weekStartsOn,
  estimateUnit: spaceSettingsSchema.shape.estimateUnit,
  defaultBoardId: spaceSettingsSchema.shape.defaultBoardId,
  homePage: userPreferencesSchema.shape.homePage,
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SPACE_SETTINGS: SpaceSettings = { estimateUnit: 'points', defaultBoardId: null };
export const DEFAULT_PREFERENCES: UserPreferences = { weekStartsOn: 1, homePage: 'dashboard' };

export const DEFAULT_SETTINGS: Settings = {
  weekStartsOn: DEFAULT_PREFERENCES.weekStartsOn,
  estimateUnit: DEFAULT_SPACE_SETTINGS.estimateUnit,
  defaultBoardId: DEFAULT_SPACE_SETTINGS.defaultBoardId,
  homePage: DEFAULT_PREFERENCES.homePage,
};

/** PATCH /api/s/:spaceId/settings (admin). */
export const spaceSettingsUpdateInput = z.object({
  estimateUnit: z.enum(ESTIMATE_UNITS).optional(),
  defaultBoardId: idSchema.nullable().optional(),
});
export type SpaceSettingsUpdateInput = z.input<typeof spaceSettingsUpdateInput>;

/** PATCH /api/account/preferences. */
export const preferencesUpdateInput = z.object({
  weekStartsOn: weekStartSchema.optional(),
  homePage: homePageSchema.optional(),
});
export type PreferencesUpdateInput = z.input<typeof preferencesUpdateInput>;

// ---------------------------------------------------------------------------
// Search & dashboard
// ---------------------------------------------------------------------------

export const searchQueryInput = z.object({
  q: z.string().trim().min(1).max(LIMITS.searchMax),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchQueryInput = z.infer<typeof searchQueryInput>;

/** POST /api/tasks/:id/blockers: make `blockerId` block the task. */
export const taskLinkInput = z.object({ blockerId: idSchema });
export type TaskLinkInput = z.input<typeof taskLinkInput>;

/** GET /api/tasks/:id?today=: the client's date, for the adjusted dates (default the server's UTC date). */
export const taskReadQuery = z.object({ today: isoDateSchema.optional() });

/** POST /api/tasks/rebaseline(/preview): the slipped tasks of one project, or of a selection. */
export const rebaselineInput = z
  .object({
    projectId: idSchema.optional(),
    ids: z.array(idSchema).min(1).max(LIMITS.bulkMax).optional(),
    today: isoDateSchema.optional(),
  })
  .refine((v) => (v.projectId === undefined) !== (v.ids === undefined), {
    message: 'Give a project or a selection of tasks',
    path: ['projectId'],
  });
export type RebaselineInput = z.output<typeof rebaselineInput>;

export const dashboardQueryInput = z.object({
  today: isoDateSchema.optional(),
  /** The viewer's preference (UserPreferences.weekStartsOn); default 1 (Monday). */
  weekStartsOn: weekStartParamSchema.optional(),
});

// ---------------------------------------------------------------------------
// Space data
// ---------------------------------------------------------------------------

/** ?mode= of POST /api/s/:spaceId/data/import/{analyze,commit} (design §6.4 step 2, §8.4). */
export const importModeQuery = z.object({ mode: z.enum(['new', 'replace']) });
export type ImportMode = z.infer<typeof importModeQuery>['mode'];

/** An archive user id (shared/src/archive.ts archiveUserRefSchema: not 0, within ±IMPORT_INT_MAX = 2^40). */
const archiveIdSchema = z
  .number()
  .int()
  .min(-(2 ** 40))
  .max(2 ** 40)
  .refine((v) => v !== 0, 'Must not be 0');

/** ImportTarget (types.ts): one of the analysis's candidates, or a new placeholder that keeps the name. */
export const importTargetSchema = z.union([
  z.object({ kind: z.literal('user'), userId: idSchema }),
  z.object({ kind: z.literal('placeholder') }),
]);

/**
 * The `mapping` field (JSON) of POST /api/s/:spaceId/data/import/commit (design §8.6): a target for every user
 * the archive's rows reference (others are ignored; v1 files ignore the mapping), and whether to leave out the
 * activity history (§8.9).
 */
export const importMappingInput = z.object({
  mapping: z.array(z.object({ archiveId: archiveIdSchema, target: importTargetSchema })).max(10_000),
  skipActivity: z.boolean().optional(),
});
export type ImportMappingInput = z.input<typeof importMappingInput>;

/** POST /api/s/:spaceId/people/:personId/reassign: the member who gets the person's rows. */
export const peopleReassignInput = z.object({ toUserId: idSchema });
export type PeopleReassignInput = z.input<typeof peopleReassignInput>;

// ---------------------------------------------------------------------------
// Sign-up, email links, invitations and recovery (design §5.8.5-§5.8.11, §5.8.19; P5)
// ---------------------------------------------------------------------------

/** The token of an emailed or copied link (`#t=`): 32 random bytes in base64url, checked by the server. */
const linkTokenSchema = z.string().min(20, 'Invalid link').max(200, 'Invalid link');

/** POST /api/auth/signup/inspect, /api/auth/password/reset/inspect, /api/auth/email/confirm, /api/invitations/inspect. */
export const tokenInput = z.object({ token: linkTokenSchema });
export type TokenInput = z.input<typeof tokenInput>;

/** POST /api/auth/signup (policy `open`): the answer is 202 whatever the address. */
export const signupInput = z.object({ email: emailSchema });
export type SignupInput = z.input<typeof signupInput>;

/** POST /api/auth/signup/complete: the emailed token, and the new account's name and password. */
export const signupCompleteInput = z.object({ token: linkTokenSchema, displayName: displayNameSchema, password: passwordSchema });
export type SignupCompleteInput = z.input<typeof signupCompleteInput>;

/** POST /api/auth/password/forgot: the answer is 202 whatever the address. */
export const forgotPasswordInput = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.input<typeof forgotPasswordInput>;

/** POST /api/auth/password/reset. */
export const resetPasswordInput = z.object({ token: linkTokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.input<typeof resetPasswordInput>;

/** POST /api/account/email (re-auth): the new address. */
export const emailChangeInput = z.object({ email: emailSchema });
export type EmailChangeInput = z.input<typeof emailChangeInput>;

/** POST /api/auth/recover (RECOVERY_TOKEN set): the operator's token and the account to recover. */
export const recoverInput = z.object({ token: z.string().min(1, 'Required').max(200), identifier: identifierSchema });
export type RecoverInput = z.input<typeof recoverInput>;

/** POST /api/spaces/:spaceId/invitations: inviting as admin needs an owner and the re-auth window. */
export const invitationCreateInput = z.object({ email: emailSchema, role: z.enum(INVITABLE_ROLES) });
export type InvitationCreateInput = z.input<typeof invitationCreateInput>;

/** POST /api/admin/invitations: an instance invitation (an account, no space). */
export const adminInvitationInput = z.object({ email: emailSchema });
export type AdminInvitationInput = z.input<typeof adminInvitationInput>;

/**
 * POST /api/invitations/accept. Signed out, a new account: `token`, `displayName` and `password`. Signed
 * in, the account accepts: `token` only.
 */
export const invitationAcceptInput = z.object({
  token: linkTokenSchema,
  displayName: displayNameSchema.optional(),
  password: passwordSchema.optional(),
});
export type InvitationAcceptInput = z.input<typeof invitationAcceptInput>;

// ---------------------------------------------------------------------------
// Instance administration (design §5.8.18, §7.2; P5)
// ---------------------------------------------------------------------------

/** PATCH /api/admin/settings (re-auth): `open` needs a transport that delivers mail (409 mail_not_configured). */
export const adminSettingsInput = z.object({
  signupPolicy: z.enum(SIGNUP_POLICIES).optional(),
  passwordMinLength: z.number().int().min(8, 'At least 8').max(64, 'At most 64').optional(),
});
export type AdminSettingsInput = z.input<typeof adminSettingsInput>;

/** PATCH /api/admin/users/:userId (re-auth; never one's own account): disable or enable, promote or demote. */
export const adminUserUpdateInput = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  isInstanceAdmin: z.boolean().optional(),
});
export type AdminUserUpdateInput = z.input<typeof adminUserUpdateInput>;

/** A page size of the admin lists (1-100; the server's default is 50). */
const adminLimitSchema = z.coerce.number().int().min(1).max(100);
/** The admin lists' search: matched case-insensitively (ASCII) as a part of the name or address. */
const adminSearchSchema = z.string().trim().max(100);

/**
 * GET /api/admin/users?q&orphaned&cursor&limit: newest first; `orphaned=1`: only the active accounts that can
 * only sign in with passkeys that do not work on this address (§5.6's warning); `cursor` is the previous
 * page's nextCursor.
 */
export const adminUsersQuery = z.object({
  q: adminSearchSchema.optional(),
  orphaned: z.enum(['0', '1']).optional(),
  cursor: idParamSchema.optional(),
  limit: adminLimitSchema.optional(),
});
export type AdminUsersQuery = z.input<typeof adminUsersQuery>;

/** GET /api/admin/spaces?q&cursor&limit: newest first; `q` matches the name, or the space id exactly. */
export const adminSpacesQuery = z.object({
  q: adminSearchSchema.optional(),
  cursor: z.string().max(64).optional(),
  limit: adminLimitSchema.optional(),
});
export type AdminSpacesQuery = z.input<typeof adminSpacesQuery>;

// ---------------------------------------------------------------------------
// Passkeys (design §5.6, §5.8.3, §5.8.5, §5.8.8, §5.8.9, §5.8.12-§5.8.14; P6)
// ---------------------------------------------------------------------------

/**
 * The ceremony id an options call answered with: 43 characters of base64url for a stored ceremony, or a
 * signed login ceremony (`<payload>.<signature>`, base64url, at most 200 characters; design §4.1).
 */
const ceremonyIdSchema = z
  .string()
  .max(200, 'Invalid ceremony')
  .regex(/^(?:[A-Za-z0-9_-]+\.)?[A-Za-z0-9_-]{43}$/, 'Invalid ceremony');

/**
 * What @simplewebauthn/browser's startRegistration() or startAuthentication() resolved with. Only its
 * outline is checked here; the server's WebAuthn library checks the rest.
 */
const webauthnResponseSchema = z.looseObject({
  id: z.string().min(1, 'Required').max(1024),
  rawId: z.string().max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({}),
});

/** A passkey's name (shown in Account settings → Security). */
export const passkeyNameSchema = z.string().trim().min(1, 'Required').max(LIMITS.passkeyNameMax);

/** POST /api/auth/passkey/login/options: `conditional` for the sign-in field's autofill (a longer ceremony). */
export const passkeyLoginOptionsInput = z.object({ conditional: z.boolean().optional() });
export type PasskeyLoginOptionsInput = z.input<typeof passkeyLoginOptionsInput>;

/** POST /api/auth/passkey/login and /api/account/reauth/passkey: the ceremony and the browser's answer. */
export const ceremonyResponseInput = z.object({ ceremonyId: ceremonyIdSchema, response: webauthnResponseSchema });
export type CeremonyResponseInput = z.input<typeof ceremonyResponseInput>;

/** POST /api/account/passkeys: a new passkey (default name "Passkey <n>"). */
export const passkeyRegisterInput = z.object({ ceremonyId: ceremonyIdSchema, response: webauthnResponseSchema, name: passkeyNameSchema.optional() });
export type PasskeyRegisterInput = z.input<typeof passkeyRegisterInput>;

/** PATCH /api/account/passkeys/:passkeyId. */
export const passkeyRenameInput = z.object({ name: passkeyNameSchema });
export type PasskeyRenameInput = z.input<typeof passkeyRenameInput>;

/** POST /api/auth/signup/passkey/options: the sign-up link (inspected, not used up) and the new account's name. */
export const signupPasskeyOptionsInput = z.object({ token: linkTokenSchema, displayName: displayNameSchema });
export type SignupPasskeyOptionsInput = z.input<typeof signupPasskeyOptionsInput>;

/** POST /api/auth/signup/passkey/complete: the account is created with the passkey and no password. */
export const signupPasskeyCompleteInput = z.object({
  token: linkTokenSchema,
  ceremonyId: ceremonyIdSchema,
  response: webauthnResponseSchema,
  displayName: displayNameSchema,
  passkeyName: passkeyNameSchema.optional(),
});
export type SignupPasskeyCompleteInput = z.input<typeof signupPasskeyCompleteInput>;

/** POST /api/invitations/accept/passkey/options: a new account for the invitation, with a passkey. */
export const invitationPasskeyOptionsInput = signupPasskeyOptionsInput;
export type InvitationPasskeyOptionsInput = z.input<typeof invitationPasskeyOptionsInput>;

/** POST /api/invitations/accept/passkey. */
export const invitationPasskeyAcceptInput = signupPasskeyCompleteInput;
export type InvitationPasskeyAcceptInput = z.input<typeof invitationPasskeyAcceptInput>;

/** POST /api/auth/password/reset/passkey: the reset link sets up a passkey instead of a password. */
export const resetPasskeyInput = z.object({
  token: linkTokenSchema,
  ceremonyId: ceremonyIdSchema,
  response: webauthnResponseSchema,
  name: passkeyNameSchema.optional(),
});
export type ResetPasskeyInput = z.input<typeof resetPasskeyInput>;
