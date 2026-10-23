// Human-readable sentences for activity entries (SPEC §5.8), shared by the task History tab,
// ActivityFeed/ActivityItem and the dashboard. Pure: everything comes from the entry (its
// `data` keeps display snapshots) plus a few lookups for fallbacks and the estimate unit.

import { PRIORITY_META, type EstimateUnit, type Priority } from '@shared/constants';
import { formatMinutes } from '@shared/duration';
import type { ActivityAction, ActivityDTO, FieldChange } from '@shared/types';
import { formatDate, formatEstimate, isoToLocalDate } from '../../lib/format';
import { markdownExcerpt } from '../../components/domain/taskDisplay';

/** The parts of `Lookups` used for fallbacks (a full `useLookups()` result fits). */
export interface ActivityTextLookups {
  settings?: { estimateUnit: EstimateUnit };
  projectById?: ReadonlyMap<number, { name: string }>;
  statusById?: ReadonlyMap<number, { name: string }>;
  epicById?: ReadonlyMap<number, { name: string }>;
  milestoneById?: ReadonlyMap<number, { name: string }>;
}

/** Name shown for entries whose actor account no longer exists. */
export const UNKNOWN_ACTOR = 'Someone';

const MAX_QUOTED = 80;

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** "a", "a and b", "a, b, and c". */
export function joinList(items: readonly string[]): string {
  return listFormat.format(items);
}

