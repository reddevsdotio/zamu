import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';
import {
  isMirrored,
  MirrorSourceButton,
  projectViewHref,
  useProjectSummary,
} from '~/features/project-header';
import { useWorkspaceSlug } from '~/lib/workspace';
import { ViewHeader } from '~/ui';

// The view header of a milestone or cycle page (frames 108 and 110):
//
//   [H] Harbor / Milestones / Mobile app release   ≡ Filter  Display   ● Backlog.md synced …  [Edit] [New task C]
//
// The project header (features/project-header) names one page only, so the pages with a third crumb
// draw the ViewHeader themselves, with the same sync status.

export interface PlanningHeaderProps {
  projectKey: string;
  section: 'milestones' | 'cycles';
  /** The milestone or cycle: the last crumb. */
  title: string;
  filter?: ReactNode;
  display?: ReactNode;
  actions?: ReactNode;
}

export function PlanningHeader({
  projectKey,
  section,
  title,
  filter,
  display,
  actions,
}: PlanningHeaderProps) {
  const workspace = useWorkspaceSlug();
  const project = useProjectSummary(projectKey);
  const name = project?.name ?? projectKey;
  const label = section === 'milestones' ? 'Milestones' : 'Cycles';
  return (
    <ViewHeader
      project={{ key: projectKey, name, href: projectViewHref(workspace, projectKey, 'tasks') }}
      page={
        <span className="flex min-w-0 items-center gap-2.25">
          <Link
            href={projectViewHref(workspace, projectKey, section)}
            className="cursor-pointer rounded-sm text-fg-2 outline-none hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
          >
            {label}
          </Link>
          <span aria-hidden className="text-fg-3">
            /
          </span>
          <span className="max-w-90 truncate text-fg">{title}</span>
        </span>
      }
      filter={filter}
      display={display}
      sync={isMirrored(project) && project ? <MirrorSourceButton project={project} /> : undefined}
      actions={actions}
    />
  );
}
