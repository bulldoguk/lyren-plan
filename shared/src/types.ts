// API response shapes (DTOs). All timestamps are ISO-8601 UTC strings
// ('2026-10-13T20:15:00.000Z'); all calendar dates are 'YYYY-MM-DD'.
// Field names are camelCase; database columns are snake_case.

import type { BoardConfig } from './board';
import type {
  AuthMethod,
  EpicStatus,
  MilestoneStatus,
  Priority,
  ProjectStatus,
  SignupPolicy,
  StatusCategory,
} from './constants';
import type { InvitableRole, SpaceRole } from './roles';
import type { Settings, SpaceSettings, UserPreferences } from './schemas';

/** An account, as its owner sees it (setup, login, AuthStatusDTO, GET/PATCH /api/account). */
export interface UserDTO {
  id: number;
  /** Null only for accounts from before the multi-user upgrade that have not added one yet. */
  email: string | null;
  /** The owner of the address followed an emailed link (never on an instance without mail). */
  emailVerified: boolean;
  /** The sign-in name of an account from before the upgrade; null for new accounts. */
  username: string | null;
  displayName: string;
  createdAt: string;
  isInstanceAdmin: boolean;
  hasPassword: boolean;
  passkeyCount: number;
}

export interface SessionDTO {
  id: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  /** True for the session making the request. */
  current: boolean;
  authMethod: AuthMethod;
}

/** Minimal author/actor reference embedded in comments, work logs and activity. */
export interface UserRef {
  id: number;
  displayName: string;
}

/** A page of a cursor-paged list (`?cursor=<opaque>&limit=`). */
export interface Page<T> {
  items: T[];
  /** Pass as `cursor` for the next page; null when exhausted. */
  nextCursor: string | null;
}

/** GET /api/account/security-events: one entry of the account's security log (design §5.11). */
export interface SecurityEventDTO {
  id: number;
  type: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  data: Record<string, unknown>;
}

/** A security notice the account has not seen yet (AuthStatusDTO.notices). */
export interface NoticeDTO {
  id: number;
  type: 'admin_reset_link' | 'recovery_used';
  /** The administrator who acted, when there was one. */
  actorName: string | null;
  createdAt: string;
}

/** The instance and what it can do; public (AuthStatusDTO.instance). */
export interface InstanceInfoDTO {
  name: string;
  runtime: 'node' | 'cloudflare';
  signupPolicy: SignupPolicy;
  /** The mail transport delivers mail (anything but MAIL_TRANSPORT=log): invitations go by mail. */
  mail: boolean;
  /**
   * Links can be mailed (the server's mailer.sendsTokens): `mail`, or MAIL_LOG_BODIES, which writes them to
   * the log (development). Sign-up, forgot password, verification and the email change's confirmation work.
   */
  mailLinks: boolean;
  /** origin and rpId are null while passkeys are off (no PUBLIC_URL, not https, or an IP address). */
  passkeys: { enabled: boolean; origin: string | null; rpId: string | null };
  /** The minimum length of new passwords on this instance. */
  passwordMinLength: number;
  /** recovery: RECOVERY_TOKEN is set (the break-glass sign-in, design §5.8.19). */
  features: { backupDownload: boolean; recovery: boolean };
  /** Origins that work from other devices, for copied links; [] = only this origin. */
  shareOrigins: string[];
  /** null = no limit. */
  limits: {
    importMaxBytes: number;
    importMaxRowWrites: number | null;
    importDailyRowWrites: number | null;
    maxSpacesPerUser: number | null;
    maxMembersPerSpace: number | null;
  };
}

/** POST /api/admin/mail/test: the transport took the test message (messageId when it gave one). */
export interface MailTestDTO {
  ok: true;
  messageId?: string;
}

/** A space in the account's list (GET /api/spaces, AuthStatusDTO.spaces). */
export interface SpaceSummaryDTO {
  /** The space id (shared/src/ids.ts): /api/s/<id>/…, /s/<id>/…. */
  id: string;
  name: string;
  /** The account's role in it. */
  role: SpaceRole;
  /** 'importing' while an archive import into a new space is under way. */
  status: 'importing' | 'active';
  memberCount: number;
  createdAt: string;
}

export interface SpaceDetailDTO extends SpaceSummaryDTO {
  owners: UserRef[];
}

/** A deleted space its owner can still restore (GET /api/spaces/deleted). */
export interface DeletedSpaceDTO {
  id: string;
  name: string;
  deletedAt: string;
  /** When it is purged for good. */
  purgeAfter: string;
}

