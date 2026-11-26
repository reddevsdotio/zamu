import { createFileRoute } from '@tanstack/react-router';
import { redirectToLastWorkspace } from '~/lib/landing';

// Pre-0.10 project and task URLs (/p/PAY, /p/PAY/PAY-12, /p/PAY/settings/labels, …): redirect to the
// same path under the workspace used last (kept until at least 1.0).
export const Route = createFileRoute('/_app/p/$')({
  beforeLoad: ({ location }) => redirectToLastWorkspace(location.href),
});
