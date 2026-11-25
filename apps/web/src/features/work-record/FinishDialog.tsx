import { TASK_STATUS_LABELS, type Task, type TaskStatus, type WorkItemKind } from '@zamu/contracts';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checklist,
  type ChecklistHandle,
  type ChecklistItem,
  Dialog,
  DialogFooter,
  DialogTitle,
  Kbd,
  Modal,
  useHotkeys,
} from '~/ui';
import { openItemsOf } from './ops';
import { useItemActions } from './WorkItemSection';

// Finishing with open items (m6.css .dlg.fin, frames 019, 020): when a person moves a task to In review
// or Done while criteria or done items are open, the move waits for this dialog. It lists the items that
// were open, each with Waive; X checks the focused one in place, W waives it, ⌘↵ moves the task anyway
// and Esc cancels (the status stays). Agents never see it: the server refuses them with OPEN_ITEMS.
// FinishingHost opens it for every way of setting one task's status.

export interface FinishDialogProps {
  task: Task;
  /** In review or Done. */
  status: TaskStatus;
  onCancel: () => void;
  onMove: () => void;
}

type Line = ChecklistItem & { kind: WorkItemKind };

export function FinishDialog({ task, status, onCancel, onMove }: FinishDialogProps) {
  return (
    <Modal
      width={560}
      top={150}
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
    >
      <FinishContent task={task} status={status} onCancel={onCancel} onMove={onMove} />
    </Modal>
  );
}

function FinishContent({ task, status, onCancel, onMove }: FinishDialogProps) {
  // The items open when the dialog opened stay listed, so a check shows in place.
  const [shown] = useState(() => openItemsOf(task).map(({ kind, item }) => `${kind}:${item.number}`));
  const criteria = useItemActions(task, 'criterion');
  const done = useItemActions(task, 'done');
  const list = useRef<ChecklistHandle>(null);
  const label = TASK_STATUS_LABELS[status];

  const lines: Line[] = shown.flatMap((id) => {
    const [kind, number] = id.split(':') as [WorkItemKind, string];
    const item = (kind === 'criterion' ? task.criteria : task.doneItems)?.find(
      (other) => other.number === Number(number),
    );
    if (!item) return [];
    return [
      {
        ...item,
        id,
        kind,
        numbered: kind === 'criterion',
        ...(kind === 'done' ? { detail: 'Definition of done' } : {}),
      },
    ];
  });
  const open = lines.filter((line) => line.state === 'open').length;
  const actionsOf = (item: ChecklistItem) => ((item as Line).kind === 'criterion' ? criteria : done);

  useEffect(() => {
    const frame = requestAnimationFrame(() => list.current?.focusFirstOpen());
    return () => cancelAnimationFrame(frame);
  }, []);

  useHotkeys({ 'Mod+Enter': onMove }, { allowInOverlays: true });

  return (
    <Dialog>
      <div className="flex flex-col gap-2.5 px-4 pt-4.5 pb-3.5">
        <DialogTitle>
          {open === 0
            ? 'Every item is checked or waived'
            : open === 1
              ? '1 item is still open'
              : `${open} items are still open`}
        </DialogTitle>
        <p className="m-0 text-md leading-normal text-fg-2">
          {task.key} is moving to {label}. Check what is done, waive what no longer applies, or move it as it
          is.
        </p>
        <Checklist
          ref={list}
          aria-label="Open items"
          noun="criterion"
          actions="always"
          items={lines}
          onToggle={(item) => actionsOf(item).toggle(item)}
          onWaive={(item, reason) => actionsOf(item).waive(item, reason)}
          onUnwaive={(item) => actionsOf(item).unwaive(item)}
          className="bg-bg"
        />
      </div>
      <DialogFooter
        start={
          <span className="flex items-center gap-1.5 text-xs text-fg-3">
            <Kbd aria-hidden>X</Kbd>
            checks the focused item
          </span>
        }
      >
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
        <Button kbd="⌘↵" aria-keyshortcuts="Meta+Enter" onPress={onMove}>
          Move to {label}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
