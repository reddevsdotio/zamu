import { Link } from '@tanstack/react-router';
import type { HomeDeadline } from '@zamu/contracts';
import { useState } from 'react';
import { useWorkspaceSlug } from '~/lib/workspace';
import { Button, CycleGlyph, cn, MilestoneGlyph } from '~/ui';
import { type DeadlineView, deadlineView } from './format';

// The deadlines strip (components.md "Deadlines strip", frame 099; screens.css .dl-strip, .dl-i): one
// card per milestone, cycle or task, soonest first, each a link to it; four to a row, the rest behind
// "+N". Mine and Everyone only.

export interface DeadlinesProps {
  deadlines: readonly HomeDeadline[];
}

/** Cards in one row; the rest wait behind "+N". */
const PER_ROW = 4;

const COLUMNS = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'] as const;

export function Deadlines({ deadlines }: DeadlinesProps) {
  const [expanded, setExpanded] = useState(false);
  if (deadlines.length === 0) return null;
  const more = deadlines.length - PER_ROW;
  const shown = expanded || more <= 0 ? deadlines : deadlines.slice(0, PER_ROW);
  return (
    <section aria-label="Deadlines" className="flex shrink-0 items-start gap-2.5 px-4.5 pt-3 pb-1">
      <div className={cn('grid min-w-0 flex-1 gap-2.5', COLUMNS[Math.min(deadlines.length, PER_ROW) - 1])}>
        {shown.map((deadline) => {
          const view = deadlineView(deadline);
          return <DeadlineCard key={view.id} view={view} />;
        })}
      </div>
      {more > 0 ? (
        <Button
          variant="quiet"
          className="h-10"
          aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer deadlines' : `Show ${more} more deadlines`}
          onPress={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Less' : `+${more}`}
        </Button>
      ) : null}
    </section>
  );
}

const CARD =
  'flex min-w-0 items-center gap-2.5 rounded-md bg-surface px-3 py-2.5 whitespace-nowrap text-fg no-underline shadow-card outline-none hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]';

function DeadlineCard({ view }: { view: DeadlineView }) {
  const workspace = useWorkspaceSlug();
  const body = (
    <>
      {view.kind === 'cycle' ? (
        <CycleGlyph size={12} className="text-fg-2" />
      ) : (
        <MilestoneGlyph size={10} className="mx-px text-fg-2" />
      )}
      <span
        className={cn(
          'truncate font-semibold',
          view.kind === 'task' ? 'shrink-0' : 'min-w-0 max-w-3/5 shrink-0',
        )}
      >
        {view.name}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{view.meta}</span>
      <span
        className={cn(
          'shrink-0 text-xs',
          view.overdue ? 'font-semibold text-danger' : 'font-medium text-fg-2',
        )}
      >
        {view.when}
      </span>
    </>
  );
  const to = view.to;
  const label = `${view.name}, ${view.meta}, ${view.when}`;
  if (to.kind === 'milestone') {
    return (
      <Link
        to="/w/$workspace/p/$projectKey/milestones/$milestoneId"
        params={{ workspace, projectKey: to.projectKey, milestoneId: to.milestoneId }}
        aria-label={label}
        className={CARD}
      >
        {body}
      </Link>
    );
  }
  if (to.kind === 'cycle') {
    return (
      <Link
        to="/w/$workspace/p/$projectKey/cycles/$cycleNumber"
        params={{ workspace, projectKey: to.projectKey, cycleNumber: String(to.cycleNumber) }}
        aria-label={label}
        className={CARD}
      >
        {body}
      </Link>
    );
  }
  return (
    <Link
      to="/w/$workspace/p/$projectKey/$taskKey"
      params={{ workspace, projectKey: to.projectKey, taskKey: to.taskKey }}
      aria-label={label}
      className={CARD}
    >
      {body}
    </Link>
  );
}
