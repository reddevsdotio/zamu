// "New secret" in the webhook dialog (PM-9): a confirm dialog, then a new webhook secret for the
// mirror. The URL stays; the old secret stops working at once. The new secret is shown once from
// component state, never kept in the mutation cache.

import { useQueryClient } from '@tanstack/react-query';
import type { BacklogWebhookSecret } from '@zamu/contracts';
import { useApi } from '~/lib/workspace';
import { ConfirmDialog } from '~/ui';
import { errorMessage, unwrap } from '../settings/result';
import { webhookInfoQuery } from './queries';

/** Issues a new secret, then refetches the webhook info so the dialog and its poll agree. */
export function useReissueWebhookSecret(projectKey: string): () => Promise<BacklogWebhookSecret> {
  const api = useApi();
  const queryClient = useQueryClient();
  return async () => {
    const { reissueBacklogWebhookSecretFn } = await import('../backlog/server');
    const issued = await unwrap(
      reissueBacklogWebhookSecretFn({ data: { workspace: api.slug, input: { projectKey } } }),
    );
    await queryClient.invalidateQueries({ queryKey: webhookInfoQuery(api, projectKey).queryKey });
    return issued;
  };
}

export interface WebhookSecretDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Issues the secret; the dialog shows the error when it rejects. */
  onIssue: () => Promise<BacklogWebhookSecret>;
  /** The new secret, after the dialog closes. */
  onIssued: (issued: BacklogWebhookSecret) => void;
}

export function WebhookSecretDialog({ isOpen, onOpenChange, onIssue, onIssued }: WebhookSecretDialogProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Issue a new webhook secret?"
      confirmLabel="Issue new secret"
      onConfirm={async () => {
        let issued: BacklogWebhookSecret;
        try {
          issued = await onIssue();
        } catch (failure) {
          // The kit dialog shows the error's message.
          throw new Error(errorMessage(failure));
        }
        onIssued(issued);
      }}
    >
      The current secret stops working at once. Webhooks fail until you paste the new secret into the git
      host. Mirrors still refresh every hour.
    </ConfirmDialog>
  );
}