function clip(text: string, max = MAX_QUOTED): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function quote(text: string | null | undefined): string {
  return `“${clip(text ?? '') || 'untitled'}”`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function actorName(entry: Pick<ActivityDTO, 'actor'>): string {
  return entry.actor?.displayName.trim() || UNKNOWN_ACTOR;
}

// ---- Field changes ------------------------------------------------------------------

type Labeller = (change: FieldChange, side: 'from' | 'to') => string | null;

function entityLabel(map: ReadonlyMap<number, { name: string }> | undefined): Labeller {
  return (change, side) => {
    const label = side === 'from' ? change.fromLabel : change.toLabel;
    if (label) return label;
    const id = num(side === 'from' ? change.from : change.to);
    return id === null ? null : (map?.get(id)?.name ?? null);
  };
}

const priorityLabel: Labeller = (change, side) => {
  const label = side === 'from' ? change.fromLabel : change.toLabel;
  if (label) return label;
  const value = side === 'from' ? change.from : change.to;
  return typeof value === 'number' && value in PRIORITY_META ? PRIORITY_META[value as Priority].label : null;
};

const plainLabel: Labeller = (change, side) => {
  const label = side === 'from' ? change.fromLabel : change.toLabel;
  if (label) return label;
  const value = side === 'from' ? change.from : change.to;
  return value === null || value === undefined ? null : String(value);
};

/** "changed status from Todo → In Progress" (unknown sides read as "none"). */
function arrowChange(what: string, change: FieldChange, label: Labeller): string {
  return `changed ${what} from ${label(change, 'from') ?? 'none'} → ${label(change, 'to') ?? 'none'}`;
}

/** set / removed / changed phrasing for optional references (epic, milestone). */
function refChange(what: string, change: FieldChange, label: Labeller): string {
  // undefined = no reference (null id); null = the referenced entity is gone (no label).
  const side = (s: 'from' | 'to'): string | null | undefined => {
    const id = s === 'from' ? change.from : change.to;
    return id === null || id === undefined ? undefined : label(change, s);
  };
  const named = (name: string | null) => (name === null ? `a deleted ${what}` : quote(name));
  const from = side('from');
  const to = side('to');
  if (from === undefined && to !== undefined) return `set the ${what} to ${named(to)}`;
  if (to === undefined && from !== undefined) return from === null ? `removed the ${what}` : `removed the ${what} ${quote(from)}`;
  if (from === undefined || to === undefined) return `changed the ${what}`;
  return `changed the ${what} from ${named(from)} to ${named(to)}`;
}

/** set / removed / changed phrasing for values formatted by `fmt` (dates, estimates). */
function valueChange(what: string, change: FieldChange, fmt: (v: string | number) => string): string {
  const from = typeof change.from === 'string' || typeof change.from === 'number' ? fmt(change.from) : null;
  const to = typeof change.to === 'string' || typeof change.to === 'number' ? fmt(change.to) : null;
  if (from === null && to !== null) return `set the ${what} to ${to}`;
  if (to === null && from !== null) return `removed the ${what}`;
  if (from === null || to === null) return `changed the ${what}`;
  return `changed the ${what} from ${from} to ${to}`;
}

function tagsChange(change: FieldChange): string {
  const parts: string[] = [];
  const added = change.added ?? [];
  const removed = change.removed ?? [];
  if (added.length > 0) parts.push(`added ${added.length === 1 ? 'tag' : 'tags'} ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`removed ${removed.length === 1 ? 'tag' : 'tags'} ${removed.join(', ')}`);
  return parts.length > 0 ? joinList(parts) : 'changed the tags';
}

/** A change of the task's blockers (task dependencies): refs added and removed. */
function blockersChange(change: FieldChange): string {
  const parts: string[] = [];
  const added = change.added ?? [];
  const removed = change.removed ?? [];
  if (added.length > 0) parts.push(`made it wait on ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`removed the link to ${removed.join(', ')}`);
  return parts.length > 0 ? joinList(parts) : 'changed what it waits on';
}

function fieldWords(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** One phrase (without the actor) per changed field. */
export function changePhrase(change: FieldChange, lookups: ActivityTextLookups = {}, subject = 'task'): string {
  const unit = lookups.settings?.estimateUnit ?? 'points';
  switch (change.field) {
    case 'title':
      return typeof change.from === 'string' && typeof change.to === 'string'
        ? `changed the title from ${quote(change.from)} to ${quote(change.to)}`
        : 'changed the title';
    case 'name':
      return typeof change.from === 'string' && typeof change.to === 'string'
        ? `renamed it from ${quote(change.from)} to ${quote(change.to)}`
        : 'renamed it';
    case 'description':
      return 'edited the description';
    case 'color':
      return 'changed the color';
    case 'status':
      return arrowChange('status', change, entityLabel(lookups.statusById));
    case 'priority':
      return arrowChange('priority', change, priorityLabel);
    case 'key':
      return arrowChange('the key', change, plainLabel);
    case 'epic':
      return refChange('epic', change, entityLabel(lookups.epicById));
    case 'milestone':
      return refChange('milestone', change, entityLabel(lookups.milestoneById));
    case 'startDate':
      return valueChange('start date', change, (v) => formatDate(String(v)));
    case 'dueDate':
      return valueChange('due date', change, (v) => formatDate(String(v)));
    case 'estimate':
      return valueChange('estimate', change, (v) => formatEstimate(Number(v), unit));
    case 'tags':
      return tagsChange(change);
    case 'blockedBy':
      return blockersChange(change);
    case 'archived':
      return change.to === true ? `archived the ${subject}` : `restored the ${subject} from the archive`;
    default:
      return `changed ${fieldWords(change.field)}`;
  }
}

// ---- Whole entries ------------------------------------------------------------------

const ENTITY_WORD: Record<string, string> = { project: 'project', milestone: 'milestone', epic: 'epic' };

function entityName(entry: ActivityDTO, lookups: ActivityTextLookups): string | null {
  const fromData = str(entry.data.name) ?? str(entry.data.title);
  if (fromData) return fromData;
  if (entry.entityId === null) return null;
  const map =
    entry.entityType === 'project' ? lookups.projectById : entry.entityType === 'milestone' ? lookups.milestoneById : lookups.epicById;
  return map?.get(entry.entityId)?.name ?? null;
}

function changesOf(entry: ActivityDTO): FieldChange[] {
  return Array.isArray(entry.data.changes) ? entry.data.changes.filter((c) => c && typeof c.field === 'string') : [];
}

function worklogPhrase(entry: ActivityDTO): string {
  const minutes = num(entry.data.minutes) ?? 0;
  const date = str(entry.data.date);
  const duration = minutes > 0 ? formatMinutes(minutes) : null;
  // Mention the day only when the work happened on another day than it was logged.
  const day = date && date !== isoToLocalDate(entry.createdAt) ? formatDate(date) : null;
  switch (entry.action) {
    case 'worklog.created':
      return duration ? `logged ${duration}${day ? ` for ${day}` : ''}` : `added a work log note${day ? ` for ${day}` : ''}`;
    case 'worklog.updated':
      return duration ? `edited logged time (${duration}${date ? ` on ${formatDate(date)}` : ''})` : 'edited a work log note';
    default:
      return duration ? `removed ${duration} of logged time` : 'deleted a work log note';
  }
}

/**
 * What happened, without the actor — one phrase per change for `*.updated` (the task History
 * tab lists them separately), otherwise a single phrase. Task entries never name the task
 * (callers show it next to the sentence); structural entries name their subject.
 */
export function activityPhrases(entry: ActivityDTO, lookups: ActivityTextLookups = {}): string[] {
  const action: ActivityAction = entry.action;
  const data = entry.data;
  switch (action) {
    case 'task.created': {
      const copyOf = str(data.duplicatedFrom);
      return [copyOf ? `created the task as a copy of ${copyOf}` : 'created the task'];
    }
    case 'task.updated': {
      const changes = changesOf(entry);
      // A rebaseline accepted the slip its blockers caused (task dependencies): say so on its date changes.
      const suffix = data.rebaseline === true ? ' (rebaseline)' : '';
      return changes.length > 0 ? changes.map((c) => changePhrase(c, lookups, 'task') + suffix) : ['updated the task'];
    }
    case 'task.moved': {
      const projectName = (name: unknown, id: unknown): string | null => {
        const projectId = num(id);
        return str(name) ?? (projectId === null ? null : (lookups.projectById?.get(projectId)?.name ?? null));
      };
      const from = str(data.fromRef) ?? projectName(data.fromProjectName, data.fromProjectId);
      const to = str(data.toRef) ?? projectName(data.toProjectName, data.toProjectId);
      if (from && to) return [`moved the task from ${from} to ${to}`];
      return [to ? `moved the task to ${to}` : 'moved the task to another project'];
    }
    case 'task.deleted':
      return ['deleted the task'];
    case 'comment.created':
      return ['commented'];
    case 'comment.updated':
      return ['edited a comment'];
    case 'comment.deleted':
      return ['deleted a comment'];
    case 'worklog.created':
    case 'worklog.updated':
    case 'worklog.deleted':
      return [worklogPhrase(entry)];
    case 'project.created':
    case 'milestone.created':
    case 'epic.created':
      return [`created ${ENTITY_WORD[entry.entityType] ?? entry.entityType} ${quote(entityName(entry, lookups))}`];
    case 'project.deleted':
    case 'milestone.deleted':
    case 'epic.deleted':
      return [`deleted ${ENTITY_WORD[entry.entityType] ?? entry.entityType} ${quote(entityName(entry, lookups))}`];
    case 'project.updated':
    case 'milestone.updated':
    case 'epic.updated': {
      const word = ENTITY_WORD[entry.entityType] ?? entry.entityType;
      const changes = changesOf(entry);
      const rename = changes.length === 1 && changes[0]!.field === 'name' ? changes[0]! : null;
      if (rename && typeof rename.from === 'string' && typeof rename.to === 'string') {
        return [`renamed ${word} ${quote(rename.from)} to ${quote(rename.to)}`];
      }
      const head = `updated ${word} ${quote(entityName(entry, lookups))}`;
      return changes.length > 0 ? [`${head}: ${joinList(changes.map((c) => changePhrase(c, lookups, word)))}`] : [head];
    }
    default: {
      const unknown: string = action;
      return [`${unknown.endsWith('.deleted') ? 'deleted' : unknown.endsWith('.created') ? 'created' : 'updated'} a ${entry.entityType}`];
    }
  }
}

/** Full sentence: "Alex changed status from Todo → In Progress and added tag bug". */
export function describeActivity(entry: ActivityDTO, lookups: ActivityTextLookups = {}): string {
  return `${actorName(entry)} ${joinList(activityPhrases(entry, lookups))}`;
}

/** The task an entry belongs to: the live task when it still exists, else the data snapshot. */
export interface ActivityTaskInfo {
  /** null once the task is deleted. */
  id: number | null;
  ref: string | null;
  title: string | null;
}

export function activityTask(entry: ActivityDTO): ActivityTaskInfo | null {
  if (entry.task) return { id: entry.task.id, ref: entry.task.ref, title: entry.task.title };
  const isTaskEvent = entry.entityType === 'task' || entry.entityType === 'comment' || entry.entityType === 'worklog';
  if (!isTaskEvent) return null;
  const ref = str(entry.data.ref) ?? str(entry.data.toRef);
  const title = str(entry.data.title);
  return ref || title ? { id: null, ref, title } : null;
}

/** Secondary text: the comment excerpt (plain text) or the work-log note. */
export function activityDetail(entry: ActivityDTO): string | null {
  if (entry.action === 'comment.created' || entry.action === 'comment.updated') {
    const excerpt = str(entry.data.excerpt);
    return excerpt ? markdownExcerpt(excerpt, 160) || null : null;
  }
  if (entry.action === 'worklog.created' || entry.action === 'worklog.updated') {
    const note = str(entry.data.note);
    return note ? clip(note, 160) : null;
  }
  return null;
}
