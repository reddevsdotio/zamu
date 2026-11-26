import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { testWorkspace } from '~/lib/testing';
import { WorkspaceProvider } from '~/lib/workspace';

// Test support for features/views (imported by its *.test.tsx only). Screens render inside the test
// workspace (viewsWorkspace), backed by the small in-memory API below, and a QueryClientProvider.
//
//   await renderWithQuery(<DisplayButton … />);

export const VIEWER = {
  id: '9f0c0a52-0000-4000-8000-000000000001',
  name: 'Ana Ruiz',
  kind: 'person' as const,
};

export const LABELS = [
  {
    id: '0b0d8c52-0000-4000-8000-000000000001',
    name: 'frontend',
    color: 4,
    source: 'app' as const,
    usageCount: 31,
  },
  {
    id: '0b0d8c52-0000-4000-8000-000000000002',
    name: 'backend',
    color: 3,
    source: 'app' as const,
    usageCount: 38,
  },
  {
    id: '0b0d8c52-0000-4000-8000-000000000003',
    name: 'mobile',
    color: 6,
    source: 'app' as const,
    usageCount: 27,
  },
  {
    id: '0b0d8c52-0000-4000-8000-000000000004',
    name: 'security',
    color: 1,
    source: 'app' as const,
    usageCount: 9,
  },
  {
    id: '0b0d8c52-0000-4000-8000-000000000005',
    name: 'i18n',
    color: 2,
    source: 'app' as const,
    usageCount: 12,
  },
];

export const MEMBERS = [
  { ...VIEWER, email: 'ana@example.com', role: 'owner', responsible: null },
  {
    id: '9f0c0a52-0000-4000-8000-000000000002',
    name: 'Tomás Ferreira',
    kind: 'person' as const,
    email: 'tomas@example.com',
    role: 'member',
    responsible: null,
  },
  {
    id: '9f0c0a52-0000-4000-8000-000000000003',
    name: 'claude-dev',
    kind: 'agent' as const,
    email: null,
    role: 'member',
    responsible: { id: VIEWER.id, name: VIEWER.name, kind: 'person' as const },
  },
];

/** The procedures the views read. */
export const fakeViewsClient = {
  me: {
    get: async () => ({
      user: { ...VIEWER, email: 'ana@example.com', responsible: null, theme: 'system' },
      role: 'owner',
    }),
  },
  members: { list: async () => ({ items: MEMBERS }) },
  labels: { list: async () => ({ items: LABELS }) },
  milestones: {
    list: async () => ({
      items: [
        {
          id: '2b2d8c52-0000-4000-8000-000000000001',
          name: 'Public beta',
          status: 'active',
          targetDate: null,
        },
      ],
    }),
  },
  cycles: {
    list: async () => ({
      items: [{ number: 12, name: null, state: 'current', startsOn: '2026-10-27', endsOn: '2026-11-09' }],
    }),
  },
};

/** The test workspace (/w/acme) with the in-memory API behind it. */
export const viewsWorkspace = testWorkspace(fakeViewsClient);

/** `ui` inside the test workspace. */
export function inWorkspace(ui: ReactElement): ReactElement {
  return <WorkspaceProvider workspace={viewsWorkspace}>{ui}</WorkspaceProvider>;
}

export function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
}

/** Renders with a fresh QueryClient that already knows the viewer (as the app shell prefetches me.get). */
export async function renderWithQuery(ui: ReactElement) {
  const queryClient = newQueryClient();
  const { meQuery } = await import('~/features/tasks/queries');
  await queryClient.prefetchQuery(meQuery(viewsWorkspace.api));
  const result = render(<QueryClientProvider client={queryClient}>{inWorkspace(ui)}</QueryClientProvider>);
  return { ...result, queryClient };
}
