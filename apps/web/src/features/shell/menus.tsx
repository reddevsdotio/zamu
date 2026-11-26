import type { Theme, WorkspaceRef } from '@zamu/contracts';
import { useState } from 'react';
import {
  Button as AriaButton,
  Menu as AriaMenu,
  Dialog,
  DialogTrigger,
  MenuTrigger,
} from 'react-aria-components';
import { WorkspaceTile } from '~/features/workspaces/WorkspaceTile';
import {
  Avatar,
  CheckGlyph,
  GearGlyph,
  type MemberKind,
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  PlusGlyph,
  Popover,
  SegmentedControl,
  type SegmentedItem,
  SidebarPersonButton,
  SidebarWorkspaceButton,
  useSidebarCollapsed,
} from '~/ui';

// The sidebar's menus (frames 004, 005, 008, 009): the workspace switcher, the "+" of the Projects
// heading, and the person menu with the theme switch. Choosing another workspace opens its Home.

export interface WorkspaceMenuProps {
  /** The workspace the page is in. */
  current: WorkspaceRef;
  /**
   * Every workspace the person belongs to, by name, the current one included. Undefined while the
   * list loads: the menu shows the current one alone.
   */
  workspaces?: readonly WorkspaceRef[];
  /** The creation policy lets the person create a workspace: "New workspace" shows. */
  canCreate?: boolean;
  /** Where a workspace opens (its Home). */
  workspaceHref: (slug: string) => string;
  settingsHref: string;
  inviteHref: string;
  onNewWorkspace?: () => void;
  onNewProject: () => void;
  onNewFromBacklog: () => void;
}

/**
 * The workspace switcher (frame 004): every workspace of the person with the current one checked,
 * New workspace when they may create one, then settings, invite and the project creation items.
 */
export function WorkspaceMenu({
  current,
  workspaces,
  canCreate = false,
  workspaceHref,
  settingsHref,
  inviteHref,
  onNewWorkspace,
  onNewProject,
  onNewFromBacklog,
}: WorkspaceMenuProps) {
  const collapsed = useSidebarCollapsed();
  return (
    <MenuTrigger>
      <SidebarWorkspaceButton name={current.name} />
      <Menu
        placement={collapsed ? 'right top' : 'bottom start'}
        aria-label="Workspace"
        className="w-58"
        onAction={(key) => {
          if (key === 'new-workspace') onNewWorkspace?.();
          if (key === 'new-project') onNewProject();
          if (key === 'new-from-backlog') onNewFromBacklog();
        }}
      >
        {workspaceMenuItems({
          current,
          workspaces,
          canCreate,
          workspaceHref,
          settingsHref,
          inviteHref,
          onNewWorkspace,
        })}
      </Menu>
    </MenuTrigger>
  );
}

/**
 * The switcher's items: the workspaces (current one checked), New workspace when allowed, settings,
 * invite, then the project creation items. Shared with the /__ui gallery, which draws the open menu.
 */
