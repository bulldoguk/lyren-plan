// Property panel of the task detail: every row is a domain picker that saves immediately, or shows
// its value only (readOnly: a role that may not change tasks, design §12.9).

import { Fragment, type ReactNode } from 'react';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import {
  DatePicker,
  EpicPicker,
  EstimatePicker,
  PriorityPicker,
  ProjectPicker,
  StatusPicker,
  TagPicker,
  tagPatch,
  taskIsClosed,
} from '../../components/domain';
import { formatDate } from '../../lib/format';
import { useIsMobile } from '../../lib/hooks';
import type { SaveOptions } from './useTaskSave';
import { ignoreRejection } from './useTaskSave';

export interface TaskPropertiesProps {
  task: TaskDTO;
  save: (patch: TaskUpdateInput, opts?: SaveOptions) => Promise<TaskDTO>;
  /** The pickers show their values and do not open. */
  readOnly?: boolean;
}

/**
 * Desktop: a labelled list (label column + full-width value buttons). Phones: a compact
 * wrap of bordered chips (each button's accessible name still includes its label).
 */
export function TaskProperties({ task, save, readOnly = false }: TaskPropertiesProps) {
  const { statusById, projectById } = useLookups();
  const compact = useIsMobile();
  const closed = taskIsClosed(task, statusById);
  const run = (patch: TaskUpdateInput, opts?: SaveOptions) => ignoreRejection(save(patch, opts));
  const tagIds = task.tags.map((t) => t.id);
  const fullWidth = { ...(compact ? { bordered: true } : { fullWidth: true }), ...(readOnly && { readOnly: true }) };
  const Row = compact ? ChipRow : ListRow;

  const rows = (
    <>
      <Row label="Status">
        <StatusPicker value={task.statusId} onChange={(statusId) => run({ statusId })} triggerProps={fullWidth} />
      </Row>
      <Row label="Priority">
        <PriorityPicker value={task.priority} onChange={(priority) => run({ priority })} triggerProps={fullWidth} />
      </Row>
      <Row label="Project">
        <ProjectPicker
          value={task.projectId}
          onChange={(projectId) => {
            if (projectId === task.projectId) return;
            const target = projectById.get(projectId);
            run({ projectId }, { success: (saved) => `Moved to ${target?.name ?? 'project'} as ${saved.ref}` });
          }}
          triggerProps={fullWidth}
        />
      </Row>
      <Row label="Epic">
        <EpicPicker projectId={task.projectId} value={task.epicId} onChange={(epicId) => run({ epicId })} triggerProps={fullWidth} />
      </Row>
      <Row label="Tags">
        <TagPicker
          value={tagIds}
          onChange={(next) => {
            const patch = tagPatch(tagIds, next);
            if (patch) run(patch);
          }}
          triggerProps={fullWidth}
          maxChips={4}
        />
      </Row>
      <Row label="Start date">
        <DatePicker
          kind="start"
          label="Start date"
          value={task.startDate}
          max={task.dueDate ?? undefined}
          onChange={(startDate) => run({ startDate })}
          triggerProps={fullWidth}
        />
      </Row>
      <Row label="Due date">
        <DatePicker
          label="Due date"
          value={task.dueDate}
          closed={closed}
          min={task.startDate ?? undefined}
          onChange={(dueDate) => run({ dueDate })}
          triggerProps={fullWidth}
        />
      </Row>
      {task.slipDays > 0 && !closed && (
        <Row label="Adjusted due">
          {/* Its blockers push it later (task dependencies): the date lists go by, and the slip. */}
          <span className="flex min-h-8 items-center px-2 text-sm text-warning" title="Worked out from when its blockers finish">
            {formatDate(task.adjustedDueDate)} · +{task.slipDays}d
          </span>
        </Row>
      )}
      <Row label="Estimate">
        <EstimatePicker value={task.estimate} onChange={(estimate) => run({ estimate })} triggerProps={fullWidth} />
      </Row>
    </>
  );

  if (compact) return <div className="flex flex-wrap gap-2">{rows}</div>;
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-px rounded-lg border border-border bg-surface px-1 py-1.5 shadow-card">
      {rows}
    </dl>
  );
}

function ListRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="truncate pl-2 text-[13px] text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function ChipRow({ children }: { label: string; children: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}
