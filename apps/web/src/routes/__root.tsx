/// <reference types="vite/client" />
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { colorSchemeFor, themeClass, useUrlWorkspaceSlug, useUserTheme } from '../features/theme/theme';
import { requireSetUp } from '../lib/session';
import type { RouterContext } from '../router';
import appCss from '../styles/app.css?url';
import { UIProvider } from '../ui/UIProvider';

export const Route = createRootRouteWithContext<RouterContext>()({
  // Sends every page to /setup until the first admin and workspace exist.
  beforeLoad: ({ location }) => requireSetUp({ location }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // color-scheme is rendered by RootDocument: it follows the signed-in person's theme.
      { title: 'Zamu' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <UIProvider>
        <Outlet />
      </UIProvider>
    </RootDocument>
  );
}

/**
 * The document. A signed-in person's Light or Dark choice puts that class on <html> (tokens.css honours
 * it over prefers-color-scheme); System and signed-out pages carry no class and follow the system. The
 * server renders the class from the prefetched me query, so a reload never flashes the other theme.
 */
function RootDocument({ children }: { children: ReactNode }) {
  const theme = useUserTheme(useUrlWorkspaceSlug());
  return (
    <html lang="en" className={themeClass(theme)}>
      <head>
        <HeadContent />
        <meta name="color-scheme" content={colorSchemeFor(theme)} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
