// List row for a task (TaskList, board list layout, dashboard, search results).
// The layout follows the row's own width (a container query), not the viewport, so rows in
// narrow columns (tablets, the epic / milestone pages) stay readable:
// - Wide (≥ 35rem, so the 36rem bordered drag overlay qualifies): one line —
//   [select] [priority] [ref] [status] title … metadata [⋯]. The title keeps at least
//   max(12rem, 40%); metadata that does not fit drops out chip by chip, tags first, never
//   cut mid-word.
// - Narrow (phones, narrow columns): status + two-line title, metadata wrapped underneath.
// Status and priority are editable in place (optimistic, toast on error), for those who may change tasks.

import { clsx } from 'clsx';
import { Archive } from 'lucide-react';
import { forwardRef, memo, useMemo, type ButtonHTMLAttributes, type HTMLAttributes, type MouseEvent } from 'react';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace } from '../../app/space';
import { Checkbox } from '../ui';
import { EpicBadge, MilestoneBadge, ProjectBadge, TaskRef } from './EntityBadges';
import { statusFraction } from './entityGroups';
import { taskItemPropsEqual } from './memoCompare';
import { BlockedLabel, CommentCountLabel, DueDateLabel, DurationLabel, EstimateLabel, StartDateLabel } from './MetaLabels';
import { isOpenClick, OPEN_TASK_PROPS, stopCardEvents } from './openClick';
import { Pill } from './Pill';
import { PriorityIcon, priorityLabel } from './PriorityIcon';
import { PriorityPicker } from './PriorityPicker';
import { StatusIcon } from './StatusIcon';
import { StatusPicker } from './StatusPicker';
import { TaskActionsMenu } from './TaskActionsMenu';
import { taskActions } from './taskActions';
import type { ExtraMenuItems } from './taskActionItems';
import { resolveRowFields, taskClosedKind, type CardFields, type RowHideKey } from './taskDisplay';
import { TagList } from './Tags';
import { useSharedToday } from './useSharedToday';

export interface TaskRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'children'> {
  task: TaskDTO;
  /** Hide badges that are redundant in context (e.g. 'project' on a project page). */
  hide?: readonly RowHideKey[];
  /** Exact metadata set (board list layout uses `card.fields`); default: ref, status, priority, tags, epic, project, due, estimate, comments. */
  fields?: Partial<CardFields>;
  /** Default: open the task drawer. Pass a stable callback (useCallback). */
  onOpen?: (task: TaskDTO) => void;
  /** Show a selection checkbox. */
  selectable?: boolean;
  selected?: boolean;
  /** `shiftKey` lets lists implement range selection. */
  onSelectedChange?: (selected: boolean, event: { shiftKey: boolean }) => void;
  /** Denser desktop row (36px instead of 44px). */
  compact?: boolean;
  /** Show the task ref (default true). */
  showRef?: boolean;
  /** Status / priority icons open pickers (default true; never for a role that may not change tasks). */
  editable?: boolean;
  /** Extra entries for the "⋯" menu (a function is called only when it opens). */
  extraMenuItems?: ExtraMenuItems;
  /** Show the "⋯" menu (default true; never for a role that may not change tasks, which opens the row instead). */
  showMenu?: boolean;
  /** Highlight (e.g. the task open in the drawer). */
  active?: boolean;
  /** Dimmed placeholder while dragged. */
  dragging?: boolean;
}

/** 28px icon button with a 40px invisible hit area (status / priority in rows). */
const RowIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function RowIconButton(
  { className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'relative inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
        "hover:bg-surface-3 aria-expanded:bg-surface-3 before:absolute before:-inset-1.5 before:content-['']",
        'focus-visible:outline-2 focus-visible:outline-offset-0',
        className,
      )}
      {...rest}
    />
  );
});

const noop = () => {};

