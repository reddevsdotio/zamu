import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import type { ProjectWithCounts } from '@zamu/contracts';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useRef } from 'react';
import { CommandPalette } from '~/features/palette/CommandPalette';
import { openPalette } from '~/features/palette/registry';
import { PeekHost } from '~/features/peek';
import { createRefusalText, isMirrored } from '~/features/project-header/mirror';
import { DeletedProjectToast } from '~/features/project-settings/DeleteProjectDialog';
import { NewProjectDialogHost } from '~/features/projects/NewProjectDialogHost';
import { meQuery, projectsQuery } from '~/features/projects/queries';
import { TaskFieldToast } from '~/features/task-fields';
import { rememberView } from '~/features/tasks/list-memory';
import { QuickCreateDialog } from '~/features/tasks/QuickCreateDialog';
import { ThemeErrorToast, useThemeChoice } from '~/features/theme/ThemeChoice';
import { useSystemTheme } from '~/features/theme/theme';
import { FinishingHost } from '~/features/work-record/FinishingHost';
import { useSignOut } from '~/lib/auth-client';
import { AppFrame, Sidebar, type SidebarProject } from '~/ui';
import { homeCountLabel, useHomeCount, useRefreshCountsAfterEdits } from './home-count';
import { useGoToHotkeys, useShellHotkeys } from './hotkeys';
import { NewProjectMenu, PersonMenu, WorkspaceMenu } from './menus';
import { NewProjectProvider, useNewProject } from './new-project';
import { PageSearchProvider } from './page-search';
import {
  HOME_HREF,
  MEMBERS_HREF,
  MY_KEYS_HREF,
  type ProjectPage,
  projectHref,
  projectKeyFromPath,
  projectPageFromLocation,
  projectPageHref,
  SETTINGS_HREF,
} from './paths';
import { QuickCreateProvider, useQuickCreate } from './quick-create';
import { useRememberOpenedTask } from './remember-task';
import { pageLabel, projectPages, suggestedCommandIds, useShellCommands } from './shell-commands';
import { ShortcutsProvider, useShortcuts } from './shortcuts';
import { SidebarStateProvider, useSidebarState } from './sidebar-state';
import { personMenuSubtitle } from './user-menu';

// The Backlog.md dialog pulls server functions in; load it when it first opens.
const NewFromBacklogDialogHost = lazy(() =>
  import('~/features/backlog-setup/NewFromBacklogDialogHost').then((module) => ({
    default: module.NewFromBacklogDialogHost,
  })),
);

export interface AppShellProps {
  /** The signed-in person, from the session (shown until me.get answers). */
  user: { id?: string; name: string };
  children: ReactNode;
}

/**
 * Signed-in shell (M5, frames 003–010): the sidebar, the ⌘K palette, the global keys of shortcuts.md
 * (⌘K, C, /, G then H P L B M Y, [, ?) and the dialogs they open (quick create, New project, New from
 * Backlog.md, the shortcut list). Pages render inside the content area. Quick create refuses projects
 * whose tasks come from Backlog.md, with the New button's tooltip text.
 */
export function AppShell({ user, children }: AppShellProps) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery());
  const userId = me.data?.user.id ?? user.id;
  const refuse = useCallback(
    (projectKey: string) => {
      const project = queryClient
        .getQueryData(projectsQuery().queryKey)
        ?.items.find((item) => item.key === projectKey);
      return project && isMirrored(project) ? createRefusalText(project.name) : null;
    },
    [queryClient],
  );
  return (
    <QuickCreateProvider refuse={refuse}>
      <NewProjectProvider>
        <PageSearchProvider>
          <ShortcutsProvider>
            <SidebarStateProvider userId={userId}>
              <ShellFrame user={user} userId={userId}>
                {children}
              </ShellFrame>
              <QuickCreateDialog />
              <TaskFieldToast />
              <PeekHost />
              <FinishingHost />
              <NewProjectDialogHost />
              <FromBacklogHost />
            </SidebarStateProvider>
          </ShortcutsProvider>
        </PageSearchProvider>
      </NewProjectProvider>
    </QuickCreateProvider>
  );
}

function FromBacklogHost() {
  const { isFromBacklogOpen, closeFromBacklog } = useNewProject();
  if (!isFromBacklogOpen) return null;
  return (
    <Suspense fallback={null}>
      <NewFromBacklogDialogHost isOpen onClose={closeFromBacklog} />
    </Suspense>
  );
}

