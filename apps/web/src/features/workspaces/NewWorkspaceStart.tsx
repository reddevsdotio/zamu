// Home of a workspace with no projects yet (the M4 "new workspace" state, in the Margin look): what
// Home will collect, then two numbered first steps, a project and an agent. A new workspace opens here.
import type { ReactNode } from 'react';
import { Button } from '~/ui';

export interface NewWorkspaceStartProps {
  workspaceName: string;
  onNewProject?: () => void;
  onNewFromBacklog?: () => void;
  /** Owners and admins add agents; others don't see that step. */
  onAddAgent?: () => void;
}

function Step({
  number,
  title,
  text,
  children,
}: {
  number: number;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-md border border-line bg-surface p-4">
      <span className="text-xs text-fg-3 tabular-nums">{number}</span>
      <h3 className="m-0 text-md font-semibold text-fg">{title}</h3>
      <p className="m-0 text-sm leading-normal text-fg-2">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </li>
  );
}

export function NewWorkspaceStart({
  workspaceName,
  onNewProject,
  onNewFromBacklog,
  onAddAgent,
}: NewWorkspaceStartProps) {
  return (
    <section
      aria-labelledby="new-workspace-title"
      className="flex max-w-180 flex-col gap-3 px-4.5 pt-6 pb-10"
    >
      <h2 id="new-workspace-title" className="m-0 font-serif text-xl font-medium text-fg">
        Nothing to show yet
      </h2>
      <p className="m-0 max-w-150 leading-prose text-fg-2">
        Home collects what needs you across every project in {workspaceName}: work waiting for review,
        questions from people and agents, blocked tasks and close deadlines.
      </p>
      <ol className="m-0 mt-2 grid list-none grid-cols-2 gap-3 p-0 max-[1199px]:grid-cols-1">
        <Step
          number={1}
          title="Create a project"
          text="Give it a name and a short key like PAY. Link a repository if you have one, or mirror its Backlog.md."
        >
          <Button onPress={onNewProject}>New project</Button>
          {onNewFromBacklog ? (
            <Button variant="secondary" onPress={onNewFromBacklog}>
              New from Backlog.md
            </Button>
          ) : null}
        </Step>
        {onAddAgent ? (
          <Step
            number={2}
            title="Add an agent"
            text="Agents get an API key and work through the zamu CLI. Their tasks and questions show up here."
          >
            <Button variant="secondary" onPress={onAddAgent}>
              Open Members
            </Button>
          </Step>
        ) : null}
      </ol>
    </section>
  );
}
