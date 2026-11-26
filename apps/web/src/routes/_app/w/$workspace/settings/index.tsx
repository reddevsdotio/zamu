import { createFileRoute, redirect } from '@tanstack/react-router';

// /w/<slug>/settings opens the first settings page, General.
export const Route = createFileRoute('/_app/w/$workspace/settings/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/w/$workspace/settings/general', params, replace: true });
  },
});