/** A member of a space (GET /api/spaces/:spaceId/members). Every member sees the others' emails. */
export interface MemberDTO {
  userId: number;
  displayName: string;
  email: string | null;
  role: SpaceRole;
  /** A disabled account stays a member but cannot sign in. */
  status: 'active' | 'disabled';
  joinedAt: string;
  isYou: boolean;
}

/** A user an importer may map an archive's users to (design §8.5). */
export interface ImportCandidateDTO {
  userId: number;
  displayName: string;
  email: string | null;
  isYou: boolean;
}

/**
 * Progress counts every non-archived task plus archived CLOSED tasks, so archiving finished work
 * never moves progress backwards. An archived OPEN task is abandoned work and counts nowhere.
 */
export interface ProjectStats {
  /** Counted tasks: non-archived, or archived with a closed status. */
  tasksTotal: number;
  /** Non-archived tasks whose status category is not closed. */
  tasksOpen: number;
  /** Tasks (archived or not) whose status category is completed or cancelled. */
  tasksClosed: number;
  /** Open, non-archived tasks with dueDate < the request's `today` (?today=, else server UTC date). */
  tasksOverdue: number;
  milestonesTotal: number;
  milestonesCompleted: number;
  epicsTotal: number;
  epicsDone: number;
}

export interface ProjectDTO {
  id: number;
  key: string;
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
  stats: ProjectStats;
}

/** Progress of the tasks under a milestone or epic (non-archived ones plus archived closed ones; see ProjectStats). */
export interface ProgressStats {
  tasksTotal: number;
  tasksClosed: number;
  /** Sum of estimates of those tasks (null estimates count as 0). */
  estimateTotal: number;
  estimateClosed: number;
}

export interface MilestoneDTO {
  id: number;
  projectId: number;
  name: string;
  description: string;
  status: MilestoneStatus;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ProgressStats & { epicsTotal: number; epicsDone: number };
}

export interface EpicDTO {
  id: number;
  projectId: number;
  milestoneId: number | null;
  name: string;
  description: string;
  color: string;
  status: EpicStatus;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ProgressStats;
}

export interface StatusDTO {
  id: number;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  /** Number of tasks (including archived) using this status. */
  taskCount: number;
}

export interface TagRef {
  id: number;
  name: string;
  color: string;
}

export interface TagDTO extends TagRef {
  /** Number of non-archived tasks with this tag. */
  taskCount: number;
  createdAt: string;
}

export interface TaskDTO {
  id: number;
  projectId: number;
  /** Per-project sequence number; together with the project key forms `ref`. */
  number: number;
  /** Human reference, e.g. 'LYR-42' (project key + number). */
  ref: string;
  epicId: number | null;
  /** Derived from the epic (tasks belong to milestones only through epics). */
  milestoneId: number | null;
  statusId: number;
  priority: Priority;
  title: string;
  description: string;
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
  /** Fractional-index string; ascending rank = manual order. */
  rank: string;
  /** Set while the task's status category is completed/cancelled. */
  completedAt: string | null;
  archivedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Sorted by tag name (case-insensitive). */
  tags: TagRef[];
  commentCount: number;
  /** Sum of minutes across the task's work logs. */
  worklogMinutes: number;
  /** The tasks this one waits on (finish-to-start links; docs/design/task-dependencies.md), ids ascending. */
  blockedBy: number[];
  /** The tasks waiting on this one, ids ascending. */
  blocks: number[];
  /**
   * The start and due dates its blockers allow (shared/src/schedule.ts), as of the request's `today` (the server's
   * date for a write's answer). Equal to startDate / dueDate unless the task slipped.
   */
  adjustedStartDate: string | null;
  adjustedDueDate: string | null;
  /** Days adjustedDueDate lies after dueDate: > 0 for a slipped task, else 0. */
  slipDays: number;
}

/** One task a rebaseline moves (POST /api/tasks/rebaseline and its preview). */
export interface RebaselineItemDTO {
  taskId: number;
  ref: string;
  title: string;
  from: { startDate: string | null; dueDate: string | null };
  to: { startDate: string | null; dueDate: string | null };
  slipDays: number;
}

export interface TaskQueryResult {
  tasks: TaskDTO[];
  /** Total matching tasks ignoring limit/offset. */
  total: number;
}

export interface CommentDTO {
  id: number;
  taskId: number;
  body: string;
  author: UserRef | null;
  createdAt: string;
  updatedAt: string;
  /** Set when the body was edited after creation. */
  editedAt: string | null;
  /** Written by an import that attributed it to someone else: the importer (design §8.6). */
  importedBy: UserRef | null;
  /** When an import wrote it; null for rows written in this space. */
  importedAt: string | null;
}

