import { createFileRoute } from '@tanstack/react-router';
import { GeneralSettings } from '~/features/workspaces/GeneralSettings';

// Settings › General: the workspace's name and address, Leave, and Delete for owners. The settings
// layout loads me (the role decides what shows).
export const Route = createFileRoute('/_app/w/$workspace/settings/general')({
  head: () => ({ meta: [{ title: 'General · Settings' }] }),
  component: GeneralSettings,
});
