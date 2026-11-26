import { createFileRoute } from '@tanstack/react-router';
import { redirectToLastWorkspace } from '~/lib/landing';

// "/" lands in the workspace used last (its Home), else in the oldest one the person belongs to, else on
// /welcome. Setup and sign-in guards run before this (routes/__root.tsx and routes/_app.tsx).
export const Route = createFileRoute('/_app/')({
  beforeLoad: ({ location }) => redirectToLastWorkspace(location.href),
});
