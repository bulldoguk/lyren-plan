// Board card (SPEC §8.3). Not a link: a click/tap anywhere opens the task, a long press is
// left to the board's TouchSensor for dragging, and the "⋯" menu (always visible on touch,
// on hover/focus with a mouse) is the non-drag way to change the task.
//
// Extra HTML props (style, dnd-kit listeners/attributes, data-*) and the ref go to the root.

import { clsx } from 'clsx';
import { Archive } from 'lucide-react';
import { forwardRef, memo, useMemo, type HTMLAttributes, type MouseEvent } from 'react';
import type { CardColorBy } from '@shared/board';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace } from '../../app/space';
import { EpicBadge, MilestoneBadge, ProjectBadge, TaskRef } from './EntityBadges';
import { statusFraction } from './entityGroups';
import { BlockedLabel, CommentCountLabel, DueDateLabel, DurationLabel, EstimateLabel, StartDateLabel } from './MetaLabels';
import { taskItemPropsEqual } from './memoCompare';
import { isOpenClick, OPEN_TASK_PROPS, stopCardEvents } from './openClick';
import { Pill } from './Pill';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { TaskActionsMenu } from './TaskActionsMenu';
import { taskActions } from './taskActions';
import type { ExtraMenuItems } from './taskActionItems';
import { DEFAULT_CARD_FIELDS, markdownExcerpt, resolveFields, taskClosedKind, taskColor, type CardFields } from './taskDisplay';
import { TagList } from './Tags';
import { useSharedToday } from './useSharedToday';

export interface TaskCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'children'> {
  task: TaskDTO;
  /** Which metadata to show (board `card.fields`); missing keys use the board defaults. */
  fields?: Partial<CardFields>;
  /** Default 'comfortable'. */
  density?: 'compact' | 'comfortable';
  /** Colored left edge (board `card.colorBy`). Default 'none'. */
  colorBy?: CardColorBy;
  /** Default: open the task drawer. Pass a stable callback (useCallback) to keep memoization. */
  onOpen?: (task: TaskDTO) => void;
  /** Selection highlight (select mode). */
  selected?: boolean;
  /** The card is being dragged: renders as a dimmed placeholder and ignores clicks. */
  dragging?: boolean;
  /** Rendering inside DragOverlay: lifted look, no menu, no clicks. */
  overlay?: boolean;
  /** Board-specific entries for the "⋯" menu (a function is called only when it opens). */
  extraMenuItems?: ExtraMenuItems;
  /** Show the "⋯" menu (default true; never for a role that may not change tasks, which opens the card instead). */
  showMenu?: boolean;
}

