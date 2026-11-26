import type { ProjectWithCounts, Theme, WorkspaceRef } from '@zamu/contracts';
import { useMemo, useRef } from 'react';
import { ARCHIVED_COMMAND_PREFIX, PROJECT_COMMAND_PREFIX } from '~/features/palette/CommandPalette';
import { type Command, openPalette, useRegisterCommands } from '~/features/palette/registry';
import { generalSettingsHref } from '~/features/workspaces/paths';
import { WorkspaceTile } from '~/features/workspaces/WorkspaceTile';
import { asWorkspaceSlug, type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import { ArchiveGlyph, GearGlyph, PlusGlyph, ProjectTile, SidebarGlyph } from '~/ui';
import {
  archivedTasksHref,
  homeHref,
  myKeysHref,
  type ProjectPage,
  projectHref,
  projectPageHref,
} from './paths';

// The palette's built-in commands: pages, projects and their pages, the person's other workspaces,
// create (tasks, projects, workspaces), theme, sidebar, shortcuts, and (M7, frame 086) "Show archived
// tasks in <project>" for the project on screen.

export interface ShellCommandsInput {
  /** The workspace's slug: every page the commands open is under /w/<slug>/. */
  workspace: WorkspaceUrlSlug;
  projects: readonly ProjectWithCounts[];
  currentProjectKey: string | undefined;
  /** The saved theme and what it shows right now (System resolves to light or dark). */
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  navigate: (href: string) => void;
  /** Quick create; `title` prefills it (the palette's "Create task “offline”"). */
  createTask: (title?: string) => void;
  createProject: () => void;
  createFromBacklog: () => void;
  /** The person's workspaces besides this one: "Switch to Globex" for each. */
  otherWorkspaces?: readonly WorkspaceRef[];
  /** The creation policy lets the person create a workspace: "New workspace" is listed. */
  canCreateWorkspace?: boolean;
  createWorkspace?: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  openShortcuts: () => void;
}

const PAGE_LABELS: Record<ProjectPage, string> = {
  list: 'List',
  board: 'Board',
  milestones: 'Milestones',
  cycles: 'Cycles',
  settings: 'Settings',
};

const PAGE_SHORTCUTS: Partial<Record<ProjectPage, string>> = {
  list: 'g l',
  board: 'g b',
  milestones: 'g m',
  cycles: 'g y',
};

/** The pages a project shows in the sidebar and the palette: Milestones and Cycles only when it uses them. */
export function projectPages(
  project: Pick<ProjectWithCounts, 'usesMilestones' | 'usesCycles'>,
): ProjectPage[] {
  const pages: ProjectPage[] = ['list', 'board'];
  if (project.usesMilestones) pages.push('milestones');
  if (project.usesCycles) pages.push('cycles');
  pages.push('settings');
  return pages;
}

export function pageLabel(page: ProjectPage): string {
  return PAGE_LABELS[page];
}

function Arrow() {
  return <span className="text-sm leading-none">→</span>;
}

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Id prefix of the "Switch to <workspace>" commands. */
export const WORKSPACE_COMMAND_PREFIX = 'navigate.workspace.';

export function buildShellCommands(input: ShellCommandsInput): Command[] {
  const { workspace, projects, currentProjectKey, navigate } = input;
  const newWorkspace: Command = {
    id: 'create.workspace',
    title: 'New workspace',
    section: 'create',
    keywords: ['create', 'add', 'organization', 'team'],
    icon: <PlusGlyph />,
    run: () => {
      input.createWorkspace?.();
    },
  };
  const commands: Command[] = [
    {
      id: 'create.task',
      title: 'Create task',
      section: 'create',
      keywords: ['new', 'add', 'issue'],
      shortcut: 'c',
      icon: <PlusGlyph />,
      run: () => {
        input.createTask();
      },
      withText: {
        title: (text) => `Create task “${text}”`,
        run: (text) => input.createTask(text),
      },
    },
    {
      id: 'create.project',
      title: 'Create project',
      section: 'create',
      keywords: ['new', 'add'],
      icon: <PlusGlyph />,
      run: () => {
        input.createProject();
      },
    },
    {
      id: 'create.project-from-backlog',
      title: 'New project from Backlog.md',
      section: 'create',
      keywords: ['create', 'mirror', 'import', 'repository'],
      icon: <PlusGlyph />,
      run: () => {
        input.createFromBacklog();
      },
    },
    ...(input.canCreateWorkspace && input.createWorkspace ? [newWorkspace] : []),
    {
      id: 'navigate.home',
      title: 'Go to Home',
      section: 'navigate',
      keywords: ['dashboard', 'inbox', 'my tasks'],
      shortcut: 'g h',
      icon: <Arrow />,
      run: () => {
        navigate(homeHref(workspace));
      },
    },
    {
      id: 'navigate.projects',
      title: 'Jump to a project',
      section: 'navigate',
      keywords: ['projects', 'switch'],
      shortcut: 'g p',
      icon: <Arrow />,
      run: () => {
        // Reopen in project mode once this closes the palette.
        queueMicrotask(() => openPalette({ kind: 'projects' }));
      },
    },
  ];
  for (const project of projects) {
    commands.push({
      id: `${PROJECT_COMMAND_PREFIX}${project.key}`,
      title: `Go to ${project.name}`,
      section: 'navigate',
      keywords: [project.key, project.name],
      hint: 'Project',
      icon: <ProjectTile projectKey={project.key} name={project.name} />,
      run: () => {
        navigate(projectHref(workspace, project.key));
      },
    });
  }
  for (const project of projects) {
    const isCurrent = project.key === currentProjectKey;
    for (const page of projectPages(project)) {
      commands.push({
        id: `navigate.page.${project.key}.${page}`,
        title: `${project.name}: ${PAGE_LABELS[page]}`,
        section: 'navigate',
        keywords: [project.key, 'go to', 'open'],
        ...(isCurrent && PAGE_SHORTCUTS[page] ? { shortcut: PAGE_SHORTCUTS[page] } : {}),
        icon: <ProjectTile projectKey={project.key} name={project.name} />,
        run: () => {
          navigate(projectPageHref(workspace, project.key, page));
        },
      });
    }
  }
  const current = projects.find((project) => project.key === currentProjectKey);
  if (current) {
    commands.push({
      id: `${ARCHIVED_COMMAND_PREFIX}${current.key}`,
      title: `Show archived tasks in ${current.name}`,
      section: 'navigate',
      keywords: ['archive', 'archived', 'restore', current.key],
      icon: <ArchiveGlyph />,
      run: () => {
        navigate(archivedTasksHref(workspace, current.key));
      },
    });
  }
  for (const other of input.otherWorkspaces ?? []) {
    commands.push({
      id: `${WORKSPACE_COMMAND_PREFIX}${other.slug}`,
      title: `Switch to ${other.name}`,
      section: 'navigate',
      keywords: ['workspace', other.slug],
      hint: 'Workspace',
      icon: <WorkspaceTile name={other.name} slug={other.slug} size={18} />,
      run: () => {
        navigate(workspacePath(asWorkspaceSlug(other.slug)));
      },
    });
  }
  commands.push(
    {
      id: 'navigate.settings',
      title: 'Go to workspace settings',
      section: 'navigate',
      keywords: ['general', 'rename', 'members', 'people', 'invite', 'connections', 'leave', 'delete'],
      icon: <GearGlyph className="size-3.5" />,
      run: () => {
        navigate(generalSettingsHref(workspace));
      },
    },
    {
      id: 'navigate.my-keys',
      title: 'Go to My API keys',
      section: 'navigate',
      keywords: ['token', 'cli'],
      icon: <Arrow />,
      run: () => {
        navigate(myKeysHref(workspace));
      },
    },
    {
      id: 'app.theme-toggle',
      title: input.resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      section: 'app',
      keywords: ['theme', 'appearance', 'mode'],
      icon: <span className="text-sm leading-none">◐</span>,
      run: () => {
        input.setTheme(input.resolvedTheme === 'dark' ? 'light' : 'dark');
      },
    },
    {
      id: 'app.theme',
      title: 'Switch theme',
      section: 'app',
      keywords: ['appearance', 'system', 'light', 'dark', 'mode'],
      icon: <span className="text-sm leading-none">◐</span>,
      run: () => ({
        title: 'Switch theme',
        placeholder: 'Pick a theme…',
        commands: (['system', 'light', 'dark'] as const).map((theme) => ({
          id: `app.theme.${theme}`,
          title: THEME_LABELS[theme],
          section: 'app' as const,
          checked: input.theme === theme,
          run: () => {
            input.setTheme(theme);
          },
        })),
      }),
    },
    {
      id: 'app.sidebar',
      title: input.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
      section: 'app',
      keywords: ['toggle sidebar', 'hide', 'show'],
      shortcut: 'code:BracketLeft',
      icon: <SidebarGlyph className="size-3.5" />,
      run: () => {
        input.toggleSidebar();
      },
    },
    {
      id: 'app.shortcuts',
      title: 'Keyboard shortcuts',
      section: 'app',
      keywords: ['keys', 'help', 'hotkeys'],
      shortcut: '?',
      icon: <span className="text-sm leading-none">?</span>,
      run: () => {
        input.openShortcuts();
      },
    },
  );
  return commands;
}

/** The ids under Suggested on the empty palette (frame 089). */
export function suggestedCommandIds(
  projects: readonly Pick<ProjectWithCounts, 'key'>[],
  currentProjectKey: string | undefined,
): string[] {
  const other = projects.find((project) => project.key !== currentProjectKey);
  return [
    'create.task',
    'navigate.home',
    ...(other ? [`${PROJECT_COMMAND_PREFIX}${other.key}`] : []),
    'app.theme-toggle',
    'create.project',
  ];
}

/** Registers the built-ins while the shell is mounted. */
export function useShellCommands(input: ShellCommandsInput): void {
  const {
    workspace,
    projects,
    currentProjectKey,
    theme,
    resolvedTheme,
    sidebarCollapsed,
    otherWorkspaces,
    canCreateWorkspace,
  } = input;
  const ref = useRef(input);
  ref.current = input;
  // Rebuilt when what the titles and lists show changes; the actions read the latest callbacks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks are read through the latest input
  const commands = useMemo(
    () =>
      buildShellCommands({
        ...input,
        navigate: (href) => ref.current.navigate(href),
        createTask: (title) => ref.current.createTask(title),
        createProject: () => ref.current.createProject(),
        createFromBacklog: () => ref.current.createFromBacklog(),
        createWorkspace: () => ref.current.createWorkspace?.(),
        setTheme: (next) => ref.current.setTheme(next),
        toggleSidebar: () => ref.current.toggleSidebar(),
        openShortcuts: () => ref.current.openShortcuts(),
      }),
    [
      workspace,
      projects,
      currentProjectKey,
      theme,
      resolvedTheme,
      sidebarCollapsed,
      otherWorkspaces,
      canCreateWorkspace,
    ],
  );
  useRegisterCommands(commands);
}
