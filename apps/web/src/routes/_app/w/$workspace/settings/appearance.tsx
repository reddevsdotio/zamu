import { createFileRoute } from '@tanstack/react-router';
import { AppearancePage } from '~/features/theme/AppearancePage';

// Settings › Appearance: the theme choice, saved to the account. The signed-in layout already loads me.
export const Route = createFileRoute('/_app/w/$workspace/settings/appearance')({
  head: () => ({ meta: [{ title: 'Appearance · Settings' }] }),
  component: AppearancePage,
});