export interface WorklogDTO {
  id: number;
  taskId: number;
  date: string;
  minutes: number | null;
  note: string;
  author: UserRef | null;
  createdAt: string;
  updatedAt: string;
  /** Written by an import that attributed it to someone else: the importer (design §8.6). */
  importedBy: UserRef | null;
  /** When an import wrote it; null for rows written in this space. */
  importedAt: string | null;
}

export type ActivityEntityType = 'project' | 'milestone' | 'epic' | 'task' | 'comment' | 'worklog';

export type ActivityAction =
  | 'project.created' | 'project.updated' | 'project.deleted'
  | 'milestone.created' | 'milestone.updated' | 'milestone.deleted'
  | 'epic.created' | 'epic.updated' | 'epic.deleted'
  | 'task.created' | 'task.updated' | 'task.moved' | 'task.deleted'
  | 'comment.created' | 'comment.updated' | 'comment.deleted'
  | 'worklog.created' | 'worklog.updated' | 'worklog.deleted';

/**
 * One changed field in an `*.updated` activity entry. `from`/`to` hold raw values
 * (ids, dates, numbers, booleans); `fromLabel`/`toLabel` hold display snapshots
 * taken at the time of the change (e.g. status/epic names) so history stays
 * readable after renames or deletions. For `tags`, `added`/`removed` hold tag names.
 * For `description`, from/to are omitted (only the fact that it changed is kept).
 */
export interface FieldChange {
  field: string;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
  fromLabel?: string | null;
  toLabel?: string | null;
  added?: string[];
  removed?: string[];
}

/** `data` payloads per action family (all optional fields are best-effort snapshots). */
export interface ActivityData {
  /** *.updated */
  changes?: FieldChange[];
  /** Display snapshot of the subject at the time (task title, milestone name ...). */
  title?: string;
  name?: string;
  /** task.*: the task ref at the time, e.g. 'LYR-12'. */
  ref?: string;
  /** task.moved */
  fromProjectId?: number;
  toProjectId?: number;
  fromProjectName?: string;
  toProjectName?: string;
  fromRef?: string;
  toRef?: string;
  /** comment.* : first ~200 chars of the body. */
  excerpt?: string;
  /** worklog.* */
  minutes?: number | null;
  date?: string;
  note?: string;
  /** task.updated: the date changes of a rebaseline (accepting a slip), not an edit by hand. */
  rebaseline?: boolean;
  [key: string]: unknown;
}

export interface ActivityDTO {
  id: number;
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId: number | null;
  projectId: number | null;
  taskId: number | null;
  data: ActivityData;
  actor: UserRef | null;
  createdAt: string;
  /** Current task reference when the task still exists. */
  task: { id: number; ref: string; title: string } | null;
  /** Written by an import that attributed it to someone else: the importer (design §8.6). */
  importedBy: UserRef | null;
  /** When an import wrote it; null for rows written in this space. */
  importedAt: string | null;
}

export interface ActivityPage {
  items: ActivityDTO[];
  /** Pass as `before` to fetch the next (older) page; null when exhausted. */
  nextBefore: number | null;
}

export interface WorklogReportDTO {
  /** Newest date first, then newest created first. */
  items: Array<WorklogDTO & { task: { id: number; ref: string; title: string; projectId: number } }>;
  totalMinutes: number;
}

export interface TaskTimelineDTO {
  comments: CommentDTO[];
  worklogs: WorklogDTO[];
  activity: ActivityDTO[];
}

