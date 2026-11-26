import { ORPCError } from '@orpc/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { OPEN_TASK_STATUSES, type RelatedTask, type Task, type TaskListItem } from '@zamu/contracts';
import { useRef, useState } from 'react';
import { relatedOf, taskQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { PickerMenu, type PickerMenuItem, type PickerMenuSection, StatusGlyph } from '~/ui';
import { useFieldChange } from './apply';
import type { FieldPickerProps } from './StatusPicker';
import { FieldPopover, READ_ONLY_HINTS, ReadOnlyLine } from './shared';
import { type FieldTarget, isFieldLocked, toTargets } from './targets';

// Blocked by (frame 075): search the open tasks of the same project and add them; the current
// blockers stay listed under the results with a remove (×, or Backspace), done ones struck, hidden
// ones as "Removed task". A link that would loop is refused under the result, from the server's
// DEPENDENCY_LOOP or from what the task view already knows (the task blocks that one).

/** Most search results shown. */
export const RESULT_LIMIT = 20;

/** "Can't add: PAY-150 already waits on PAY-142." */
export const loopText = (task: string, blocker: string) => `Can’t add: ${blocker} already waits on ${task}.`;

/** The refusal for a DEPENDENCY_LOOP error, or null for other errors. */
export function loopRefusal(error: unknown, task: string, blocker: string): string | null {
  if (!(error instanceof ORPCError) || error.code !== 'DEPENDENCY_LOOP') return null;
  const loop = (error.data as { loop?: { task: string; blocker: string } } | undefined)?.loop;
  return loopText(loop?.task ?? task, loop?.blocker ?? blocker);
}

/** Open tasks of a project matching `q`, for the blocker and subtask pickers. */
export function useTaskSearch(projectKey: string, q: string, extra: { topLevel?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    ...api.orpc.tasks.list.queryOptions({
      input: {
        project: [projectKey],
        status: [...OPEN_TASK_STATUSES],
        limit: RESULT_LIMIT * 2,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(extra.topLevel ? { topLevel: true } : {}),
      },
    }),
    placeholderData: keepPreviousData,
  });
}