const TaskCardImpl = forwardRef<HTMLDivElement, TaskCardProps>(function TaskCard(
  {
    task,
    fields,
    density = 'comfortable',
    colorBy = 'none',
    onOpen,
    selected = false,
    dragging = false,
    overlay = false,
    extraMenuItems,
    showMenu = true,
    className,
    ...rest
  },
  ref,
) {
  const lookups = useLookups();
  const today = useSharedToday();
  const { write } = useSpace().permissions;
  const f = useMemo(() => resolveFields(fields, DEFAULT_CARD_FIELDS), [fields]);
  const compact = density === 'compact';

  const status = lookups.statusById.get(task.statusId);
  const closed = taskClosedKind(task, lookups.statusById);
  const project = f.project ? lookups.projectById.get(task.projectId) : undefined;
  const epic = f.epic && task.epicId !== null ? lookups.epicById.get(task.epicId) : undefined;
  const milestone = f.milestone && task.milestoneId !== null ? lookups.milestoneById.get(task.milestoneId) : undefined;
  const edge = taskColor(task, colorBy, lookups);
  // Compact cards get one line of the description, comfortable ones two.
  const excerpt = f.description && task.description ? markdownExcerpt(task.description, compact ? 90 : 140) : '';
  const menu = showMenu && !overlay && write;

  const showMeta = f.ref || !!project;
  const properties = [
    f.priority && task.priority > 0 && <Pill key="priority" icon={<PriorityIcon priority={task.priority} />} />,
    f.dueDate && (
      <DueDateLabel
        key="due"
        date={task.dueDate}
        adjusted={task.adjustedDueDate}
        slipDays={task.slipDays}
        today={today}
        closed={closed !== null}
      />
    ),
    closed === null && task.blockedBy.length > 0 && <BlockedLabel key="blocked" count={task.blockedBy.length} />,
    f.startDate && <StartDateLabel key="start" date={task.startDate} today={today} />,
    f.estimate && <EstimateLabel key="estimate" value={task.estimate} unit={lookups.settings.estimateUnit} />,
    epic && <EpicBadge key="epic" epic={epic} />,
    milestone && <MilestoneBadge key="milestone" milestone={milestone} />,
    f.tags && task.tags.length > 0 && <TagList key="tags" tags={task.tags} max={compact ? 2 : 3} />,
    task.archivedAt !== null && (
      <Pill key="archived" icon={<Archive aria-hidden />}>
        Archived
      </Pill>
    ),
  ].filter(Boolean);
  const counts = [
    f.commentCount && task.commentCount > 0 && <CommentCountLabel key="comments" count={task.commentCount} />,
    f.worklog && task.worklogMinutes > 0 && <DurationLabel key="worklog" minutes={task.worklogMinutes} plain />,
  ].filter(Boolean);

  const open = (e: MouseEvent<HTMLDivElement>) => {
    if (dragging || overlay || !isOpenClick(e)) return;
    (onOpen ?? taskActions.open)(task);
  };

  return (
    <div
      ref={ref}
      data-task-card=""
      data-task-id={task.id}
      {...rest}
      onClick={open}
      className={clsx(
        'group/card relative flex min-w-0 select-none flex-col rounded-lg border bg-surface text-left',
        'touch-manipulation [-webkit-touch-callout:none]',
        'transition-[border-color,box-shadow,opacity] duration-150',
        compact ? 'gap-1 px-2.5 py-2' : 'gap-1.5 p-3',
        selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-border-strong',
        overlay ? 'rotate-[1.5deg] cursor-grabbing shadow-drag' : 'cursor-pointer shadow-card',
        dragging && 'opacity-40',
        // The title button carries keyboard focus; show the ring on the whole card.
        'has-[[data-open-task]:focus-visible]:outline-2 has-[[data-open-task]:focus-visible]:outline-offset-2 has-[[data-open-task]:focus-visible]:outline-focus',
        className,
      )}
    >
      {edge && <span aria-hidden className="absolute -inset-y-px -left-px w-1 rounded-l-lg" style={{ backgroundColor: edge }} />}

      {showMeta && (
        <div className={clsx('flex min-w-0 items-center gap-1.5 text-[11px] leading-4', menu && 'pr-7')}>
          {f.ref && <TaskRef value={task.ref} />}
          {project && <ProjectBadge project={project} plain />}
        </div>
      )}

      <div className={clsx('flex min-w-0 items-start gap-1.5', menu && !showMeta && 'pr-7')}>
        {f.status && status && (
          <StatusIcon status={status} fraction={statusFraction(status, lookups.statuses)} size={14} className={compact ? 'mt-0.5' : 'mt-[3px]'} />
        )}
        <button
          type="button"
          {...OPEN_TASK_PROPS}
          tabIndex={overlay ? -1 : undefined}
          className={clsx(
            'block min-w-0 flex-1 text-left font-medium outline-none [overflow-wrap:anywhere]',
            compact ? 'text-[13px] leading-[1.125rem]' : 'text-sm leading-5',
            closed ? 'text-fg-muted' : 'text-fg',
            closed === 'cancelled' && 'line-through decoration-fg-subtle',
          )}
        >
          <span className={compact ? 'line-clamp-2' : 'line-clamp-3'}>{task.title}</span>
        </button>
      </div>

      {excerpt && <p className={clsx(compact ? 'line-clamp-1' : 'line-clamp-2', 'text-xs leading-4 text-fg-muted [overflow-wrap:anywhere]')}>{excerpt}</p>}

      {(properties.length > 0 || counts.length > 0) && (
        <div className={clsx('flex min-w-0 flex-wrap items-center gap-1', !compact && 'mt-0.5')}>
          {properties}
          {counts.length > 0 && <span className="ml-auto flex items-center gap-2 pl-1">{counts}</span>}
        </div>
      )}

      {menu && (
        <div data-no-open className={clsx('absolute', compact ? 'right-1 top-1' : 'right-1.5 top-1.5')} {...stopCardEvents}>
          <TaskActionsMenu
            task={task}
            extraItems={extraMenuItems}
            onOpen={onOpen}
            triggerVariant="compact"
            triggerClassName={clsx(
              // Always visible on touch; with a mouse only on hover / keyboard focus / while open.
              'pointer-fine:opacity-0 pointer-fine:focus-visible:opacity-100 pointer-fine:aria-expanded:opacity-100',
              'pointer-fine:group-hover/card:opacity-100 pointer-fine:group-focus-within/card:opacity-100',
            )}
          />
        </div>
      )}
    </div>
  );
});

/** Board card. Memoized: pass stable handlers (useCallback); `fields` compares by content. */
export const TaskCard = memo(TaskCardImpl, taskItemPropsEqual);
TaskCard.displayName = 'TaskCard';
