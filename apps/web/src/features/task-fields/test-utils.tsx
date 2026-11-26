import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { taskQuery } from '~/features/tasks/queries';
import { type CurrentWorkspace, useApi, WorkspaceProvider } from '~/lib/workspace';
import { Button } from '~/ui';
import type { FieldPickerProps } from './StatusPicker';
import { TaskFieldToast } from './toast';

// Test helpers for the pickers: a query client, the providers, and a picker wired to a task read
// from the cache (so optimistic changes flow back in, as on a screen).

export function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

/** Renders `ui` in the test's workspace (testWorkspace from ~/lib/testing, around its fake client). */
export function renderWith(workspace: CurrentWorkspace, ui: ReactNode, queryClient = newQueryClient()) {
  const result = render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspace={workspace}>
        {ui}
        <TaskFieldToast />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

/** A picker for one task, opened by a button named "Open". */
export function WiredPicker({
  taskKey,
  Picker,
}: {
  taskKey: string;
  Picker: (props: FieldPickerProps) => ReactNode;
}) {
  const api = useApi();
  const task = useQuery(taskQuery(api, taskKey)).data;
  if (!task) return null;
  return <Picker targets={task} trigger={<Button>Open</Button>} />;
}
