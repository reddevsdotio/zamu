import { TASK_STATUS_LABELS, type TaskStatus } from '@zamu/contracts';
import { useEffect } from 'react';
import { Button, ConfirmBody, Dialog, DialogFooter, LockedWaveDialog, Modal, useModEnter } from '~/ui';
import { registerStartingHost, settleStarting, useStartingRequest } from './starting';

// Draws the start guard's question (starting.ts) wherever a person starts a task in a locked wave:
// the task view, the peek, a list row, the board, the palette. One task: the locked-wave warning of
// frame 114 (Cancel, Start anyway with ⌘↵). Several tasks: one confirm that says how many of them are
// in locked waves. The app shell mounts it once.

/** "PAY-174", "PAY-174 and PAY-175", "PAY-174, PAY-175 and 3 more". */
function keyList(keys: readonly string[], shown = 3): string {
  if (keys.length <= 1) return keys[0] ?? '';
  if (keys.length <= shown) return `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
  return `${keys.slice(0, shown - 1).join(', ')} and ${keys.length - shown + 1} more`;
}

/** The words of the confirm for several tasks. */
export function manyStartingText(
  status: TaskStatus,
  total: number,
  locked: readonly string[],
): { title: string; body: string } {
  const count = locked.length;
  const label = TASK_STATUS_LABELS[status];
  return {
    title: `${count} of ${total} tasks ${count === 1 ? 'is' : 'are'} in a locked wave`,
    body: `${keyList(locked)} ${count === 1 ? 'waits' : 'wait'} for an earlier gate to pass. Starting ${count === 1 ? 'it' : 'them'} now works ahead of the plan. Move all ${total} to ${label} anyway, or cancel to keep their status.`,
  };
}

export function StartGuardHost() {
  useEffect(() => registerStartingHost(), []);
  const pending = useStartingRequest();
  const answer = (start: boolean) => {
    if (pending) settleStarting(pending.id, start);
  };
  // ⌘↵ starts anyway wherever focus is in the dialog (Cancel has it first).
  useModEnter(pending != null, () => answer(true));
  if (!pending) return null;
  const { id, request } = pending;
  if (request.kind === 'task') {
    return (
      <LockedWaveDialog
        key={id}
        isOpen
        wave={`W${request.wave.number}`}
        waitsFor={
          request.waitsFor.name
            ? `W${request.waitsFor.number} · ${request.waitsFor.name}`
            : `W${request.waitsFor.number}`
        }
        taskKey={request.key}
        onCancel={() => answer(false)}
        onStart={() => answer(true)}
      />
    );
  }
  const { title, body } = manyStartingText(request.status, request.total, request.locked);
  return (
    <Modal
      key={id}
      width={460}
      top={200}
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) answer(false);
      }}
    >
      <ManyStartingContent title={title} body={body} onAnswer={answer} />
    </Modal>
  );
}

function ManyStartingContent({
  title,
  body,
  onAnswer,
}: {
  title: string;
  body: string;
  onAnswer: (start: boolean) => void;
}) {
  return (
    <Dialog role="alertdialog">
      <ConfirmBody title={title}>{body}</ConfirmBody>
      <DialogFooter
        start={<span className="text-xs text-fg-3">Agents can’t start tasks in a locked wave.</span>}
      >
        <Button variant="secondary" onPress={() => onAnswer(false)} autoFocus>
          Cancel
        </Button>
        <Button kbd="⌘↵" aria-keyshortcuts="Meta+Enter" onPress={() => onAnswer(true)}>
          Start anyway
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
