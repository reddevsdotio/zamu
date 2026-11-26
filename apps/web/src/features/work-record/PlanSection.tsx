import type { Task, WorkTextMeta } from '@zamu/contracts';
import { useEffect, useState } from 'react';
import {
  Button as AriaButton,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
} from 'react-aria-components';
import { failureText, showFieldToast } from '~/features/task-fields';
import { Markdown } from '~/features/tasks/Markdown';
import { Button, CaretGlyph, ClippedText, cn, PlusGlyph } from '~/ui';
import { FINISHING, firstName, PLAN_CLIP_LINES, planLabel, planSize } from './ops';
import { useWorkRecordUpdate } from './queries';

// The plan (m6.css .plan, frames 001, 003, 004, 013, 021, 048): plain Markdown, not a checklist. Collapsed
// on a task in review or done ("Plan  8 steps, by claude-dev"), open while work is in progress with who
// wrote it and when. Past 12 lines it is clipped with "Show all 60 lines". An empty native task shows the
// quiet "Write a plan" line; a mirrored task shows the plan "from the file", read-only.

/** "claude-dev for Ana", or null for a plan read from a Backlog.md file. */
export function metaAuthor(meta: WorkTextMeta | null | undefined): string | null {
  if (!meta?.author) return null;
  return meta.onBehalfOf ? `${meta.author.name} for ${firstName(meta.onBehalfOf.name)}` : meta.author.name;
}

export interface PlanSectionProps {
  task: Task;
  /** "Oct 16" for the plan's time; empty until the clock is known. */
  day: (value: string) => string;
}

export function PlanSection({ task, day }: PlanSectionProps) {
  const plan = task.plan ?? '';
  const mirrored = (task.locked?.length ?? 0) > 0;
  // M7: an archived task shows its plan read-only, and no plan at all when it has none.
  const archived = task.archivedAt != null;
  const readOnly = mirrored || archived;
  const [open, setOpen] = useState(() => mirrored || !FINISHING.includes(task.status));
  const [editing, setEditing] = useState(false);
  const update = useWorkRecordUpdate(task.key);

  const save = async (next: string) => {
    setEditing(false);
    const value = next.trim() ? next : null;
    if (value === (task.plan ?? null)) return;
    try {
      await update.mutateAsync({ key: task.key, patch: { plan: value } });
    } catch (error) {
      showFieldToast({ text: failureText(task.key, error), tone: 'error' });
    }
  };

  if (editing) {
    return (
      <section aria-label="Plan" className="flex flex-col">
        <div className="mt-6 mb-1.5 flex items-center gap-2 text-sm text-fg-2">
          <h2 className="m-0 text-sm font-semibold">Plan</h2>
        </div>
        <PlanEditor initial={plan} onCancel={() => setEditing(false)} onSave={(value) => void save(value)} />
      </section>
    );
  }

  if (!plan.trim()) {
    if (archived) return null;
    return (
      <section aria-label="Plan" className="flex flex-col">
        <div className="mt-6 mb-1.5 flex items-center gap-2 text-sm text-fg-2">
          <h2 className="m-0 text-sm font-semibold">Plan</h2>
        </div>
        {readOnly ? (
          <p className="m-0 flex h-8.5 items-center px-0.5 text-sm text-fg-3">None in the file</p>
        ) : (
          <AriaButton
            onPress={() => setEditing(true)}
            className="flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-sm px-0.5 text-left text-sm text-fg-3 outline-none hover:text-fg-2 focus-visible:focus-ring"
          >
            <PlusGlyph className="size-2.25" />
            <span>Write a plan</span>
            <span className="text-xs text-fg-3">Usually written by whoever picks the task up</span>
          </AriaButton>
        )}
      </section>
    );
  }

  const author = metaAuthor(task.planMeta);
  const fromFile = mirrored || (task.planMeta?.origin === 'backlog' && !task.planMeta.author);
  const size = planLabel(plan);
  const { lines } = planSize(plan);
  // Collapsed: "8 steps, by claude-dev"; open, the full byline sits at the right (frames 001, 003).
  const writer = task.planMeta?.author?.name;
  const note = fromFile ? 'from the file' : open || !writer ? size : `${size}, by ${writer}`;
  const byline =
    open && !fromFile && author ? `${author}${task.planMeta ? `, ${day(task.planMeta.at)}` : ''}` : null;

  return (
    <section aria-label="Plan" data-plan={open ? 'open' : 'collapsed'} className="group/plan flex flex-col">
      <div className="mt-6 mb-1.5 flex min-w-0 items-center gap-2 text-sm text-fg-2">
        <h2 className="m-0 min-w-0 text-sm font-semibold">
          <AriaButton
            onPress={() => setOpen(!open)}
            aria-expanded={open}
            className="-ml-1 flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 outline-none hover:text-fg focus-visible:focus-ring"
          >
            <CaretGlyph className={cn('transition-transform', !open && '-rotate-90')} />
            Plan
            <span className="truncate font-normal text-fg-3">{note}</span>
          </AriaButton>
        </h2>
        <span className="flex-1" />
        {open && !readOnly ? (
          <Button
            variant="quiet"
            size="sm"
            onPress={() => setEditing(true)}
            aria-label="Edit the plan"
            className="opacity-0 group-hover/plan:opacity-100 focus-visible:opacity-100"
          >
            Edit
          </Button>
        ) : null}
        {byline ? <span className="truncate text-fg-3">{byline}</span> : null}
      </div>
      {open ? (
        <ClippedText
          lines={PLAN_CLIP_LINES}
          showLabel={`Show all ${lines} lines`}
          contentClassName="leading-prose [&_ol]:pl-6"
        >
          <Markdown source={plan} size="pane" />
        </ClippedText>
      ) : null}
    </section>
  );
}

/** The plan in a Markdown field: ⌘↵ saves, Esc cancels. */
function PlanEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  return (
    <div className="halo flex flex-col gap-2 rounded-md border bg-surface px-3.25 py-2.75">
      <AriaTextField aria-label="Plan" value={draft} onChange={setDraft} className="flex">
        <AriaTextArea
          autoFocus
          rows={5}
          placeholder="1. First step"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSave(draft);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          className="max-h-[60dvh] min-h-28 w-full resize-none border-0 bg-transparent p-0 text-md leading-prose text-fg outline-none [field-sizing:content] placeholder:text-fg-3"
        />
      </AriaTextField>
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-3">Markdown</span>
        <span className="flex-1" />
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
        <Button kbd="⌘↵" onPress={() => onSave(draft)}>
          Save
        </Button>
      </div>
    </div>
  );
}