export interface BlockerMenuProps {
  /** The task (its blockers and the tasks it blocks). */
  task: Pick<Task, 'key' | 'blockedBy' | 'blocks'> & { project: { key: string; name: string } };
  /** Search results; the menu leaves out the task itself and its blockers. */
  results: readonly TaskListItem[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: (blocker: TaskListItem) => void;
  onRemove: (key: string) => void;
  /** Refusals from the server, by result key. */
  refusals: ReadonlyMap<string, string>;
  readOnly?: boolean;
  /** Why it is read-only (defaults to the Backlog.md lock text). */
  readOnlyText?: string;
  onClose?: () => void;
  autoFocus?: boolean;
}

const REMOVED = '__removed__';

export function BlockerMenu({
  task,
  results,
  query,
  onQueryChange,
  onAdd,
  onRemove,
  refusals,
  readOnly = false,
  readOnlyText,
  onClose,
  autoFocus,
}: BlockerMenuProps) {
  const current = task.blockedBy ?? [];
  const isBlocker = (key: string) => current.some((blocker) => blocker?.key === key);
  // Tasks waiting on this one directly can't block it: that's a loop the client can see.
  const waiting = new Set((task.blocks ?? []).flatMap((other) => (other ? [other.key] : [])));
  const found = (results ?? [])
    .filter((item) => item.key !== task.key && !isBlocker(item.key))
    .slice(0, RESULT_LIMIT);
  const added = useRef(false);

  const resultItems: PickerMenuItem[] = found.map((item) => {
    const refusal =
      refusals.get(item.key) ?? (waiting.has(item.key) ? loopText(task.key, item.key) : undefined);
    return {
      id: item.key,
      taskKey: item.key,
      label: item.title,
      lead: <StatusGlyph status={item.status} decorative />,
      tone: refusal ? 'dim' : 'default',
      refusal,
      isDisabled: readOnly,
    };
  });
  const currentItems: PickerMenuItem[] = current.map((blocker, index) =>
    blocker
      ? {
          // The same id as its search result, so the highlight stays on it when it moves down here.
          id: blocker.key,
          taskKey: blocker.key,
          label: blocker.title,
          lead: <StatusGlyph status={blocker.status} decorative />,
          tone: blocker.status === 'done' || blocker.status === 'canceled' ? 'done' : 'default',
          removable: !readOnly,
        }
      : // A hidden blocker can't be named, so it can't be removed from here either.
        { id: `${REMOVED}${index}`, label: 'Removed task', tone: 'gone' },
  );
  const sections: PickerMenuSection[] = [
    ...(readOnly
      ? []
      : [
          {
            id: 'results',
            title: query.trim() ? 'Results' : `Open tasks in ${task.project.name}`,
            items: resultItems,
            filter: false,
          },
        ]),
    ...(currentItems.length
      ? [{ id: 'current', title: 'Blocked by', items: currentItems, filter: false }]
      : []),
  ];
  return (
    <PickerMenu
      aria-label="Blocked by"
      selectionMode="none"
      sections={sections}
      query={query}
      onQueryChange={onQueryChange}
      onAction={(id) => {
        // Any pick keeps the menu open: Enter on a current blocker does nothing.
        added.current = true;
        const item = found.find((candidate) => candidate.key === id);
        if (item && !readOnly) onAdd(item);
      }}
      onRemove={(id) => {
        if (isBlocker(id)) onRemove(id);
      }}
      search={{ placeholder: 'Search tasks…', kbd: '⇧B' }}
      emptyText={results ? 'No open tasks match' : 'Searching…'}
      before={readOnly ? <ReadOnlyLine>{readOnlyText}</ReadOnlyLine> : undefined}
      footer={{
        hints: readOnly
          ? READ_ONLY_HINTS
          : [
              { keys: '↵', label: 'add' },
              { keys: '⌫', label: 'remove' },
            ],
        end: `Only tasks in ${task.project.name}`,
      }}
      // Adding keeps the menu open, so the next blocker (or a loop note) is one search away.
      onClose={() => {
        if (added.current) {
          added.current = false;
          return;
        }
        onClose?.();
      }}
      autoFocus={autoFocus}
    />
  );
}

const hasRelations = (target: FieldTarget): target is Task => 'blockedBy' in target && 'createdBy' in target;

function BlockerPickerContent({ target, close }: { target: FieldTarget; close: () => void }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [refusals, setRefusals] = useState<Map<string, string>>(() => new Map());
  // Rows don't carry their blockers: read the detail (cached when the task view is open).
  const detail = useQuery({ ...taskQuery(api, target.key), enabled: !hasRelations(target) }).data;
  const task: Task | undefined = detail ?? (hasRelations(target) ? target : undefined);
  const search = useTaskSearch(target.project.key, query);
  const { apply } = useFieldChange();
  const shown = task ?? { ...target, blockedBy: [], blocks: [] };
  return (
    <BlockerMenu
      task={shown}
      results={search.data?.items}
      query={query}
      onQueryChange={setQuery}
      refusals={refusals}
      readOnly={isFieldLocked([target], 'blockedBy')}
      onClose={close}
      onAdd={(blocker) => {
        void apply(
          [task ?? target],
          { addBlockers: [relatedOf(blocker) as RelatedTask] },
          {
            onError: (error) => {
              const refusal = loopRefusal(error, target.key, blocker.key);
              if (!refusal) return false;
              setRefusals((previous) => new Map(previous).set(blocker.key, refusal));
              return true;
            },
          },
        );
      }}
      onRemove={(key) => void apply([task ?? target], { removeBlockers: [key] })}
    />
  );
}

/** Adds and removes what one task waits on. Opens read-only on mirrored tasks. */
export function BlockerPicker({ targets, ...anchor }: FieldPickerProps) {
  const target = toTargets(targets)[0];
  if (!target) return null;
  return (
    <FieldPopover label="Blocked by" width={430} {...anchor}>
      {(close) => <BlockerPickerContent target={target} close={close} />}
    </FieldPopover>
  );
}
