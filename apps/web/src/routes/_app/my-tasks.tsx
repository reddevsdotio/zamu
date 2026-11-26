import { createFileRoute } from '@tanstack/react-router';
import { redirectToLastWorkspace } from '~/lib/landing';

// Pre-0.10 URL: redirects to the same path under the workspace used last (kept until at least 1.0).
export const Route = createFileRoute('/_app/my-tasks')({
  beforeLoad: ({ location }) => redirectToLastWorkspace(location.href),
});