export interface BoardDTO {
  id: number;
  /** null = global board (Boards page); otherwise a board of that project (project Board tab). */
  projectId: number | null;
  name: string;
  description: string;
  config: BoardConfig;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** The space being viewed and the viewer's role in it (BootstrapDTO.space). */
export interface SpaceInfoDTO {
  id: string;
  name: string;
  role: SpaceRole;
}

/**
 * Someone a space's content can name (its users mirror, design §3.5): a member, a former member, an
 * account an import attributed rows to, or a placeholder (negative id) for a former member an
 * import kept by name.
 */
export interface PersonDTO {
  id: number;
  displayName: string;
  kind: 'account' | 'placeholder';
  isMember: boolean;
  /** The account no longer exists (shown with "(deleted account)"). */
  deleted: boolean;
}

/** GET /api/s/:spaceId/bootstrap: what every page of a space needs at start. */
export interface BootstrapDTO {
  /** The viewer. */
  user: UserRef;
  space: SpaceInfoDTO;
  people: PersonDTO[];
  settings: SpaceSettings;
  version: string;
  statuses: StatusDTO[];
  tags: TagDTO[];
  projects: ProjectDTO[];
  milestones: MilestoneDTO[];
  epics: EpicDTO[];
  boards: BoardDTO[];
}

export interface AuthStatusDTO {
  /** True when no user exists yet; the UI must show the setup screen. */
  setupRequired: boolean;
  /** Setup must include the one-time code printed in the server log (SETUP_TOKEN). */
  setupCodeRequired: boolean;
  user: UserDTO | null;
  version: string;
  instance: InstanceInfoDTO;
  /** The account's spaces; [] when signed out. */
  spaces: SpaceSummaryDTO[];
  /** null when signed out. */
  preferences: UserPreferences | null;
  /** The end of the session's re-auth window (ISO); null when it is closed or signed out. */
  reauthUntil: string | null;
  /** Unseen security notices (an administrator created a reset link, the recovery token was used). */
  notices: NoticeDTO[];
  /** The space the multi-user upgrade made of this install's data, when the user is a member: old links go there. */
  legacySpaceId: string | null;
  /** Only from the single-file desktop app (SPEC §12.1); absent for the Node build and Docker. */
  desktop?: DesktopAppDTO;
  /** Only from the single-file desktop app, and only for instance admins. */
  desktopData?: DesktopDataDTO;
}

/**
 * The client is served by the single-file desktop app, not the Node build or Docker: the sign-in
 * page and Administration → Overview show the app's commands. Public (AuthStatusDTO), so no paths.
 */
export interface DesktopAppDTO {
  /** The program's file name as it is on disk, e.g. lyren-plan-0.1.0-win-x64.exe. */
  exe: string;
  /** Windows: commands for Command Prompt. Otherwise for a POSIX shell (Linux, macOS). */
  windows: boolean;
  /**
   * How Lyren Plan is stopped (Windows, SPEC §12.1): 'tray' = it runs without a window, with an
   * icon in the notification area (Quit Lyren Plan in its menu); 'terminal' = in the terminal it was
   * started in (Ctrl+C) and with that icon. Absent: in its own console window (close it), as on
   * Linux and macOS and with --console.
   */
  stopMode?: 'tray' | 'terminal';
}

/** The desktop app and where it keeps the data, for Administration → Overview (AuthStatusDTO.desktopData: instance admins only). */
export interface DesktopDataDTO extends DesktopAppDTO {
  /** The data folder: lyren.db, desktop.json and backups/ (safety snapshots). */
  dataDir: string;
  /**
   * The database file when DB_PATH makes it anything but lyren.db in the data folder (another
   * folder or another name), else null. The maintenance commands then need `--db-path <dbPath>`.
   */
  dbPath: string | null;
  /**
   * The data folder was chosen with --data-dir or DATA_DIR rather than the per-user default, so
   * the maintenance commands need `--data-dir <dataDir>` to find the same database.
   */
  customDataDir: boolean;
  /** The folder that holds the program; null when it runs from source (npx tsx server/src/sea.ts). */
  exeFolder: string | null;
}

export interface DashboardDTO {
  today: string;
  /** Open tasks with dueDate < today, oldest due first (max 50). */
  overdue: TaskDTO[];
  /** Open tasks due today (max 50). */
  dueToday: TaskDTO[];
  /** Open tasks due in the next 7 days after today (max 50). */
  dueSoon: TaskDTO[];
  /** Tasks in a 'started' status, most recently updated first (max 50). */
  inProgress: TaskDTO[];
  /** Tasks closed in the last 7 days, most recent first (max 20). */
  recentlyClosed: TaskDTO[];
  /**
   * Uncapped number of tasks matching each list above. A list is truncated when its count is
   * larger than its length.
   */
  counts: { overdue: number; dueToday: number; dueSoon: number; inProgress: number; recentlyClosed: number };
  /** Number of distinct projects with tasks in a 'started' status (uncapped, like counts.inProgress). */
  inProgressProjects: number;
  /** Open tasks whose blockers push their due date later (`slipped` filter; uncapped). */
  slipped: number;
  recentActivity: ActivityDTO[];
  worklog: { todayMinutes: number; weekMinutes: number };
}

export interface SearchResultDTO {
  tasks: TaskDTO[];
  projects: ProjectDTO[];
  milestones: MilestoneDTO[];
  epics: EpicDTO[];
}

/** Error codes and their HTTP status (design §7.5). */
export type ApiErrorCode =
  | 'validation_error' // 400
  | 'bad_request' // 400
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'payload_too_large' // 413
  | 'internal' // 500
  | 'reauth_required' // 403: needs the re-auth window (a recent password or passkey in this session)
  | 'account_disabled' // 403: correct credentials, but an admin disabled the account
  | 'signup_disabled' // 403: the signup policy forbids this way of creating an account
  | 'invalid_token' // 400: a link token or invitation is unknown, used, expired or no longer valid
  | 'passkey_error' // 400: a WebAuthn ceremony failed (details may say `credential: unknown`)
  | 'mail_not_configured' // 409: needs a mail transport that delivers mail
  | 'quota_exceeded' // 409: an instance quota (spaces, members, invitations, import size, passkeys, space size)
  | 'last_owner' // 409: would leave a space without an owner
  | 'last_admin' // 409: would leave the instance without an active admin
  | 'last_credential' // 409: would leave the account without a usable password or passkey, or a way back in
  | 'space_unavailable' // 409: the space is being imported
  | 'wrong_host' // 421 (Cloudflare): the request was for another host than PUBLIC_URL's
  | 'unavailable'; // 503: a runtime dependency failed (a Durable Object, a platform limit, the hash queue, mail)

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** For validation errors: [{ path: 'title', message: 'Required' }, ...] */
    details?: Array<{ path: string; message: string }>;
  };
}

