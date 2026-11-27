import { MAX_PLAN_URL_LENGTH } from '@zamu/contracts';
import { type FormEvent, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Modal, TextField, useHotkeys } from '~/ui';
import { writeFailure } from './errors';
import { useUpdatePlanUrl } from './queries';

// The milestone's plan link (M8, design call 1): a web address or a file path in the repository, set
// from "+ Add a link to the plan" or Change in the page header. One field; Remove clears it. Enter or
// ⌘↵ saves, Esc cancels.

/** Why the text can't be a plan link, or null. One line, 1 to 2,000 characters. */
export function planUrlProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Write a web address or a file path';
  if (/[\r\n]/.test(trimmed)) return 'Keep it on one line';
  if (trimmed.length > MAX_PLAN_URL_LENGTH) {
    return `Keep it to ${MAX_PLAN_URL_LENGTH.toLocaleString('en-US')} characters or fewer`;
  }
  return null;
}

export interface PlanLinkDialogProps {
  milestoneId: string;
  /** The link as stored, or null when the milestone has none. */
  value: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function PlanLinkDialog({ isOpen, onClose, ...props }: PlanLinkDialogProps) {
  return (
    <Modal
      width={480}
      top={180}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <PlanLinkForm {...props} onClose={onClose} />
      </Dialog>
    </Modal>
  );
}

function PlanLinkForm({ milestoneId, value, onClose }: Omit<PlanLinkDialogProps, 'isOpen'>) {
  const [text, setText] = useState(value ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const update = useUpdatePlanUrl();
  const save = (planUrl: string | null) => {
    if (planUrl !== null) {
      const found = planUrlProblem(planUrl);
      if (found) {
        setProblem(found);
        return;
      }
    }
    setProblem(null);
    update.mutate(
      { id: milestoneId, planUrl: planUrl === null ? null : planUrl.trim() },
      {
        onSuccess: onClose,
        onError: (error) => setProblem(writeFailure(error, ['planUrl'], 'milestone').message),
      },
    );
  };
  useHotkeys({ 'Mod+Enter': () => save(text) }, { allowInOverlays: true });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save(text);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col">
      <DialogHeader title={value ? 'Change the plan link' : 'Link the plan'} />
      <DialogBody className="flex flex-col gap-2 pt-3">
        <TextField
          label="Web address or file path"
          description="A web address opens in a new tab. Anything else shows as a path in the repository."
          value={text}
          onChange={(next) => {
            setText(next);
            if (problem) setProblem(null);
          }}
          isInvalid={problem != null}
          errorMessage={problem ?? undefined}
          placeholder="plans/payouts-v2.html"
          maxLength={MAX_PLAN_URL_LENGTH}
          autoFocus
        />
      </DialogBody>
      <DialogFooter
        start={
          value ? (
            <Button variant="quiet" isDisabled={update.isPending} onPress={() => save(null)}>
              Remove the link
            </Button>
          ) : null
        }
      >
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button type="submit" kbd="⌘↵" isPending={update.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
