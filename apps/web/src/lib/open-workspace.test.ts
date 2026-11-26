import { isRedirect } from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The workspace layout's lookup: entering a workspace asks the server and remembers it as the one used
// last; navigations inside it ask nothing; preloads and old slugs remember nothing.

const server = vi.hoisted(() => ({
  resolveWorkspaceFn: vi.fn(),
  touchLastWorkspaceFn: vi.fn(async () => ({ ok: true, data: undefined })),
}));
vi.mock('../features/workspaces/server', () => server);

const opened = (slug: string, current = true) => ({
  ok: true,
  data: { workspace: { id: `id-${slug}`, name: slug, slug }, current, role: 'owner' },
});

async function load() {
  vi.resetModules();
  return import('./open-workspace');
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  server.resolveWorkspaceFn.mockReset();
  server.touchLastWorkspaceFn.mockClear();
  server.resolveWorkspaceFn.mockImplementation(async ({ data }: { data: { workspace: string } }) =>
    opened(data.workspace),
  );
});

describe('openWorkspace', () => {
  it('asks once on entering, then not while staying in the workspace', async () => {
    const { openWorkspace } = await load();
    await openWorkspace({ slug: 'acme', href: '/w/acme', cause: 'enter', preload: false });
    await openWorkspace({ slug: 'acme', href: '/w/acme/p/PAY', cause: 'stay', preload: false });
    expect(server.resolveWorkspaceFn).toHaveBeenCalledTimes(1);
    expect(server.touchLastWorkspaceFn).toHaveBeenCalledTimes(1);
    expect(server.touchLastWorkspaceFn).toHaveBeenCalledWith({ data: { workspace: 'acme' } });
  });

  it('asks again and remembers a move to another workspace, which the router calls a stay', async () => {
    const { openWorkspace } = await load();
    await openWorkspace({ slug: 'acme', href: '/w/acme', cause: 'enter', preload: false });
    const globex = await openWorkspace({ slug: 'globex', href: '/w/globex', cause: 'stay', preload: false });
    expect(globex.workspace.slug).toBe('globex');
    expect(server.resolveWorkspaceFn).toHaveBeenLastCalledWith({ data: { workspace: 'globex' } });
    expect(server.touchLastWorkspaceFn).toHaveBeenLastCalledWith({ data: { workspace: 'globex' } });
  });

  it('remembers nothing for a preload or an old slug', async () => {
    const { openWorkspace } = await load();
    await openWorkspace({ slug: 'globex', href: '/w/globex', cause: 'preload', preload: true });
    server.resolveWorkspaceFn.mockResolvedValueOnce(opened('acme', false));
    const moved = await openWorkspace({
      slug: 'old-acme',
      href: '/w/old-acme',
      cause: 'enter',
      preload: false,
    });
    expect(moved.workspace.slug).toBe('acme');
    expect(server.touchLastWorkspaceFn).not.toHaveBeenCalled();
  });

  it('reuses what the server rendered', async () => {
    const { openWorkspace, rememberOpenedWorkspace } = await load();
    rememberOpenedWorkspace(opened('acme').data as never);
    await openWorkspace({ slug: 'acme', href: '/w/acme/settings/members', cause: 'stay', preload: false });
    expect(server.resolveWorkspaceFn).not.toHaveBeenCalled();
  });

  it('sends people outside the workspace to / and signed-out people to sign in', async () => {
    const { openWorkspace } = await load();
    server.resolveWorkspaceFn.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_A_MEMBER', message: 'No', issues: [] },
    });
    const outside = await openWorkspace({
      slug: 'globex',
      href: '/w/globex',
      cause: 'enter',
      preload: false,
    }).catch((error: unknown) => error);
    expect(isRedirect(outside) && outside.options.to).toBe('/');
    server.resolveWorkspaceFn.mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Sign in', issues: [] },
    });
    const signedOut = await openWorkspace({
      slug: 'acme',
      href: '/w/acme/p/PAY',
      cause: 'enter',
      preload: false,
    }).catch((error: unknown) => error);
    expect(isRedirect(signedOut) && signedOut.options).toMatchObject({
      to: '/signin',
      search: { redirect: '/w/acme/p/PAY' },
    });
  });
});