export function workspaceMenuItems({
  current,
  workspaces,
  canCreate = false,
  workspaceHref,
  settingsHref,
  inviteHref,
  onNewWorkspace,
}: Omit<WorkspaceMenuProps, 'onNewProject' | 'onNewFromBacklog'>) {
  const listed = workspaces?.some((workspace) => workspace.id === current.id)
    ? workspaces
    : [current, ...(workspaces ?? [])];
  return (
    <>
      <MenuGroup title="Workspaces" aria-label="Workspaces">
        {listed.map((workspace) => {
          const isCurrent = workspace.id === current.id;
          return (
            <MenuItem
              key={workspace.id}
              id={`workspace:${workspace.slug}`}
              textValue={workspace.name}
              {...(isCurrent ? {} : { href: workspaceHref(workspace.slug) })}
              lead={<WorkspaceTile name={workspace.name} slug={workspace.slug} current={isCurrent} />}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {isCurrent ? (
                  <span className="text-accent-text">
                    <CheckGlyph />
                    <span className="sr-only">, current</span>
                  </span>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
        {canCreate && onNewWorkspace ? (
          <MenuItem id="new-workspace" lead={<PlusGlyph />}>
            New workspace
          </MenuItem>
        ) : null}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem id="settings" href={settingsHref} lead={<GearGlyph className="size-3.5" />}>
        Workspace settings
      </MenuItem>
      <MenuItem id="invite" href={inviteHref} lead={<PlusGlyph />}>
        Invite people
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="new-project" lead={<PlusGlyph />}>
        New project
      </MenuItem>
      <MenuItem id="new-from-backlog" lead={<PlusGlyph />}>
        New from Backlog.md
      </MenuItem>
    </>
  );
}

/** The "+" at the end of the Projects heading: New project, New from Backlog.md. */
export function NewProjectMenu({
  onNewProject,
  onNewFromBacklog,
}: Pick<WorkspaceMenuProps, 'onNewProject' | 'onNewFromBacklog'>) {
  return (
    <MenuTrigger>
      <AriaButton
        aria-label="New project"
        className="grid size-5.5 cursor-pointer place-items-center rounded-sm text-fg-3 outline-none hover:bg-bg-lane hover:text-fg focus-visible:shadow-[var(--focus-ring)] aria-expanded:bg-bg-lane aria-expanded:text-fg"
      >
        <PlusGlyph />
      </AriaButton>
      <Menu
        placement="bottom start"
        aria-label="New project"
        onAction={(key) => (key === 'new-from-backlog' ? onNewFromBacklog() : onNewProject())}
      >
        <MenuItem id="new-project" lead={<PlusGlyph />}>
          New project
        </MenuItem>
        <MenuItem id="new-from-backlog" lead={<PlusGlyph />}>
          New from Backlog.md
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

export const THEME_ITEMS: readonly SegmentedItem<Theme>[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export interface PersonMenuProps {
  user: { name: string; email?: string | null; kind?: MemberKind };
  /** Line under the name; defaults to the email. */
  subtitle?: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  myKeysHref: string;
  onShortcuts: () => void;
  onSignOut: () => void;
}

/** The person menu: name and email, the System / Light / Dark switch, My API keys, shortcuts, Sign out. */
export function PersonMenu({
  user,
  subtitle,
  theme,
  onThemeChange,
  myKeysHref,
  onShortcuts,
  onSignOut,
}: PersonMenuProps) {
  const collapsed = useSidebarCollapsed();
  const [isOpen, setOpen] = useState(false);
  const run = (id: string) => {
    setOpen(false);
    if (id === 'shortcuts') onShortcuts();
    if (id === 'sign-out') onSignOut();
  };
  const line = subtitle ?? user.email ?? undefined;
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <SidebarPersonButton name={user.name} kind={user.kind} />
      <Popover
        placement={collapsed ? 'right bottom' : 'top start'}
        offset={8}
        className="w-65 min-w-0 overflow-visible"
      >
        <Dialog aria-label="Account" className="flex flex-col p-1.5 outline-none">
          <div className="flex min-h-12 items-center gap-2.25 px-2">
            <Avatar name={user.name} kind={user.kind} size={28} decorative />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{user.name}</span>
              {line ? <span className="truncate text-xs text-fg-3">{line}</span> : null}
            </div>
          </div>
          <MenuSeparator />
          <div className="flex min-h-10 items-center justify-between gap-3 px-2">
            <span>Theme</span>
            <SegmentedControl aria-label="Theme" items={THEME_ITEMS} value={theme} onChange={onThemeChange} />
          </div>
          <AriaMenu
            aria-label="Account actions"
            onAction={(key) => run(String(key))}
            className="flex flex-col gap-px outline-none"
          >
            <MenuItem id="my-keys" href={myKeysHref} onAction={() => setOpen(false)}>
              My API keys
            </MenuItem>
            <MenuItem id="shortcuts" kbd="?">
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem id="sign-out">Sign out</MenuItem>
          </AriaMenu>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
