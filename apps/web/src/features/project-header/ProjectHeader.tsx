import { useQuery } from '@tanstack/react-query';
import type { ProjectWithCounts } from '@zamu/contracts';
import type { ReactNode } from 'react';
import { projectsQuery } from '~/features/tasks/queries';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import { ViewHeader } from '~/ui';
import { MirrorSourceButton } from './MirrorSource';
import { isMirrored } from './mirror';
import { type ProjectView, projectViewHref } from './tabs';

// Shared header of a project's pages (tasks list and board, milestones, cycles, settings), on the M5
// ViewHeader (frames 003, 011, 029):
//
//   [H] Harbor / Milestones   [List|Board]  Filter  Display   ● Backlog.md synced 3m ago  [Search /]  [New C]
//
// The sidebar links the project's pages, so there are no tabs. A project that mirrors Backlog.md gets the
// sync status (and ⇧R) before the search.

export interface ProjectHeaderProps {
  /** Upper-case project key from the route ("PAY"). */
  projectKey: string;
  /** The page: the list and board show only the project in the crumb; the others add their name. */
  current: ProjectView;
  /**
   * Text after "PAY · " in the M4 header ("12 open · board"). The M5 header has no subtitle; it is read
   * out with the page heading for screen readers only.
   */
  subtitle?: ReactNode;
  /** The page's SearchField (width 200), drawn between the sync status and the actions. */
  search?: ReactNode;
  /** Right side: the primary Button and other buttons. */
  actions?: ReactNode;
  /** Filter button and menu (M5-08). */
  filter?: ReactNode;
  /** Display button and popover (M5-08). */
  display?: ReactNode;
  /** List / Board switch. */
  viewSwitch?: ReactNode;
  /**
   * ⇧R refreshes a mirrored project from any page with this header (default true). Turn it off on a
   * page that binds ⇧R itself.
   */
  refreshHotkey?: boolean;
  className?: string;
}

/** The project as listed in the sidebar (name, flags, open count, current cycle), from the cached list. */
export function useProjectSummary(projectKey: string): ProjectWithCounts | undefined {
  const api = useApi();
  return useQuery({
    ...projectsQuery(api),
    select: (data) => data.items.find((item) => item.key === projectKey),
  }).data;
}

const PAGE_NAMES: Record<ProjectView, string | undefined> = {
  tasks: undefined,
  milestones: 'Milestones',
  cycles: 'Cycles',
  settings: 'Settings',
};

export function ProjectHeader({
  projectKey,
  current,
  subtitle,
  search,
  actions,
  filter,
  display,
  viewSwitch,
  refreshHotkey = true,
  className,
}: ProjectHeaderProps) {
  const workspace = useWorkspaceSlug();
  const project = useProjectSummary(projectKey);
  const mirrored = isMirrored(project);
  const name = project?.name ?? projectKey;

  return (
    <div className={className}>
      <h1 className="sr-only">
        {PAGE_NAMES[current] ? `${name} ${PAGE_NAMES[current]}` : name}
        {subtitle != null ? <> · {subtitle}</> : null}
      </h1>
      <ViewHeader
        project={{ key: projectKey, name, href: projectViewHref(workspace, projectKey, 'tasks') }}
        page={PAGE_NAMES[current]}
        viewSwitch={viewSwitch}
        filter={filter}
        display={display}
        sync={
          mirrored && project ? (
            <MirrorSourceButton project={project} refreshHotkey={refreshHotkey} />
          ) : undefined
        }
        search={search}
        actions={actions}
      />
    </div>
  );
}