/** A task's links and the dates they imply: derived, so never in an export (an archive carries `blockedBy`). */
type TaskLinkFields = 'blockedBy' | 'blocks' | 'adjustedStartDate' | 'adjustedDueDate' | 'slipDays';

/** Import provenance (design §8.6): not part of the v1 export format. */
type Provenance = 'importedBy' | 'importedAt';

/**
 * The v1 JSON export (the space's GET …/data/export before archive v2, design §8.2), which an import still takes;
 * SpaceArchiveDTO below is what the export writes now.
 */
export interface ExportDTO {
  format: 'lyren-plan-export';
  formatVersion: 1;
  exportedAt: string;
  appVersion: string;
  settings: Settings;
  statuses: Array<Omit<StatusDTO, 'taskCount'>>;
  tags: Array<Omit<TagDTO, 'taskCount'>>;
  projects: Array<Omit<ProjectDTO, 'stats'> & { taskCounter: number }>;
  milestones: Array<Omit<MilestoneDTO, 'stats'>>;
  epics: Array<Omit<EpicDTO, 'stats'>>;
  tasks: Array<Omit<TaskDTO, 'ref' | 'milestoneId' | 'tags' | 'commentCount' | 'worklogMinutes' | TaskLinkFields> & { tagIds: number[] }>;
  comments: Array<Omit<CommentDTO, 'author' | Provenance> & { authorId: number | null }>;
  worklogs: Array<Omit<WorklogDTO, 'author' | Provenance> & { authorId: number | null }>;
  activity: Array<Omit<ActivityDTO, 'actor' | 'task' | Provenance> & { actorId: number | null }>;
  boards: BoardDTO[];
}

// ---------------------------------------------------------------------------
// Space archive v2, import and people (design §8; P7)
// ---------------------------------------------------------------------------

/** One of an archive's users (design §8.2): an account (positive id) or a placeholder (negative id). */
export interface ArchiveUser {
  id: number;
  kind: 'account' | 'placeholder';
  displayName: string;
  /** The mirror's address of a live account; null for deleted accounts and placeholders. */
  email: string | null;
}

/** An earlier import's attribution of a row (design §8.6): a user of the archive, and when. */
interface ArchiveProvenance {
  importedBy?: number | null;
  importedAt?: string | null;
}

/**
 * Archive format version 2 (GET /api/s/:spaceId/data/export, gzip-compressed; shared/src/archive.ts): the v1
 * rows, whose user references are ids of `users` (or null), with the provenance of imported rows.
 */
export interface SpaceArchiveDTO {
  format: 'lyren-plan-space';
  formatVersion: 2;
  exportedAt: string;
  appVersion: string;
  space: { id: string; name: string; exportedBy: number | null };
  users: ArchiveUser[];
  settings: SpaceSettings;
  statuses: ExportDTO['statuses'];
  tags: ExportDTO['tags'];
  projects: ExportDTO['projects'];
  milestones: ExportDTO['milestones'];
  epics: ExportDTO['epics'];
  /** `blockedBy`: the task's blockers (task dependencies); absent in archives written before them. */
  tasks: Array<ExportDTO['tasks'][number] & { blockedBy?: number[] }>;
  comments: Array<ExportDTO['comments'][number] & ArchiveProvenance>;
  worklogs: Array<ExportDTO['worklogs'][number] & ArchiveProvenance>;
  activity: Array<ExportDTO['activity'][number] & ArchiveProvenance>;
  boards: BoardDTO[];
}

