// Project settings (frames 115 to 127): the project header ("Payments / Settings"), the Margin settings
// nav (Project: General, Labels, Task defaults, Backlog.md) and the current section in a 720px column.
// M6: a project that still mirrors Backlog.md has no Task defaults (its tasks come from the files) and
// calls its page "Backlog.md sync"; once Zamu owns the tasks the page is "Backlog.md" (frames 031, 038).
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { isMirrored, ProjectHeader, useProjectSummary } from '~/features/project-header';
import { cn, SettingsNav, SourceStatusDot } from '~/ui';
import { sourceDot } from './format';
import { hasTasksQuery } from './queries';

export type ProjectSettingsSection = 'general' | 'labels' | 'defaults' | 'backlog';

/** /p/PAY/settings, /p/PAY/settings/labels, /p/PAY/settings/defaults and /p/PAY/settings/backlog. */
export function projectSettingsHref(projectKey: string, section: ProjectSettingsSection = 'general'): string {
  const base = `/p/${encodeURIComponent(projectKey)}/settings`;
  return section === 'general' ? base : `${base}/${section}`;
}

/** The section a settings path shows. */
export function settingsSection(pathname: string): ProjectSettingsSection {
  const path = pathname.replace(/\/+$/, '');
  if (path.endsWith('/settings/backlog')) return 'backlog';
  if (path.endsWith('/settings/labels')) return 'labels';
  if (path.endsWith('/settings/defaults')) return 'defaults';
  return 'general';
}

export function ProjectSettingsLayout({ projectKey, children }: { projectKey: string; children: ReactNode }) {
  const project = useProjectSummary(projectKey);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = settingsSection(pathname);
  const backlog = project?.backlog ?? null;
  // Backlog.md shows while the project has a source, or could get one (no tasks yet).
  const hasTasks = useQuery({
    ...hasTasksQuery(projectKey),
    enabled: project !== undefined && !backlog,
  }).data;
  const showBacklog = backlog !== null || hasTasks !== true || section === 'backlog';
  const mirrored = isMirrored(project);
  const showDefaults = !mirrored || section === 'defaults';

  const item = (id: ProjectSettingsSection, label: string, trailing?: ReactNode) => ({
    id,
    label,
    href: projectSettingsHref(projectKey, id),
    isCurrent: section === id,
    trailing,
  });

  return (
    <section
      aria-label="Project settings"
      className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg"
    >
      <ProjectHeader
        projectKey={projectKey}
        current="settings"
        // The Backlog.md section binds ⇧R to its own Refresh now.
        refreshHotkey={section !== 'backlog'}
        subtitle={project ? (project.openCount ? `${project.openCount} open` : 'no tasks yet') : undefined}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <SettingsNav
          title="Settings sections"
          hideTitle
          sections={[
            {
              label: 'Project',
              items: [
                item('general', 'General'),
                item('labels', 'Labels'),
                ...(showDefaults ? [item('defaults', 'Task defaults')] : []),
                ...(showBacklog
                  ? [
                      item(
                        'backlog',
                        mirrored ? 'Backlog.md sync' : 'Backlog.md',
                        backlog ? <SourceStatusDot state={sourceDot(backlog.state)} /> : undefined,
                      ),
                    ]
                  : []),
              ],
            },
          ]}
        />
        <div className="min-h-0 overflow-auto">
          <div className="px-12 pt-8 pb-12 max-[1199px]:px-8">{children}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * One settings page (screens.css .set-col, .set-t, .set-d): the serif title, a sentence under it, then the
 * page, 22px apart in a 720px column.
 */
export function SettingsPage({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex max-w-180 flex-col gap-5.5', className)}>
      <div className="flex flex-col gap-2.5">
        <h2 className="m-0 font-serif text-2xl leading-tight font-medium text-fg">{title}</h2>
        {description ? <p className="m-0 leading-prose text-pretty text-fg-2">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
