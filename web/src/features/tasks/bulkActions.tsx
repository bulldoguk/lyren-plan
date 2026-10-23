// The bulk task menu shared by TaskList's selection bar (BulkActionBar) and a board's select
// mode (BoardView): set status / priority / due date / epic, add or remove tags, archive or
// unarchive, delete — one all-or-nothing request each, with the same items, messages and
// Undo in both places so the two surfaces can't drift apart.

import { Archive, ArchiveRestore, CalendarDays, CalendarSync, CircleDashed, Layers, Tag, Tags, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { PRIORITY_META } from '@shared/constants';
import type { ISODate } from '@shared/dates';
import type { TaskBulkUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useBulkUpdateTasks } from '../../api/tasks';
import {
  DateField,
  EpicDot,
  epicGroupLabel,
  groupEpicsByMilestone,
  PRIORITY_ORDER,
  PriorityIcon,
  quickDates,
  StatusIcon,
  statusFraction,
  TagPickerList,
  useSharedToday,
  useTagOptions,
} from '../../components/domain';
import { Button, Dialog, PickerList, toast, useConfirm, useSheetMode, type MenuItem } from '../../components/ui';
import { formatDate, pluralize } from '../../lib/format';
import { useBulkDeleteTasksClosingDrawer } from './bulkDelete';
import { RebaselineDialog } from './RebaselineDialog';
import { archiveTargets, commonProjectId } from './taskListModel';

type BulkPatch = TaskBulkUpdateInput['patch'];
type DialogKind = 'due' | 'addTags' | 'removeTags' | 'rebaseline' | null;

export interface BulkTaskActions {
  /** A bulk request is running. */
  busy: boolean;
  /** No task selected, or busy: the action items are disabled. */
  disabled: boolean;
  statusItems: MenuItem[];
  priorityItems: MenuItem[];
  dueItems: MenuItem[];
  /** "Set epic" (a submenu; disabled when the selection spans projects). */
  epicItem: MenuItem;
  /** "Add tags…", "Remove tags…". */
  tagItems: MenuItem[];
  /** "Archive" and / or "Unarchive", each acting only on the tasks it changes. */
  archiveItems: MenuItem[];
  deleteItem: MenuItem;
  /** Pass to each bulk Menu: opening the next menu dismisses the previous result toast. */
  onMenuOpenChange: (open: boolean) => void;
  /** The due-date and tag dialogs; render once next to the menus. */
  dialogs: ReactNode;
}

/** `tasks`: the selected tasks. `onDeleted` runs after a bulk delete (clear the selection). */
export function useBulkTaskActions(tasks: readonly TaskDTO[], { onDeleted }: { onDeleted: () => void }): BulkTaskActions {
  const lookups = useLookups();
  const today = useSharedToday();
  const confirm = useConfirm();
  const bulkUpdate = useBulkUpdateTasks();
  const bulkDelete = useBulkDeleteTasksClosingDrawer();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const count = tasks.length;
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const busy = bulkUpdate.isPending || bulkDelete.isPending;
  const disabled = count === 0 || busy;
  const noun = pluralize(count, 'task');

  // The last result toast goes away once the next bulk menu opens: the menu may open where
  // that toast sits, and the user has moved on.
  const resultToast = useRef<number | null>(null);
  const onMenuOpenChange = (open: boolean) => {
    if (!open || resultToast.current === null) return;
    toast.dismiss(resultToast.current);
    resultToast.current = null;
  };

  /** `targetIds` defaults to every selected task. */
  const apply = (patch: BulkPatch, message: string, undo?: BulkPatch, targetIds: number[] = ids) => {
    bulkUpdate.mutate(
      { ids: targetIds, patch },
      {
        onSuccess: () => {
          resultToast.current = toast.success(
            message,
            undo
              ? {
                  action: {
                    label: 'Undo',
                    onClick: () => bulkUpdate.mutate({ ids: targetIds, patch: undo }, { onError: (err) => toast.error(err) }),
                  },
                }
              : undefined,
          );
        },
        onError: (err) => toast.error(err),
      },
    );
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${noun}?`,
      body: `${count === 1 ? 'This task is' : 'These tasks are'} deleted permanently, including comments and work logs. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    bulkDelete.mutate(ids, {
      onSuccess: ({ deleted }) => {
        toast.success(`Deleted ${pluralize(deleted, 'task')}`);
        onDeleted();
      },
      onError: (err) => toast.error(err),
    });
  };

  const allSame = <T,>(pick: (t: TaskDTO) => T, value: T) => count > 0 && tasks.every((t) => pick(t) === value);
  // A selection can mix archived and live tasks (Show archived, a board including archived
  // tasks): Archive and Unarchive each act only on the tasks they change, so Undo restores
  // exactly the previous state.
  const targets = archiveTargets(tasks);
  const mixed = targets.archive.length > 0 && targets.unarchive.length > 0;
  const archiveItems: MenuItem[] = [];
  if (targets.archive.length > 0 || targets.unarchive.length === 0) {
    const n = pluralize(targets.archive.length, 'task');
    archiveItems.push({
      label: 'Archive',
      icon: <Archive />,
      hint: mixed ? String(targets.archive.length) : undefined,
      disabled,
      onSelect: () => apply({ archived: true }, `Archived ${n}`, { archived: false }, targets.archive),
    });
  }
  if (targets.unarchive.length > 0) {
    const n = pluralize(targets.unarchive.length, 'task');
    archiveItems.push({
      label: 'Unarchive',
      icon: <ArchiveRestore />,
      hint: mixed ? String(targets.unarchive.length) : undefined,
      disabled,
      onSelect: () => apply({ archived: false }, `Unarchived ${n}`, { archived: true }, targets.unarchive),
    });
  }

  const statusItems: MenuItem[] = lookups.statuses.map((s) => ({
    label: s.name,
    icon: <StatusIcon status={s} fraction={statusFraction(s, lookups.statuses)} label={null} />,
    checked: allSame((t) => t.statusId, s.id),
    onSelect: () => apply({ statusId: s.id }, `Moved ${noun} to ${s.name}`),
  }));

  const priorityItems: MenuItem[] = PRIORITY_ORDER.map((p) => ({
    label: PRIORITY_META[p].label,
    icon: <PriorityIcon priority={p} label={null} />,
    checked: allSame((t) => t.priority, p),
    onSelect: () => apply({ priority: p }, `Set priority of ${noun} to ${PRIORITY_META[p].label}`),
  }));

  const dueItems: MenuItem[] = [
    ...quickDates(today, lookups.settings.weekStartsOn).map((q) => ({
      label: q.label,
      hint: formatDate(q.date, today),
      checked: allSame((t) => t.dueDate, q.date),
      onSelect: () => apply({ dueDate: q.date }, `Due ${q.label.toLowerCase()}: ${noun}`),
    })),
    { separator: true },
    { label: 'Pick a date…', icon: <CalendarDays />, onSelect: () => setDialog('due') },
    { label: 'Clear due date', icon: <X />, onSelect: () => apply({ dueDate: null }, `Cleared the due date of ${noun}`) },
    { separator: true },
    {
      label: 'Rebaseline slipped…',
      icon: <CalendarSync />,
      disabled: disabled || !tasks.some((t) => t.slipDays > 0),
      onSelect: () => setDialog('rebaseline'),
    },
  ];

  const projectId = commonProjectId(tasks);
  const epicItem: MenuItem = (() => {
    if (projectId === null) {
      return { label: 'Set epic', icon: <Layers />, disabled: true, hint: count > 0 ? 'Several projects' : undefined };
    }
    const groups = groupEpicsByMilestone(lookups, [projectId]);
    const showHeadings = groups.some((g) => g.milestone !== null);
    const sub: MenuItem[] = [
      { label: 'No epic', icon: <CircleDashed />, checked: allSame((t) => t.epicId, null), onSelect: () => apply({ epicId: null }, `Removed the epic of ${noun}`) },
    ];
    for (const group of groups) {
      if (showHeadings) sub.push({ heading: epicGroupLabel(group, false) });
      for (const epic of group.epics) {
        sub.push({
          label: epic.name,
          icon: <EpicDot color={epic.color} />,
          checked: allSame((t) => t.epicId, epic.id),
          onSelect: () => apply({ epicId: epic.id }, `Moved ${noun} to ${epic.name}`),
        });
      }
    }
    if (groups.length === 0) sub.push({ label: 'This project has no epics', disabled: true });
    return { label: 'Set epic', icon: <Layers />, disabled, items: sub };
  })();

  const tagItems: MenuItem[] = [
    { label: 'Add tags…', icon: <Tag />, disabled, onSelect: () => setDialog('addTags') },
    { label: 'Remove tags…', icon: <Tags />, disabled: disabled || tasks.every((t) => t.tags.length === 0), onSelect: () => setDialog('removeTags') },
  ];

  const deleteItem: MenuItem = { label: 'Delete…', icon: <Trash2 />, danger: true, disabled, onSelect: () => void remove() };

  const dialogs = (
    <>
      <BulkDueDialog
        open={dialog === 'due'}
        onClose={() => setDialog(null)}
        count={count}
        onSave={(dueDate) => apply({ dueDate }, dueDate ? `Due ${formatDate(dueDate, today)}: ${noun}` : `Cleared the due date of ${noun}`)}
      />
      <RebaselineDialog
        open={dialog === 'rebaseline'}
        onClose={() => setDialog(null)}
        scope={{ ids: tasks.map((t) => t.id) }}
        scopeLabel={`the ${pluralize(count, 'selected task')}`}
      />
      <BulkTagsDialog
        mode="add"
        open={dialog === 'addTags'}
        onClose={() => setDialog(null)}
        tasks={tasks}
        onSave={(tagIds) => apply({ addTagIds: tagIds }, `Tagged ${noun}`)}
      />
      <BulkTagsDialog
        mode="remove"
        open={dialog === 'removeTags'}
        onClose={() => setDialog(null)}
        tasks={tasks}
        onSave={(tagIds) => apply({ removeTagIds: tagIds }, `Removed tags from ${noun}`)}
      />
    </>
  );

  return { busy, disabled, statusItems, priorityItems, dueItems, epicItem, tagItems, archiveItems, deleteItem, onMenuOpenChange, dialogs };
}

function BulkDueDialog({
  open,
  onClose,
  count,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  onSave: (date: ISODate | null) => void;
}) {
  const [date, setDate] = useState<ISODate | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Due date · ${pluralize(count, 'task')}`}
      size="sm"
      mobileLayout="sheet"
      onSubmit={() => {
        onSave(date);
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            {date ? 'Set date' : 'Clear date'}
          </Button>
        </>
      }
    >
      <DateField label="Due date" value={date} onChange={setDate} hint="Leave empty to clear the due date." />
    </Dialog>
  );
}

function BulkTagsDialog({
  mode,
  open,
  onClose,
  tasks,
  onSave,
}: {
  mode: 'add' | 'remove';
  open: boolean;
  onClose: () => void;
  tasks: readonly TaskDTO[];
  onSave: (tagIds: number[]) => void;
}) {
  const sheetMode = useSheetMode();
  const [ids, setIds] = useState<number[]>([]);
  const allOptions = useTagOptions();
  const present = useMemo(() => new Set(tasks.flatMap((t) => t.tags.map((g) => g.id))), [tasks]);
  const removeOptions = useMemo(() => allOptions.filter((o) => present.has(o.value)), [allOptions, present]);
  const close = () => {
    setIds([]);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${mode === 'add' ? 'Add tags to' : 'Remove tags from'} ${pluralize(tasks.length, 'task')}`}
      size="sm"
      closeOnOutsideClick={ids.length === 0}
      bodyClassName="flex flex-col"
      onSubmit={() => {
        if (ids.length > 0) onSave(ids);
        close();
      }}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant={mode === 'remove' ? 'danger' : 'primary'} disabled={ids.length === 0}>
            {mode === 'add' ? 'Add tags' : 'Remove tags'}
          </Button>
        </>
      }
    >
      <div className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface md:h-80 md:flex-none">
        {mode === 'add' ? (
          <TagPickerList value={ids} onChange={setIds} touch={sheetMode} />
        ) : (
          <PickerList<number>
            multiple
            label="Tags to remove"
            options={removeOptions}
            value={ids}
            onChange={setIds}
            searchable
            emptyText="No tags on these tasks"
            touch={sheetMode}
          />
        )}
      </div>
    </Dialog>
  );
}
