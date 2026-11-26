import { Link } from '@tanstack/react-router';
import type { HomeAgent } from '@zamu/contracts';
import { useWorkspaceSlug } from '~/lib/workspace';
import { Avatar, cn, Pill } from '~/ui';
import { actionText, actsForText, agoText, forText } from './format';

// Agent cards on the Agents tab (components.md "Agent card", frame 101; screens.css .agent-card): the
// agent and who it acts for, Working or Idle, its current task (or its last action) with a live dot,
// its counts and its five most recent actions. Task keys link to the task.

export interface AgentCardsProps {
  agents: readonly HomeAgent[];
  now: number | null;
}

export function AgentCards({ agents, now }: AgentCardsProps) {
  if (agents.length === 0) return null;
  return (
    <section aria-label="Agents" className="grid grid-cols-2 gap-3.5 px-4.5 py-4">
      {agents.map((card) => (
        <AgentCard key={card.agent.id} card={card} now={now} />
      ))}
    </section>
  );
}

function TaskKeyLink({
  taskKey,
  projectKey,
  className,
}: {
  taskKey: string;
  projectKey: string;
  className?: string;
}) {
  const workspace = useWorkspaceSlug();
  return (
    <Link
      to="/w/$workspace/p/$projectKey/$taskKey"
      params={{ workspace, projectKey, taskKey }}
      className={cn(
        'shrink-0 rounded-sm text-xs font-medium text-fg-3 no-underline tabular-nums outline-none hover:text-fg focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    >
      {taskKey}
    </Link>
  );
}

function AgentCard({ card, now }: { card: HomeAgent; now: number | null }) {
  const { agent, state, currentTask, counts, recent } = card;
  const working = state === 'working';
  const last = recent[0];
  const actsFor = actsForText(agent);
  return (
    <article
      aria-label={agent.name}
      className="flex min-w-0 flex-col gap-2.5 rounded-lg bg-surface px-4 py-3.5 shadow-card"
    >
      <header className="flex items-center gap-2.5">
        <Avatar name={agent.name} kind="agent" size={28} decorative />
        <span className="font-semibold">{agent.name}</span>
        {actsFor ? <span className="truncate text-sm text-fg-3">{actsFor}</span> : null}
        <Pill tone={working ? 'ok' : 'default'} className="ml-auto">
          {working ? 'Working' : 'Idle'}
        </Pill>
      </header>
      <div className="flex min-w-0 items-center gap-2 rounded-sm bg-bg-lane px-2.5 py-2.25 whitespace-nowrap">
        {/* The live dot (screens.css .live): a 3px halo of --status-done at 25%, no token holds it. */}
        <span
          aria-hidden
          className={cn(
            'size-1.75 shrink-0 rounded-full',
            working
              ? 'bg-status-done shadow-[0_0_0_3px_color-mix(in_oklch,var(--status-done)_25%,transparent)]'
              : 'bg-fg-3',
          )}
        />
        {working && currentTask ? (
          <>
            <TaskKeyLink taskKey={currentTask.key} projectKey={currentTask.project.key} />
            <span className="min-w-0 flex-1 truncate font-medium">{currentTask.title}</span>
            <span className="shrink-0 text-xs text-fg-3">
              {now == null ? '' : forText(currentTask.since, now)}
            </span>
          </>
        ) : last ? (
          <>
            <TaskKeyLink taskKey={last.task.key} projectKey={last.task.project.key} />
            <span className="min-w-0 flex-1 truncate font-medium">
              Last: {actionText(last)} on {last.task.title}
            </span>
            <span className="shrink-0 text-xs text-fg-3">{now == null ? '' : agoText(last.at, now)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg-3">No activity yet</span>
        )}
      </div>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
        <Count value={counts.assigned} label="assigned" />
        <Count value={counts.inReview} label="waiting for review" />
        <Count value={counts.blocked} label="blocked" />
        <Count value={counts.changesToday} label="changes today" />
      </p>
      {recent.length > 0 ? (
        <ol aria-label={`What ${agent.name} did last`} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {recent.map((action) => (
            <li key={`${action.kind}:${action.id}`} className="flex min-w-0 items-center gap-2 text-sm">
              <TaskKeyLink taskKey={action.task.key} projectKey={action.task.project.key} />
              <span className="min-w-0 flex-1 truncate text-fg-2">{actionText(action)}</span>
              <span className="shrink-0 text-fg-2">{now == null ? '' : agoText(action.at, now)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span>
      <b className="font-semibold text-fg tabular-nums">{value}</b> {label}
    </span>
  );
}