/** What an archive user's rows are attributed to: an account, or a new placeholder that keeps the name. */
export type ImportTarget = { kind: 'user'; userId: number } | { kind: 'placeholder' };

/** Rows an import writes, per table (activity: without the entries whose task or project the archive lacks). */
export interface ImportCounts {
  statuses: number;
  tags: number;
  projects: number;
  milestones: number;
  epics: number;
  tasks: number;
  comments: number;
  worklogs: number;
  activity: number;
  boards: number;
}

/** An archive user that rows reference, with how many rows of each kind do (design §8.5). */
export interface ArchiveUserDTO {
  archiveId: number;
  displayName: string;
  email: string | null;
  kind: 'account' | 'placeholder';
  references: { tasks: number; comments: number; worklogs: number; activity: number };
}

/** POST /api/s/:spaceId/data/import/analyze (design §8.4): what the file holds and how its users can be mapped. */
export interface ImportAnalysisDTO {
  mode: 'new' | 'replace';
  format: 'lyren-plan-export/1' | 'lyren-plan-space/2';
  exportedAt: string;
  appVersion: string;
  /** The archive's space name (v2); null for a v1 export. */
  spaceName: string | null;
  counts: ImportCounts;
  /** The users rows reference; [] for v1 (every reference becomes the importer). */
  users: ArchiveUserDTO[];
  /** The accounts a user may be mapped to: the importer, members of the importer's spaces (instance admins: every account). */
  candidates: ImportCandidateDTO[];
  /** One for each of `users`. */
  suggestions: Array<{ archiveId: number; target: ImportTarget }>;
  estimate: {
    /** Rows the commit is estimated to write (design §8.9). */
    rowWrites: number;
    /** The same with skipActivity. */
    rowWritesWithoutActivity: number;
    /** IMPORT_MAX_ROW_WRITES; null when there is none. */
    limit: number | null;
    /** What is left of today's IMPORT_DAILY_ROW_WRITES (until 00:00 UTC); null when there is none. */
    dailyLeft: number | null;
  };
}

/** Node's pre-import snapshot of a replace (design §8.8); `path` is relative to the directory file's folder. */
export interface SafetyPointDTO {
  kind: 'file';
  path: string;
  /** The command that undoes the import (then restart): restore "<path>". */
  restoreCommand: string;
}

/** POST /api/s/:spaceId/data/import/commit (design §8.6). */
export interface ImportResultDTO {
  ok: true;
  counts: ImportCounts;
  /** Replace on Node: the snapshot taken before; null otherwise. */
  safety: SafetyPointDTO | null;
  /** Accounts rows were mapped to that are not members of the space (the web offers to invite them). */
  nonMemberAuthors: ImportCandidateDTO[];
}

/** POST /api/s/:spaceId/people/:personId/reassign: the rows moved to the member. */
export interface PeopleReassignedDTO {
  ok: true;
  counts: { tasks: number; comments: number; worklogs: number; activity: number };
}

/** POST /api/s/:spaceId/people/me/disown: the imported rows moved to an "Unknown (imported)" placeholder. */
export interface PeopleDisownedDTO {
  ok: true;
  counts: { comments: number; worklogs: number; activity: number };
}

// ---------------------------------------------------------------------------
// Sign-up, email links, invitations and recovery (design §5.8.5-§5.8.11, §5.8.19; P5)
// ---------------------------------------------------------------------------

/** POST /api/auth/signup/inspect: the address the sign-up link was sent to. */
export interface SignupPreviewDTO {
  email: string;
}

/** POST /api/auth/password/reset/inspect: whose password the link resets. */
export interface PasswordResetPreviewDTO {
  /** The account's address; null for an account from before email addresses (a reset link from an admin). */
  email: string | null;
  /** The sign-in name of an account from before the upgrade, else null. */
  username: string | null;
  hasPassword: boolean;
  /**
   * A passkey can be set up with the link instead of a password (POST /api/auth/password/reset/passkey):
   * passkeys are on here and the account has fewer than 20.
   */
  canUsePasskey: boolean;
  /**
   * The passkey replaces the account's password (Appendix D 59) unless the account would then have no way back
   * in: why it would keep its password then (§5.8.12's reasons), else null (or it has none, or no passkey can
   * be set up). PasskeyResetDTO says what happened.
   */
  passkeyKeepsPassword: string | null;
}

