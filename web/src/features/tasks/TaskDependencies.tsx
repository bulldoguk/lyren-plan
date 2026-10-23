// The task detail's dependencies (docs/design/task-dependencies.md): the tasks it waits on ("Blocked by") and
// the ones waiting on it ("Blocks"), each a finish-to-start link. Adding or removing one refreshes every list,
// because it moves the adjusted dates of everything downstream. Read-only for a role that may not change tasks.

import { Plus, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { localToday } from '@shared/dates';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useTaskLink, useTaskQuery } from '../../api/tasks';
import { DueDateLabel, StatusIcon, taskIsClosed } from '../../components/domain';
import { Button, IconButton, Picker, toast, type PickerOption } from '../../components/ui';
import { useOpenTask } from '../../lib/taskLinks';

export interface TaskDependenciesProps {
  task: TaskDTO;
  readOnly?: boolean;
}

export function TaskDependencies({ task, readOnly = false }: TaskDependenciesProps) {
  const headingId = useId();
  const today = localToday();
  const ids = useMemo(() => [...task.blockedBy, ...task.blocks], [task.blockedBy, task.blocks]);
  const linked = useTaskQuery(
    { filter: { ids, archived: 'include', includeArchivedProjects: true }, limit: 200, today },
    { enabled: ids.length > 0 },
  );
  const byId = new Map((linked.data?.tasks ?? []).map((t) => [t.id, t]));
  const link = useTaskLink();
  const change = (id: number, blockerId: number, remove = false) =>
    link.mutate({ id, blockerId, remove }, { onError: (err) => toast.error(err) });

  if (readOnly && ids.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1.5">
      <h2 id={headingId} className="flex min-h-8 items-center text-[13px] font-semibold text-fg-muted">
        Dependencies
      </h2>
      <LinkGroup
        label="Blocked by"
        empty="Waits on nothing."
        ids={task.blockedBy}
        byId={byId}
        today={today}
        readOnly={readOnly}
        onRemove={(other) => change(task.id, other)}
        picker={{
          title: 'Add a blocker',
          exclude: new Set([task.id, ...task.blockedBy, ...task.blocks]),
          onPick: (other) => change(task.id, other),
        }}
      />
      <LinkGroup
        label="Blocks"
        empty="Nothing waits on it."
        ids={task.blocks}
        byId={byId}
        today={today}
        readOnly={readOnly}
        onRemove={(other) => change(other, task.id, true)}
        picker={{
          title: 'Add a task it blocks',
          exclude: new Set([task.id, ...task.blockedBy, ...task.blocks]),
          onPick: (other) => change(other, task.id),
        }}
      />
    </section>
  );
}

interface LinkGroupProps {
  label: string;
  empty: string;
  ids: readonly number[];
  byId: ReadonlyMap<number, TaskDTO>;
  today: string;
  readOnly: boolean;
  onRemove: (otherId: number) => void;
  picker: { title: string; exclude: ReadonlySet<number>; onPick: (otherId: number) => void };
}

function LinkGroup({ label, empty, ids, byId, today, readOnly, onRemove, picker }: LinkGroupProps) {
  const { statusById } = useLookups();
  const openTask = useOpenTask();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-subtle">{label}</h3>
        {!readOnly && <TaskLinkPicker {...picker} />}
      </div>
      {ids.length === 0 ? (
        <p className="text-sm text-fg-subtle">{empty}</p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {ids.map((id) => {
            const other = byId.get(id);
            const status = other ? statusById.get(other.statusId) : undefined;
            return (
              <li key={id} className="group flex min-h-9 min-w-0 items-center gap-2 rounded-md px-1 hover:bg-surface-2">
                {status ? <StatusIcon status={status} size={14} /> : <span className="size-3.5 shrink-0" />}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-baseline gap-2 text-left text-sm"
                  onClick={() => openTask(id)}
                >
                  <span className="shrink-0 font-mono text-xs text-fg-muted">{other?.ref ?? `#${id}`}</span>
                  <span className="truncate text-fg">{other?.title ?? '…'}</span>
                </button>
                {other && (
                  <DueDateLabel
                    date={other.dueDate}
                    adjusted={other.adjustedDueDate}
                    slipDays={other.slipDays}
                    today={today}
                    closed={taskIsClosed(other, statusById)}
                  />
                )}
                {!readOnly && (
                  <IconButton size="sm" aria-label={`Remove the link to ${other?.ref ?? 'this task'}`} icon={<X />} onClick={() => onRemove(id)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "Add" with a searchable list of the space's open tasks (loaded when it opens). */
function TaskLinkPicker({ title, exclude, onPick }: LinkGroupProps['picker']) {
  const [open, setOpen] = useState(false);
  const { projectById } = useLookups();
  const candidates = useTaskQuery(
    { filter: { closedWithinDays: 0 }, sort: { field: 'updatedAt', dir: 'desc' }, limit: 500, today: localToday() },
    { enabled: open },
  );
  const options: PickerOption<number>[] = (candidates.data?.tasks ?? [])
    .filter((t) => !exclude.has(t.id))
    .map((t) => ({
      value: t.id,
      label: `${t.ref} ${t.title}`,
      hint: projectById.get(t.projectId)?.name,
    }));
  return (
    <Picker<number>
      label={title}
      placeholder="Search tasks…"
      emptyText={candidates.isLoading ? 'Loading…' : 'No open tasks match'}
      searchable
      options={options}
      value={undefined}
      open={open}
      onOpenChange={setOpen}
      onChange={(id) => {
        setOpen(false);
        onPick(id);
      }}
      className="w-80"
      trigger={
        <Button size="sm" variant="ghost" icon={<Plus />}>
          Add
        </Button>
      }
    />
  );
}
