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
import { rememberProjectView } from '~/features/tasks/list-memory';
import { QuickCreateDialog } from '~/features/tasks/QuickCreateDialog';
import { ThemeErrorToast, useThemeChoice } from '~/features/theme/ThemeChoice';
import { useSystemTheme } from '~/features/theme/theme';
import { ArchiveKeys } from '~/features/views/archive';
import { FinishingHost } from '~/features/work-record/FinishingHost';
import { NewWorkspaceDialogHost } from '~/features/workspaces/NewWorkspaceHost';
import { WorkspaceNoticeToast } from '~/features/workspaces/notice';
import { generalSettingsHref } from '~/features/workspaces/paths';
import { myWorkspacesQuery } from '~/features/workspaces/queries';
import { useSignOut } from '~/lib/auth-client';
import { useApi, useWorkspace, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import { asWorkspaceSlug, workspacePath } from '~/lib/workspace-paths';
import { AppFrame, Sidebar, type SidebarProject } from '~/ui';
import { homeCountLabel, useHomeCount, useRefreshCountsAfterEdits } from './home-count';
import { useGoToHotkeys, useShellHotkeys } from './hotkeys';
import { NewProjectMenu, PersonMenu, WorkspaceMenu } from './menus';
import { NewProjectProvider, useNewProject } from './new-project';
import { PageSearchProvider } from './page-search';
import {
  homeHref,
  isHomePath,
  isSettingsPath,
  membersHref,
  myKeysHref,
  type ProjectPage,
  projectHref,
  projectKeyFromPath,
  projectPageFromLocation,
  projectPageHref,
  projectViewOfHref,
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
 * whose tasks come from Backlog.md, with the New button's tooltip text. M7: Shift+E archives the
 * selection of whichever list, board or Home is mounted (ArchiveKeys).
 */
export function AppShell({ user, children }: AppShellProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery(api));
  const userId = me.data?.user.id ?? user.id;
  const refuse = useCallback(
    (projectKey: string) => {
      const project = queryClient
        .getQueryData(projectsQuery(api).queryKey)
        ?.items.find((item) => item.key === projectKey);
      return project && isMirrored(project) ? createRefusalText(project.name) : null;
    },
    [queryClient, api],
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
              <ArchiveKeys />
              <FinishingHost />
              <NewProjectDialogHost />
              <FromBacklogHost />
              <NewWorkspaceDialogHost />
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
  const api = useApi();
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const router = useRouter();
  const navigate = useCallback((href: string) => void router.navigate({ href }), [router]);
  const currentKey = projectKeyFromPath(pathname);
  const currentPage = projectPageFromLocation(pathname, location.search as { view?: unknown });
  const me = useQuery(meQuery(api));
  const projectsData = useQuery(projectsQuery(api)).data?.items;
  const projects = useMemo(() => byName(projectsData ?? []), [projectsData]);
  const signOut = useSignOut();
  const theme = useThemeChoice();
  const system = useSystemTheme();
  const sidebar = useSidebarState();
  const shortcuts = useShortcuts();
  const quickCreate = useQuickCreate();
  const newProject = useNewProject();
  const workspace = useWorkspaceSlug();
  const workspaceId = useWorkspaceId();
  const onHome = isHomePath(pathname);

  // The last project visited: G then L, B, M, Y use it outside a project.
  const lastProject = useRef<string | undefined>(currentKey);
  if (currentKey) lastProject.current = currentKey;

  const goToPage = useCallback(
    (page: ProjectPage) => {
      const key = currentKey ?? lastProject.current;
      if (!key) return;
      if (page === 'list' || page === 'board') rememberProjectView(workspaceId, key, page);
      navigate(projectPageHref(workspace, key, page));
    },
    [currentKey, navigate, workspace, workspaceId],
  );

  // Home spans every project: C there starts with the project picker instead of a guess.
  useShellHotkeys(currentKey, onHome ? { pickProject: true } : undefined);
  useGoToHotkeys({
    h: () => navigate(homeHref(workspace)),
    p: () => openPalette({ kind: 'projects' }),
    l: () => goToPage('list'),
    b: () => goToPage('board'),
    m: () => goToPage('milestones'),
    y: () => goToPage('cycles'),
  });
  const homeCount = useHomeCount();
  useRefreshCountsAfterEdits();
  // Recent tasks are kept per workspace: PAY-1 in one is not PAY-1 in another.
  const current = useWorkspace();
  // The switcher and the palette list every workspace of the person; until the list answers, the
  // switcher shows this one alone.
  const mine = useQuery(myWorkspacesQuery()).data;
  const otherWorkspaces = useMemo(
    () => (mine?.items ?? []).filter((item) => item.id !== workspaceId),
    [mine, workspaceId],
  );
  const canCreateWorkspace = mine?.canCreate ?? false;
  const generalHref = generalSettingsHref(workspace);
  const recentScope = userId ? `${userId}:${workspaceId}` : undefined;
  useRememberOpenedTask(recentScope, pathname);

  const resolvedTheme = theme.value === 'system' ? (system ?? 'light') : theme.value;
  useShellCommands({
    workspace,
    projects,
    currentProjectKey: currentKey,
    theme: theme.value,
    resolvedTheme,
    sidebarCollapsed: sidebar.collapsed,
    navigate: (href) => {
      // The palette's List and Board pages pin the choice, like the sidebar links.
      const view = projectViewOfHref(href);
      if (view) rememberProjectView(workspaceId, view.projectKey, view.view);
      navigate(href);
    },
    createTask: (title) =>
      quickCreate.open(currentKey, {
        ...(onHome ? { pickProject: true } : {}),
        ...(title ? { title } : {}),
      }),
    createProject: newProject.open,
    createFromBacklog: newProject.openFromBacklog,
    otherWorkspaces,
    canCreateWorkspace,
    createWorkspace: newProject.openWorkspace,
    setTheme: theme.change,
    toggleSidebar: sidebar.toggle,
    openShortcuts: shortcuts.open,
  });

  // me answers after a rename; the route context holds the name the page was entered with.
  const workspaceName = me.data?.workspace.name ?? current.name;
  const sidebarProjects: SidebarProject[] = projects.map((project) => {
    const isCurrent = project.key === currentKey;
    return {
      key: project.key,
      name: project.name,
      openCount: project.openCount,
      href: projectHref(workspace, project.key),
      isCurrent,
      isExpanded: isCurrent,
      mirrored: isMirrored(project),
      pages: projectPages(project).map((page) => ({
        id: page,
        label: pageLabel(page),
        href: projectPageHref(workspace, project.key, page),
        isCurrent: isCurrent && currentPage === page,
        ...(page === 'list' || page === 'board'
          ? { onPress: () => rememberProjectView(workspaceId, project.key, page) }
          : {}),
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
              current={{ id: workspaceId, name: workspaceName, slug: workspace }}
              workspaces={mine?.items}
              canCreate={canCreateWorkspace}
              workspaceHref={(slug) => workspacePath(asWorkspaceSlug(slug))}
              settingsHref={generalHref}
              inviteHref={membersHref(workspace)}
              onNewWorkspace={newProject.openWorkspace}
              onNewProject={newProject.open}
              onNewFromBacklog={newProject.openFromBacklog}
            />
          }
          onSearch={() => openPalette()}
          home={{
            href: homeHref(workspace),
            isCurrent: onHome,
            count: homeCount,
            countLabel: homeCountLabel,
          }}
          projects={sidebarProjects}
          projectsAction={
            <NewProjectMenu onNewProject={newProject.open} onNewFromBacklog={newProject.openFromBacklog} />
          }
          settings={{ href: generalHref, isCurrent: isSettingsPath(pathname) }}
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
              myKeysHref={myKeysHref(workspace)}
              onShortcuts={shortcuts.open}
              onSignOut={() => void signOut()}
            />
          }
        />
      }
    >
      {children}
      <CommandPalette userId={recentScope} suggested={suggestedCommandIds(projects, currentKey)} />
      <ThemeErrorToast error={theme.error} onDismiss={theme.dismissError} />
      <DeletedProjectToast />
      <WorkspaceNoticeToast />
    </AppFrame>
  );
}
