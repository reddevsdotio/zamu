import { generateOperationKey } from '@orpc/tanstack-query';
import { type Query, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { Me, Theme } from '@zamu/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import { useApi } from '~/lib/workspace';
import { workspaceKeyPath } from '~/lib/workspace-api';
import { workspaceSlugFromPath } from '~/lib/workspace-paths';

// The signed-in person's theme. It lives on the account (GET /me user.theme, PATCH /me { theme }), and the
// page reads it from the cached me.get query: the signed-in layout prefetches that query, so it is in the
// cache when the server renders <html>, and the class is in the first HTML response (no flash on reload).
// Signed-out pages have no me in the cache and follow the system. The theme is the person's in every
// workspace, so a change updates the cached me of each one.

/** Class on <html>: "light" or "dark" forces that theme; none follows prefers-color-scheme. */
export function themeClass(theme: Theme | undefined): 'light' | 'dark' | undefined {
  return theme === 'light' || theme === 'dark' ? theme : undefined;
}

/** Content of <meta name="color-scheme">, so form controls and scrollbars match before CSS loads. */
export function colorSchemeFor(theme: Theme | undefined): 'light' | 'dark' | 'light dark' {
  return themeClass(theme) ?? 'light dark';
}

/** The key of a workspace's me.get query, as api.orpc.me.get.queryKey() builds it. */
function meKeyOf(workspace: string): readonly unknown[] {
  return generateOperationKey([...workspaceKeyPath(workspace), 'me', 'get'], { type: 'query' });
}

/** The workspace slug in the current URL, for <html> (the root renders outside the workspace layout). */
export function useUrlWorkspaceSlug(): string | undefined {
  return useRouterState({ select: (state) => workspaceSlugFromPath(state.location.pathname) });
}

/**
 * The signed-in person's theme from the cached me of `workspace`; undefined outside a workspace, when
 * signed out or not loaded yet. It only reads the cache and watches it: it registers no query, so it
 * never fetches /me itself (signed-out pages must not call it) and an invalidated me refetches with the
 * real request of the screens that load it.
 */
export function useUserTheme(workspace: string | undefined): Theme | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = () => (workspace ? queryClient.getQueryData<Me>(meKeyOf(workspace))?.user.theme : undefined);
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether a cached query is me.get of any workspace: ['w', slug, 'me', 'get']. */
function isMeQuery(query: Query): boolean {
  const [path] = query.queryKey;
  return Array.isArray(path) && path[0] === 'w' && path[2] === 'me' && path[3] === 'get';
}

function withTheme(me: Me, theme: Theme): Me {
  return { ...me, user: { ...me.user, theme } };
}

/**
 * Saves a theme choice. The page switches at once (the cached me changes before the request) and goes
 * back when the server refuses; `error` then explains why.
 */
export function useSetTheme() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.me.update.mutationKey(),
    mutationFn: (theme: Theme) => api.client.me.update({ theme }),
    onMutate: async (theme) => {
      await queryClient.cancelQueries({ predicate: isMeQuery });
      const previous = queryClient.getQueriesData<Me>({ predicate: isMeQuery });
      queryClient.setQueriesData<Me>({ predicate: isMeQuery }, (me) => (me ? withTheme(me, theme) : me));
      return { previous };
    },
    onError: (_error, _theme, context) => {
      for (const [queryKey, data] of context?.previous ?? []) queryClient.setQueryData(queryKey, data);
    },
    onSuccess: (me) => {
      // Each workspace's me names that workspace: only the theme carries over.
      queryClient.setQueriesData<Me>({ predicate: isMeQuery }, (cached) =>
        cached ? withTheme(cached, me.user.theme) : cached,
      );
    },
  });
}

// ---- System preference --------------------------------------------------------------------------

const DARK_QUERY = '(prefers-color-scheme: dark)';

// matchMedia is missing in some test environments; System then reads as unknown.
const media = () => (typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null);

function subscribeSystem(listener: () => void) {
  const query = media();
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

function systemSnapshot(): 'light' | 'dark' | null {
  const query = media();
  if (!query) return null;
  return query.matches ? 'dark' : 'light';
}

/** What System resolves to right now; null on the server and while hydrating. */
export function useSystemTheme(): 'light' | 'dark' | null {
  return useSyncExternalStore(subscribeSystem, systemSnapshot, () => null);
}
