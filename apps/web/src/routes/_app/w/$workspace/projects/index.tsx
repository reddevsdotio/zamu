import { createFileRoute, redirect } from '@tanstack/react-router';

// The projects page is gone in M5: the sidebar lists the projects, and New project lives in its "+",
// the workspace menu and the palette. Old links land on Home.
export const Route = createFileRoute('/_app/w/$workspace/projects/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/w/$workspace', params, replace: true });
  },
});
