// Test support (imported by *.test.ts(x) only): a workspace around a fake /api/v1 client, so screens
// render with useApi() and query keys under ['w', 'acme'] as they do under /w/acme/.
//
//   const workspace = testWorkspace(fake.client);
//   render(<WorkspaceProvider workspace={workspace}>…</WorkspaceProvider>);
//   queryClient.setQueryData(taskQuery(workspace.api, 'PAY-1').queryKey, task);
//   renderInWorkspace(<SourceStep … />);   // screens that only need the slug for their links
import { type RenderOptions, render } from '@testing-library/react';
import { acmeWorkspaceFixture } from '@zamu/contracts/testing/fixtures';
import type { ReactElement } from 'react';
import { type CurrentWorkspace, WorkspaceProvider } from './workspace';
import { type ApiClient, workspaceApiOf } from './workspace-api';
import { asWorkspaceSlug } from './workspace-paths';

export const TEST_WORKSPACE = {
  id: acmeWorkspaceFixture.id,
  name: acmeWorkspaceFixture.name,
  slug: asWorkspaceSlug(acmeWorkspaceFixture.slug),
};

/** The test workspace (Acme, /w/acme) with `client` behind its query helpers. */
export function testWorkspace(client: unknown, ref = TEST_WORKSPACE): CurrentWorkspace {
  return { ...ref, api: workspaceApiOf(ref.slug, client as ApiClient) };
}

/**
 * A client that forwards every call to `target()` at call time, so a test can swap its fake between
 * tests while modules keep the same client.
 */
export function forwardingClient(target: () => unknown): ApiClient {
  const forward = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => (typeof key === 'string' ? forward([...path, key]) : undefined),
      apply: (_target, _this, args) => {
        // biome-ignore lint/suspicious/noExplicitAny: walking the fake client by path
        const fn = path.reduce<any>((node, key) => node[key], target());
        return fn(...args);
      },
    });
  return forward([]) as ApiClient;
}

/** Testing Library's render inside a workspace (by default one with no API behind it). */
export function renderInWorkspace(
  ui: ReactElement,
  options: RenderOptions & { workspace?: CurrentWorkspace } = {},
) {
  const { workspace = testWorkspace({}), ...rest } = options;
  return render(<WorkspaceProvider workspace={workspace}>{ui}</WorkspaceProvider>, rest);
}
