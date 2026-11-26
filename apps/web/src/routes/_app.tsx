import { createFileRoute, Outlet } from '@tanstack/react-router';
import { requireSession } from '../lib/session';

// Signed-in pages: everything under routes/_app/ needs a session (else /signin, or /setup on first run).
// The workspace pages and their shell live under routes/_app/w/$workspace/; `/`, /welcome and the
// pre-0.10 paths sit beside them and redirect or stand alone.
type SessionContext = Awaited<ReturnType<typeof requireSession>>;

// Last session seen in the browser. Search-only changes on the same page (filters, the selected task)
// reuse it instead of asking the server again; entering a page always re-checks.
let lastBrowserSession: SessionContext | undefined;

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location, cause }) => {
    if (typeof window !== 'undefined' && cause === 'stay' && lastBrowserSession) return lastBrowserSession;
    const result = await requireSession({ location });
    if (typeof window !== 'undefined') lastBrowserSession = result;
    return result;
  },
  component: Outlet,
});