/** POST /api/auth/password/reset/passkey: the passkey is set up, and the account signed out everywhere. */
export interface PasskeyResetDTO {
  ok: true;
  /** The account had a password, and the passkey replaced it (Appendix D 59). */
  passwordRemoved: boolean;
  /** Why the account keeps its password (§5.8.12's reasons; PasswordResetPreviewDTO.passkeyKeepsPassword), else null. */
  passwordKept: string | null;
}

/** POST /api/account/email: with mail, a confirmation link goes to the new address; without, it is changed at once. */
export type EmailChangeDTO = { ok: true; pending: true } | { ok: true; pending: false; email: string };

/** POST /api/auth/email/confirm. */
export interface EmailConfirmedDTO {
  ok: true;
  /** The account's address now (verified). */
  email: string;
  purpose: 'verify_email' | 'change_email';
}

/** POST /api/admin/users/:userId/reset-link: mailed to the user, or a link for the admin to pass on. */
export type ResetLinkDTO = { sent: true } | { sent: false; link: string; expiresAt: string };

/** POST /api/auth/recover: a password reset link for the account (24 hours). */
export interface RecoveryLinkDTO {
  link: string;
  expiresAt: string;
  /** No active instance admin was left, so the account became one (and active). */
  madeAdmin: boolean;
}

/** An open invitation (GET /api/spaces/:spaceId/invitations, GET /api/admin/invitations); never its token. */
export interface InvitationDTO {
  id: number;
  email: string;
  /** null for an instance invitation (an account, no space). */
  role: InvitableRole | null;
  /** null once the inviter's account is deleted. */
  invitedBy: UserRef | null;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string;
  sendCount: number;
  /** 'mail' when the instance delivers mail; 'link' otherwise: the inviter passes the link on. */
  delivery: 'mail' | 'link';
  status: 'pending' | 'expired';
}

export interface InvitationCreatedDTO {
  invitation: InvitationDTO;
  /**
   * 'link' delivery only: the invitation's link, shown once. Absolute when the instance knows an address
   * that works from other devices (PUBLIC_URL, or the desktop app's LAN addresses), else `/invite#t=…`.
   */
  link: string | null;
}

/** POST /api/invitations/inspect: what the invitation page shows. */
export interface InvitationPreviewDTO {
  kind: 'space' | 'instance';
  spaceName: string | null;
  inviterName: string | null;
  inviterEmail: string | null;
  role: InvitableRole | null;
  /** The invited address. */
  email: string;
  expiresAt: string;
  /**
   * Whether the invited address has an account: told only for an invitation delivered by mail (its token
   * holder controls the address) or to the signed-in owner of the address; 'unknown' otherwise.
   */
  account: 'exists' | 'new' | 'unknown';
  /**
   * The signed-in account, if any: its address, whether it is the invited one, and, when it is and is a
   * member of the invitation's space already, its role there (accepting keeps the higher role).
   */
  signedIn: { email: string | null; matches: boolean; memberRole: SpaceRole | null } | null;
}

/** POST /api/invitations/accept: a new account (201, with its session cookie), or the signed-in one joined. */
export type InvitationAcceptedDTO = { user: UserDTO; spaceId: string | null } | { ok: true; spaceId: string };

