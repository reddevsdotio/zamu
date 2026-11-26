import { createFileRoute } from '@tanstack/react-router';
import { getServerContext } from '../../../../server/context';
import { handleRepositoryWebhook, webhookMethodNotAllowed } from '../../../../server/webhooks';

// M7: pull and merge request webhooks, one URL per repository link. Not part of /api/v1: git hosts
// post here and get bare status codes (200, 202, 401, 404, 410). See server/webhooks.ts.

export const Route = createFileRoute('/api/webhooks/repository/$webhookId')({
  server: {
    handlers: {
      POST: ({ request, params }) => handleRepositoryWebhook(getServerContext(), request, params.webhookId),
      GET: webhookMethodNotAllowed,
      HEAD: webhookMethodNotAllowed,
      PUT: webhookMethodNotAllowed,
      PATCH: webhookMethodNotAllowed,
      DELETE: webhookMethodNotAllowed,
    },
  },
});
