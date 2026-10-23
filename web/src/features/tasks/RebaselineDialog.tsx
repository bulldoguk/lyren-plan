// Rebaseline (docs/design/task-dependencies.md): accept the slip of a project's tasks, or of a selection,
// by copying their adjusted dates over their own. The dialog previews every move (old → new start and due)
// before anything changes; each moved task logs its date change as a rebaseline.

import { localToday } from '@shared/dates';
import type { RebaselineInput } from '@shared/schemas';
import { useRebaseline, useRebaselinePreview } from '../../api/tasks';
import { Button, Dialog, toast } from '../../components/ui';
import { formatDate, pluralize } from '../../lib/format';

export interface RebaselineDialogProps {
  open: boolean;
  onClose: () => void;
  /** A project's slipped tasks, or the slipped tasks among a selection. */
  scope: { projectId: number } | { ids: number[] };
  /** What the scope is called in the text ("Website Relaunch", "the 4 selected tasks"). */
  scopeLabel: string;
}

export function RebaselineDialog({ open, onClose, scope, scopeLabel }: RebaselineDialogProps) {
  const today = localToday();
  const input: RebaselineInput = { ...scope, today };
  const preview = useRebaselinePreview(input, { enabled: open });
  const rebaseline = useRebaseline();
  const items = preview.data?.items ?? [];
  const dateText = (d: string | null) => (d === null ? '—' : formatDate(d, today));

  const apply = () =>
    rebaseline.mutate(input, {
      onSuccess: ({ items: moved }) => {
        toast.success(moved.length === 0 ? 'Nothing to rebaseline' : `Rebaselined ${pluralize(moved.length, 'task')}`);
        onClose();
      },
      onError: (err) => toast.error(err),
    });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rebaseline slipped tasks"
      description={`Move the slipped tasks of ${scopeLabel} to the dates their blockers allow. Start and due move together, so each task keeps its length.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={items.length === 0} loading={rebaseline.isPending} onClick={apply}>
            {items.length === 0 ? 'Rebaseline' : `Rebaseline ${pluralize(items.length, 'task')}`}
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <p className="text-sm text-fg-muted">Working out the new dates…</p>
      ) : preview.isError ? (
        <p className="text-sm text-danger">Could not work out the new dates.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing has slipped here.</p>
      ) : (
        <div className="max-h-[50dvh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Task</th>
                <th className="py-1 pr-2 font-medium">Start</th>
                <th className="py-1 pr-2 font-medium">Due</th>
                <th className="py-1 text-right font-medium">Slip</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr key={item.taskId}>
                  <td className="max-w-0 py-1.5 pr-2">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 whitespace-nowrap font-mono text-xs text-fg-muted">{item.ref}</span>
                      <span className="truncate">{item.title}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-fg-muted">
                    {item.from.startDate === item.to.startDate
                      ? dateText(item.from.startDate)
                      : `${dateText(item.from.startDate)} → ${dateText(item.to.startDate)}`}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2">
                    {dateText(item.from.dueDate)} → {dateText(item.to.dueDate)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-fg-muted">+{item.slipDays}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
