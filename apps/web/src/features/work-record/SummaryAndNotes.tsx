import type { Task } from '@zamu/contracts';
import { Markdown } from '~/features/tasks/Markdown';
import { SummaryBlock } from '~/ui';
import { firstName } from './ops';
import { SectionHead } from './WorkItemSection';

// The final summary at the top of a finished task (m6.css .sum, frame 001), and the read-only notes of a
// mirrored task (.ro-block, frame 021): the task file holds its notes as one section, not as dated
// entries, so they show as one block "from the file".

export function TaskSummary({ task, time }: { task: Task; time: (value: string) => string }) {
  const summary = task.finalSummary;
  if (!summary?.trim()) return null;
  const meta = task.finalSummaryMeta ?? null;
  const fromFile = meta == null ? (task.locked?.length ?? 0) > 0 : meta.author == null;
  return (
    <SummaryBlock
      className="mb-4.5"
      {...(fromFile
        ? { byline: 'From the file' }
        : meta?.author
          ? {
              author: meta.author,
              onBehalfOf: meta.onBehalfOf ? firstName(meta.onBehalfOf.name) : null,
            }
          : {})}
      time={meta ? time(meta.at) : undefined}
    >
      <Markdown source={summary} size="pane" className="gap-2" />
    </SummaryBlock>
  );
}

/** The task file's implementation notes, read-only, for a task Backlog.md still owns. */
export function FileNotes({ task }: { task: Task }) {
  const notes = task.backlog?.data?.implementationNotes;
  if (!notes?.trim() || (task.locked?.length ?? 0) === 0) return null;
  return (
    <section aria-label="Notes from the file" className="flex flex-col">
      <SectionHead title="Notes" mark={<span className="font-normal text-fg-3">from the file</span>} />
      <div className="rounded-md bg-bg-lane px-3 py-2.5 text-md leading-prose text-fg-2">
        <Markdown source={notes} size="pane" variant="backlog" />
      </div>
    </section>
  );
}
