import { createFileRoute } from '@tanstack/react-router';
import { redirectToLastWorkspace } from '~/lib/landing';

// Pre-0.10 /settings: redirects to the workspace used last's settings (kept until at least 1.0).
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: ({ location }) => redirectToLastWorkspace(location.href),
});
