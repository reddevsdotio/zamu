import { createFileRoute } from '@tanstack/react-router';
import { getServerContext } from '../../../../server/context';
import { handleBacklogWebhook, webhookMethodNotAllowed } from '../../../../server/webhooks';

// Push webhooks for Backlog.md mirrors, one URL per source. Not part of /api/v1: git hosts post here
// and get bare status codes (202, 204, 404, 410). M7: request events on this URL reach the
// project's repository link through core, so a mirror needs no second webhook. See server/webhooks.ts.

export const Route = createFileRoute('/api/webhooks/backlog/$webhookId')({
  server: {
    handlers: {
      POST: ({ request, params }) => handleBacklogWebhook(getServerContext(), request, params.webhookId),
      GET: webhookMethodNotAllowed,
      HEAD: webhookMethodNotAllowed,
      PUT: webhookMethodNotAllowed,
      PATCH: webhookMethodNotAllowed,
      DELETE: webhookMethodNotAllowed,
    },
  },
});