/** GET /api/invitations: open invitations to the signed-in account's verified address (instances with mail). */
export interface PendingInvitationDTO {
  id: number;
  spaceName: string;
  inviterName: string | null;
  role: InvitableRole;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Instance administration (design §5.8.18, §7.2; P5)
// ---------------------------------------------------------------------------

/** GET /api/admin/overview. Nothing in it is a secret. */
export interface AdminOverviewDTO {
  instance: InstanceInfoDTO;
  /** Accounts; spaces neither deleted nor still being created; unexpired sign-in sessions. */
  counts: { users: number; spaces: number; sessions: number };
  /** The server's configuration (Appendix B), read-only. */
  config: {
    publicUrl: string | null;
    mailTransport: 'log' | 'smtp' | 'resend' | 'cloudflare';
    /** MAIL_FROM's address; null with the log transport when it is unset. */
    mailFrom: string | null;
    sessionTtlDays: number;
    /** 0 = no absolute limit. */
    sessionMaxDays: number;
    reauthMinutes: number;
    invitationTtlDays: number;
    /** 0 = a deleted space is purged at once. */
    spaceDeleteGraceDays: number;
    passwordKdf: 'scrypt' | 'pbkdf2';
  };
  /** What an administrator should act on, each a sentence. */
  warnings: string[];
  /**
   * The active accounts that can only sign in with passkeys that do not work on this address (§5.6; one of the
   * warnings says so): GET /api/admin/users?orphaned=1 lists them.
   */
  orphanedPasskeyAccounts: number;
  /** The last 20 administrative actions of any admin, the command line and the recovery token included. */
  recentAdminEvents: AdminEventDTO[];
}

/** What an administrative event was about. */
export type AdminEventTarget =
  /** An account; `id` null once it is deleted. */
  | { kind: 'user'; id: number | null; name: string }
  | { kind: 'space'; id: string; name: string }
  /** An instance invitation's address. */
  | { kind: 'email'; email: string };

/** One of AdminOverviewDTO.recentAdminEvents: the event, who acted and what it was about. */
export interface AdminEventDTO extends SecurityEventDTO {
  /** The administrator; null for the command line (`data.via` 'cli'), the recovery token, or an account deleted since. */
  actor: UserRef | null;
  /** null for the instance's settings and backups. */
  target: AdminEventTarget | null;
}

/** An account in GET /api/admin/users. */
export interface AdminUserDTO {
  id: number;
  email: string | null;
  username: string | null;
  displayName: string;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
  status: 'active' | 'disabled';
  hasPassword: boolean;
  /** Its passkeys, those registered for another address included (§5.6). */
  passkeys: number;
  /** Its passkeys that work on this address (0 while passkeys are off). */
  usablePasskeys: number;
  /** Spaces it is a member of (deleted ones not counted). */
  spaces: number;
  createdAt: string;
  lastLoginAt: string | null;
}

/** GET /api/admin/users/:userId: also its spaces and its last 50 security events. */
export interface AdminUserDetailDTO extends AdminUserDTO {
  memberships: Array<{ space: { id: string; name: string }; role: SpaceRole }>;
  events: SecurityEventDTO[];
}

/** A space in GET /api/admin/spaces: what admins may see of it (no content, §13.11). */
export interface AdminSpaceDTO {
  id: string;
  name: string;
  status: 'provisioning' | 'importing' | 'active';
  owners: UserRef[];
  memberCount: number;
  createdAt: string;
  /** Set while it is deleted: restorable until purgeAfter, then being removed. */
  deletedAt: string | null;
  purgeAfter: string | null;
  /** The size of its database file on Node; null on Cloudflare (measuring would cost a request per space). */
  bytes: number | null;
}

// ---------------------------------------------------------------------------
// Passkeys (design §5.6, §5.8.3, §5.8.12-§5.8.14; P6)
// ---------------------------------------------------------------------------

/**
 * What every WebAuthn options call answers: the ceremony to send back with the browser's answer, and the
 * options for @simplewebauthn/browser (`optionsJSON`): PublicKeyCredentialCreationOptionsJSON for the
 * registrations (Account settings, sign-up, invitations, reset), PublicKeyCredentialRequestOptionsJSON for
 * sign-in and re-authentication. A ceremony works once, for 5 minutes (10 for the sign-in field's autofill).
 */
export interface CeremonyDTO<Options = Record<string, unknown>> {
  ceremonyId: string;
  options: Options;
}

/** One of the account's passkeys (GET /api/account/passkeys). */
export interface PasskeyDTO {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** 'singleDevice': bound to one authenticator (lost with it); 'multiDevice': may be synced (backup eligible). */
  deviceType: 'singleDevice' | 'multiDevice';
  /** Synced or backed up now (the authenticator said so at its last use). */
  backedUp: boolean;
  /**
   * Registered for this instance's RP ID (InstanceInfoDTO.passkeys.rpId), so it can sign in here; false for
   * a passkey a domain move orphaned (design §5.6), and for every passkey while passkeys are off.
   */
  rpIdMatches: boolean;
}

/**
 * DELETE /api/account/passkeys/:passkeyId. `acceptedCredentialIds` (this RP ID's passkeys the account keeps)
 * and `userHandle` are for the WebAuthn signal API (PublicKeyCredential.signalAllAcceptedCredentials, with
 * `rpId` InstanceInfoDTO.passkeys.rpId and `userId` the handle), so the browser can forget the removed one.
 */
export interface PasskeyRemovedDTO {
  ok: true;
  acceptedCredentialIds: string[];
  userHandle: string;
}

/** POST /api/account/reauth/password and /api/account/reauth/passkey: the re-auth window's end. */
export interface ReauthDTO {
  ok: true;
  reauthUntil: string | null;
}