const TaskRowImpl = forwardRef<HTMLDivElement, TaskRowProps>(function TaskRow(
  {
    task,
    hide,
    fields,
    onOpen,
    selectable = false,
    selected = false,
    onSelectedChange,
    compact = false,
    showRef = true,
    editable: editableProp = true,
    extraMenuItems,
    showMenu = true,
    active = false,
    dragging = false,
    className,
    ...rest
  },
  ref,
) {
  const lookups = useLookups();
  const today = useSharedToday();
  // Viewers see the pickers' values only (design §12.9).
  const { write } = useSpace().permissions;
  const editable = editableProp && write;
  const hideKey = hide?.join(',') ?? '';
  // hideKey stands in for `hide`, which callers often pass as an inline array.
  const f = useMemo(() => resolveRowFields(fields, hide, showRef), [fields, hideKey, showRef]);

  const status = lookups.statusById.get(task.statusId);
  const closed = taskClosedKind(task, lookups.statusById);
  const project = f.project ? lookups.projectById.get(task.projectId) : undefined;
  const epic = f.epic && task.epicId !== null ? lookups.epicById.get(task.epicId) : undefined;
  const milestone = f.milestone && task.milestoneId !== null ? lookups.milestoneById.get(task.milestoneId) : undefined;

  const open = (e: MouseEvent<HTMLDivElement>) => {
    if (dragging || !isOpenClick(e)) return;
    (onOpen ?? taskActions.open)(task);
  };

  const statusIcon = status && <StatusIcon status={status} fraction={statusFraction(status, lookups.statuses)} label={null} />;
  const titleClasses = clsx(
    closed ? 'text-fg-muted' : 'text-fg',
    closed === 'cancelled' && 'line-through decoration-fg-subtle',
  );

  return (
    <div
      ref={ref}
      data-task-row=""
      data-task-id={task.id}
      {...rest}
      onClick={open}
      className={clsx(
        // The row is the query container: its children switch to the one-line layout at 35rem.
        'group/row @container relative min-w-0 cursor-pointer select-none text-left transition-colors',
        'touch-manipulation [-webkit-touch-callout:none]',
        selected ? 'bg-accent-soft' : active ? 'bg-surface-2' : 'hover:bg-surface-2',
        dragging && 'opacity-40',
        'has-[[data-open-task]:focus-visible]:outline-2 has-[[data-open-task]:focus-visible]:-outline-offset-2 has-[[data-open-task]:focus-visible]:outline-focus',
        className,
      )}
    >
      <div
        className={clsx(
          'flex min-w-0 items-start gap-2 px-3 @min-[35rem]:items-center @min-[35rem]:gap-2.5',
          compact ? 'py-2 @min-[35rem]:h-9 @min-[35rem]:py-0' : 'py-2.5 @min-[35rem]:h-11 @min-[35rem]:py-0',
        )}
      >
        {selectable && (
          <span data-no-open className="flex h-5 shrink-0 items-center @min-[35rem]:h-auto" {...stopCardEvents}>
            <Checkbox
              aria-label={`Select ${task.ref}`}
              checked={selected}
              onChange={noop}
              onClick={(e) => onSelectedChange?.(e.currentTarget.checked, { shiftKey: e.shiftKey })}
            />
          </span>
        )}

        {f.priority && (
          <span data-no-open className="hidden shrink-0 @min-[35rem]:flex" {...stopCardEvents}>
            {editable ? (
              <PriorityPicker
                value={task.priority}
                onChange={(priority) => taskActions.update(task, { priority })}
                trigger={
                  <RowIconButton aria-label={`${priorityLabel(task.priority)}. Change priority`}>
                    <PriorityIcon priority={task.priority} label={null} />
                  </RowIconButton>
                }
              />
            ) : (
              <span className="flex size-7 items-center justify-center">
                <PriorityIcon priority={task.priority} />
              </span>
            )}
          </span>
        )}

        {f.ref && <TaskRef value={task.ref} className="hidden min-w-[3.75rem] @min-[35rem]:block" />}

        {f.status && status && (
          <span data-no-open className="-my-1 flex shrink-0 @min-[35rem]:my-0" {...stopCardEvents}>
            {editable ? (
              <StatusPicker
                value={task.statusId}
                onChange={(statusId) => taskActions.update(task, { statusId })}
                trigger={<RowIconButton aria-label={`Status: ${status.name}. Change status`}>{statusIcon}</RowIconButton>}
              />
            ) : (
              <span role="img" aria-label={`Status: ${status.name}`} className="flex size-7 items-center justify-center">
                {statusIcon}
              </span>
            )}
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 @min-[35rem]:flex-row @min-[35rem]:items-center @min-[35rem]:gap-3">
          <button
            type="button"
            {...OPEN_TASK_PROPS}
            title={task.title}
            className={clsx(
              'min-w-0 text-left leading-5 outline-none [overflow-wrap:anywhere] @min-[35rem]:min-w-[max(12rem,40%)] @min-[35rem]:flex-1',
              compact ? 'text-[13px]' : 'text-sm',
              titleClasses,
            )}
          >
            <span className="line-clamp-2 @min-[35rem]:hidden">{task.title}</span>
            <span className="hidden truncate @min-[35rem]:block">{task.title}</span>
          </button>

          {/* One line: a single 20px chip row (chips are h-5). A chip that does not fit wraps
              onto a clipped second line, so chips drop out whole, never cut mid-word; `safe`
              keeps an over-wide chip start-aligned (ellipsis on the right, not cut on the left).
              Tags only take the space the other chips leave (basis 0, up to their own width) and
              wrap one by one inside it; the zero-width, full-height first item means even the
              first tag wraps away whole (onto the clipped line) instead of shrinking to a sliver. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1 @min-[35rem]:h-5 @min-[35rem]:content-start @min-[35rem]:items-start @min-[35rem]:justify-end-safe @min-[35rem]:overflow-hidden">
            {f.ref && <TaskRef value={task.ref} className="@min-[35rem]:hidden" />}
            {f.priority && task.priority > 0 && (
              <span className="flex @min-[35rem]:hidden">
                <PriorityIcon priority={task.priority} size={14} />
              </span>
            )}
            {f.tags && task.tags.length > 0 && (
              <span className="contents @min-[35rem]:flex @min-[35rem]:min-w-0 @min-[35rem]:max-w-max @min-[35rem]:grow @min-[35rem]:basis-0 @min-[35rem]:flex-wrap @min-[35rem]:items-start @min-[35rem]:gap-1 @min-[35rem]:overflow-hidden">
                <span aria-hidden className="hidden @min-[35rem]:block @min-[35rem]:h-5 @min-[35rem]:w-0" />
                <TagList tags={task.tags} max={3} className="@min-[35rem]:contents" />
              </span>
            )}
            {/* The first chip after the tags, so on one line it is never one that drops out. */}
            {task.archivedAt !== null && <Pill icon={<Archive aria-hidden />}>Archived</Pill>}
            {epic && <EpicBadge epic={epic} />}
            {milestone && <MilestoneBadge milestone={milestone} />}
            {project && <ProjectBadge project={project} />}
            {f.dueDate && (
              <DueDateLabel date={task.dueDate} adjusted={task.adjustedDueDate} slipDays={task.slipDays} today={today} closed={closed !== null} />
            )}
            {closed === null && <BlockedLabel count={task.blockedBy.length} />}
            {f.startDate && <StartDateLabel date={task.startDate} today={today} />}
            {f.estimate && <EstimateLabel value={task.estimate} unit={lookups.settings.estimateUnit} />}
            {f.commentCount && task.commentCount > 0 && <CommentCountLabel count={task.commentCount} />}
            {f.worklog && task.worklogMinutes > 0 && <DurationLabel minutes={task.worklogMinutes} plain />}
          </div>
        </div>

        {showMenu && write && (
          <span data-no-open className="-my-1 flex shrink-0 @min-[35rem]:my-0" {...stopCardEvents}>
            <TaskActionsMenu
              task={task}
              extraItems={extraMenuItems}
              onOpen={onOpen}
              triggerVariant="compact"
              triggerClassName={clsx(
                'pointer-fine:opacity-0 pointer-fine:focus-visible:opacity-100 pointer-fine:aria-expanded:opacity-100',
                'pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100',
              )}
            />
          </span>
        )}
      </div>
    </div>
  );
});

/** Task list row. Memoized: pass stable handlers (useCallback); `hide` / `fields` compare by content. */
export const TaskRow = memo(TaskRowImpl, taskItemPropsEqual);
TaskRow.displayName = 'TaskRow';
