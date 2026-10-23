// The task itself, shared by the drawer and the full page: breadcrumb, editable title,
// properties, description, meta and the timeline (comments / work log / history). Everything but the
// timeline is read-only for a role that may not change tasks (design §12.9).
// Narrow containers (drawer, phones) stack properties above the description; wide ones
// (the full page on desktop) put the properties in a sticky right column.

import { clsx } from 'clsx';
import { Archive, ChevronRight, Link2 } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatMinutes } from '@shared/duration';
import { LIMITS } from '@shared/constants';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace, useSpaceId } from '../../app/space';
import { EpicDot, taskActions } from '../../components/domain';
import { Button, ColorDot, InlineEdit, toast, type MenuItem } from '../../components/ui';
import { copyText } from '../../lib/clipboard';
import { formatDateTime, formatRelativeTime } from '../../lib/format';
import { creatorText } from '../../lib/people';
import { epicUrl, milestoneUrl, projectUrl } from '../../lib/taskLinks';
import { TaskTimeline } from '../timeline/TaskTimeline';
import { taskLink } from './taskHelpers';
import { TaskDependencies } from './TaskDependencies';
import { TaskDescription } from './TaskDescription';
import { TaskProperties } from './TaskProperties';
import { ignoreRejection, useTaskSave } from './useTaskSave';

export interface TaskDetailProps {
  task: TaskDTO;
  /** 'drawer' (narrow, breadcrumb in the body) or 'page' (breadcrumb lives in the PageHeader on desktop). */
  variant: 'drawer' | 'page';
}

/** Imperative handle: the element that should receive focus when the detail opens. */
export interface TaskDetailHandle {
  focusTarget: () => HTMLElement | null;
}

export const TaskDetail = forwardRef<TaskDetailHandle, TaskDetailProps>(function TaskDetail({ task, variant }, ref) {
  const lookups = useLookups();
  const { write } = useSpace().permissions;
  const save = useTaskSave(task.id);
  const titleRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ focusTarget: () => titleRef.current?.querySelector<HTMLElement>('button:not(:disabled), textarea') ?? null }), []);

  const createdBy = creatorText(task.createdBy, lookups.personById);

  return (
    <div className="@container min-w-0">
      <div
        className={clsx(
          'grid min-w-0 gap-x-8 gap-y-5',
          "[grid-template-areas:'head'_'props'_'main'] grid-cols-[minmax(0,1fr)]",
          variant === 'page' && "@3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:[grid-template-areas:'head_props'_'main_props']",
        )}
      >
        <div className="flex min-w-0 flex-col gap-2 [grid-area:head]">
          <TaskBreadcrumb task={task} className={variant === 'page' ? 'md:hidden' : undefined} />
          <div ref={titleRef}>
            <InlineEdit
              value={task.title}
              aria-label="Task title"
              disabled={!write}
              maxLength={LIMITS.titleMax}
              onSave={(title) => ignoreRejection(save({ title }))}
              className={clsx('font-semibold leading-snug text-fg', variant === 'page' ? 'text-xl md:text-2xl' : 'text-lg md:text-xl')}
            />
          </div>
          {task.archivedAt !== null && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              <Archive aria-hidden className="size-4 shrink-0" />
              <span className="flex-1">This task is archived and hidden from lists and boards.</span>
              {write && (
                <Button size="sm" onClick={() => taskActions.setArchived(task, false)}>
                  Unarchive
                </Button>
              )}
            </div>
          )}
        </div>

        <aside
          aria-label="Properties"
          className={clsx('min-w-0 self-start [grid-area:props]', variant === 'page' && '@3xl:sticky @3xl:top-24')}
        >
          <TaskProperties task={task} save={save} readOnly={!write} />
        </aside>

        <div className="flex min-w-0 flex-col gap-6 [grid-area:main]">
          <TaskDescription task={task} save={save} readOnly={!write} />
          <TaskDependencies task={task} readOnly={!write} />
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle">
            <span title={formatDateTime(task.createdAt)}>
              Created {formatRelativeTime(task.createdAt)}
              {createdBy && ` by ${createdBy}`}
            </span>
            {task.updatedAt !== task.createdAt && <span title={formatDateTime(task.updatedAt)}>Updated {formatRelativeTime(task.updatedAt)}</span>}
            {task.completedAt && <span title={formatDateTime(task.completedAt)}>Closed {formatRelativeTime(task.completedAt)}</span>}
            {task.worklogMinutes > 0 && <span>{formatMinutes(task.worklogMinutes)} logged</span>}
          </p>
          <TaskTimeline task={task} />
        </div>
      </div>
    </div>
  );
});

/** Project › Milestone › Epic links. */
export function TaskBreadcrumb({ task, className }: { task: TaskDTO; className?: string }) {
  const sid = useSpaceId();
  const { projectById, milestoneById, epicById } = useLookups();
  const project = projectById.get(task.projectId);
  const milestone = task.milestoneId !== null ? milestoneById.get(task.milestoneId) : undefined;
  const epic = task.epicId !== null ? epicById.get(task.epicId) : undefined;
  if (!project) return null;
  const crumbs: Array<{ key: string; to: string; label: string; icon?: ReactNode }> = [
    { key: 'p', to: projectUrl(sid, project.id), label: project.name, icon: <ColorDot color={project.color} square size="xs" /> },
  ];
  if (milestone) crumbs.push({ key: 'm', to: milestoneUrl(sid, project.id, milestone.id), label: milestone.name });
  if (epic) crumbs.push({ key: 'e', to: epicUrl(sid, project.id, epic.id), label: epic.name, icon: <EpicDot color={epic.color} /> });
  return (
    <nav aria-label="Breadcrumb" className={clsx('min-w-0', className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-fg-muted">
        {crumbs.map((c, i) => (
          <li key={c.key} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-subtle" />}
            <Link to={c.to} className="flex min-h-6 min-w-0 items-center gap-1.5 rounded px-0.5 hover:text-fg">
              {c.icon}
              <span className="max-w-48 truncate">{c.label}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** "Copy link" for a task of the space (toast feedback). */
export function copyTaskLink(spaceId: string, task: TaskDTO): void {
  copyText(taskLink(spaceId, task)).then(
    () => toast.success(`Copied link to ${task.ref}`),
    () => toast.error('Could not copy the link'),
  );
}

/** Extra task-menu entries of the detail views. */
export function detailMenuItems(spaceId: string, task: TaskDTO, extra: MenuItem[] = []): MenuItem[] {
  return [{ label: 'Copy link', icon: <Link2 />, onSelect: () => copyTaskLink(spaceId, task) }, ...extra];
}