/** Sidebar order: by name, so projects stay where people expect them as activity changes. */
function byName(projects: readonly ProjectWithCounts[]): ProjectWithCounts[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function ShellFrame({ user, userId, children }: AppShellProps & { userId: string | undefined }) {
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const router = useRouter();
  const navigate = useCallback((href: string) => void router.navigate({ href }), [router]);
  const currentKey = projectKeyFromPath(pathname);
  const currentPage = projectPageFromLocation(pathname, location.search as { view?: unknown });
  const me = useQuery(meQuery());
  const projectsData = useQuery(projectsQuery()).data?.items;
  const projects = useMemo(() => byName(projectsData ?? []), [projectsData]);
  const signOut = useSignOut();
  const theme = useThemeChoice();
  const system = useSystemTheme();
  const sidebar = useSidebarState();
  const shortcuts = useShortcuts();
  const quickCreate = useQuickCreate();
  const newProject = useNewProject();
  const onHome = pathname === HOME_HREF;

  // The last project visited: G then L, B, M, Y use it outside a project.
  const lastProject = useRef<string | undefined>(currentKey);
  if (currentKey) lastProject.current = currentKey;

  const goToPage = useCallback(
    (page: ProjectPage) => {
      const key = currentKey ?? lastProject.current;
      if (!key) return;
      if (page === 'list' || page === 'board') rememberView(key, page);
      navigate(projectPageHref(key, page));
    },
    [currentKey, navigate],
  );

  // Home spans every project: C there starts with the project picker instead of a guess.
  useShellHotkeys(currentKey, onHome ? { pickProject: true } : undefined);
  useGoToHotkeys({
    h: () => navigate(HOME_HREF),
    p: () => openPalette({ kind: 'projects' }),
    l: () => goToPage('list'),
    b: () => goToPage('board'),
    m: () => goToPage('milestones'),
    y: () => goToPage('cycles'),
  });
  const homeCount = useHomeCount();
  useRefreshCountsAfterEdits();
  useRememberOpenedTask(userId, pathname);

  const resolvedTheme = theme.value === 'system' ? (system ?? 'light') : theme.value;
  useShellCommands({
    projects,
    currentProjectKey: currentKey,
    theme: theme.value,
    resolvedTheme,
    sidebarCollapsed: sidebar.collapsed,
    navigate: (href) => {
      // The palette's List and Board pages pin the choice, like the sidebar links.
      const match = /^\/p\/([^/?]+)(\?view=board)?$/.exec(href);
      if (match?.[1]) rememberView(decodeURIComponent(match[1]), match[2] ? 'board' : 'list');
      navigate(href);
    },
    createTask: (title) =>
      quickCreate.open(currentKey, {
        ...(onHome ? { pickProject: true } : {}),
        ...(title ? { title } : {}),
      }),
    createProject: newProject.open,
    createFromBacklog: newProject.openFromBacklog,
    setTheme: theme.change,
    toggleSidebar: sidebar.toggle,
    openShortcuts: shortcuts.open,
  });

  const workspaceName = me.data?.workspace.name ?? 'Workspace';
  const sidebarProjects: SidebarProject[] = projects.map((project) => {
    const isCurrent = project.key === currentKey;
    return {
      key: project.key,
      name: project.name,
      openCount: project.openCount,
      href: projectHref(project.key),
      isCurrent,
      isExpanded: isCurrent,
      mirrored: isMirrored(project),
      pages: projectPages(project).map((page) => ({
        id: page,
        label: pageLabel(page),
        href: projectPageHref(project.key, page),
        isCurrent: isCurrent && currentPage === page,
        ...(page === 'list' || page === 'board' ? { onPress: () => rememberView(project.key, page) } : {}),
      })),
    };
  });

  return (
    <AppFrame
      rail={
        <Sidebar
          collapsed={sidebar.collapsed}
          workspace={
            <WorkspaceMenu
              name={workspaceName}
              settingsHref={SETTINGS_HREF}
              inviteHref={MEMBERS_HREF}
              onNewProject={newProject.open}
              onNewFromBacklog={newProject.openFromBacklog}
            />
          }
          onSearch={() => openPalette()}
          home={{ href: HOME_HREF, isCurrent: onHome, count: homeCount, countLabel: homeCountLabel }}
          projects={sidebarProjects}
          projectsAction={
            <NewProjectMenu onNewProject={newProject.open} onNewFromBacklog={newProject.openFromBacklog} />
          }
          settings={{ href: SETTINGS_HREF, isCurrent: pathname.startsWith('/settings') }}
          person={
            <PersonMenu
              user={{
                name: me.data?.user.name ?? user.name,
                email: me.data?.user.email,
                kind: me.data?.user.kind === 'agent' ? 'agent' : 'person',
              }}
              subtitle={me.data ? personMenuSubtitle(me.data) : undefined}
              theme={theme.value}
              onThemeChange={theme.change}
              myKeysHref={MY_KEYS_HREF}
              onShortcuts={shortcuts.open}
              onSignOut={() => void signOut()}
            />
          }
        />
      }
    >
      {children}
      <CommandPalette userId={userId} suggested={suggestedCommandIds(projects, currentKey)} />
      <ThemeErrorToast error={theme.error} onDismiss={theme.dismissError} />
      <DeletedProjectToast />
    </AppFrame>
  );
}
