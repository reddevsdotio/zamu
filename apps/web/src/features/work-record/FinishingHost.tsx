import { useQuery } from '@tanstack/react-query';
import { TASK_STATUS_LABELS, type TaskStatus } from '@zamu/contracts';
import { useEffect, useState } from 'react';
import {
  type FinishingRequest,
  registerFinishingHost,
  settleFinishing,
  useFinishingRequest,
} from '~/features/task-fields';
import { taskQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { Button, ConfirmBody, Dialog, DialogFooter, Modal, useHotkeys } from '~/ui';
import { FinishDialog } from './FinishDialog';
import { needsFinishing } from './ops';

// Draws the finishing warning that features/task-fields/finishing.ts asks for, wherever the status
// changed: the task view, the peek, a list or board row, the board's columns, the command palette.
// One task: FinishDialog with its open items, read from the full task. Several tasks: one confirm
// with the count. The app shell mounts it once.

export function FinishingHost() {
  useEffect(() => registerFinishingHost(), []);
  const pending = useFinishingRequest();
  if (!pending) return null;
  const { id, request } = pending;
  const answer = (move: boolean) => settleFinishing(id, move);
  return request.kind === 'task' ? (
    <TaskFinishing key={id} request={request} onAnswer={answer} />
  ) : (
    <ManyFinishing
      key={id}
      status={request.status}
      total={request.total}
      withOpenItems={request.withOpenItems}
      onAnswer={answer}
    />
  );
}

function TaskFinishing({
  request,
  onAnswer,
}: {
  request: Extract<FinishingRequest, { kind: 'task' }>;
  onAnswer: (move: boolean) => void;
}) {
  const api = useApi();
  const { data: task, isError } = useQuery(taskQuery(api, request.key));
  const settled = task != null && !needsFinishing(task, request.status);
  // Once the dialog is open it stays open: settling the last item in it must not move the task by
  // itself. The person reads "Every item is checked or waived" and presses Move.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (task != null && !settled) setShown(true);
  }, [task, settled]);
  // The row said items were open; the full task may know better (checked meanwhile). Then there is
  // nothing to ask, and the move goes through.
  const nothingToAsk = settled && !shown;
  useEffect(() => {
    if (nothingToAsk) onAnswer(true);
  }, [nothingToAsk, onAnswer]);

  if (isError && !task) {
    return (
      <ManyFinishing status={request.status} total={1} withOpenItems={[request.key]} onAnswer={onAnswer} />
    );
  }
  if (!task || nothingToAsk) return null;
  return (
    <FinishDialog
      task={task}
      status={request.status}
      onCancel={() => onAnswer(false)}
      onMove={() => onAnswer(true)}
    />
  );
}

/** "PAY-142", "PAY-142 and PAY-150", "PAY-142, PAY-150 and 4 more". */
export function keyList(keys: readonly string[], shown = 3): string {
  if (keys.length <= 1) return keys[0] ?? '';
  if (keys.length <= shown) return `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
  return `${keys.slice(0, shown - 1).join(', ')} and ${keys.length - shown + 1} more`;
}

/** The words of the confirm for several tasks, or for one whose items could not be read. */
export function manyFinishingText(
  status: TaskStatus,
  total: number,
  withOpenItems: readonly string[],
): { title: string; body: string } {
  const label = TASK_STATUS_LABELS[status];
  const count = withOpenItems.length;
  if (total === 1) {
    return {
      title: `${withOpenItems[0] ?? 'This task'} has open items`,
      body: `Some of its criteria or done items are not checked or waived. Move it to ${label} anyway, or cancel to keep its status.`,
    };
  }
  return {
    title: `${count} of ${total} tasks ${count === 1 ? 'has' : 'have'} open items`,
    body: `${keyList(withOpenItems)} ${count === 1 ? 'has' : 'have'} criteria or done items that are not checked or waived. Move all ${total} to ${label} anyway, or cancel to keep their status.`,
  };
}

function ManyFinishing({
  status,
  total,
  withOpenItems,
  onAnswer,
}: {
  status: TaskStatus;
  total: number;
  withOpenItems: readonly string[];
  onAnswer: (move: boolean) => void;
}) {
  const { title, body } = manyFinishingText(status, total, withOpenItems);
  return (
    <Modal
      width={440}
      top={200}
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) onAnswer(false);
      }}
    >
      <ManyFinishingContent title={title} body={body} onAnswer={onAnswer} />
    </Modal>
  );
}

function ManyFinishingContent({
  title,
  body,
  onAnswer,
}: {
  title: string;
  body: string;
  onAnswer: (move: boolean) => void;
}) {
  useHotkeys({ 'Mod+Enter': () => onAnswer(true) }, { allowInOverlays: true });
  return (
    <Dialog role="alertdialog">
      <ConfirmBody title={title}>{body}</ConfirmBody>
      <DialogFooter>
        <Button variant="secondary" onPress={() => onAnswer(false)} autoFocus>
          Cancel
        </Button>
        <Button kbd="⌘↵" aria-keyshortcuts="Meta+Enter" onPress={() => onAnswer(true)}>
          Move anyway
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
