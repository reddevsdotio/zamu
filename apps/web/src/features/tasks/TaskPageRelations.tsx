import { Link } from '@tanstack/react-router';
import { isOpenStatus, type RelatedTask, type Task } from '@zamu/contracts';
import type { ReactNode, RefObject } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useFieldChange } from '~/features/task-fields';
import { useWorkspaceSlug } from '~/lib/workspace';
import { Avatar, CloseGlyph, cn, Kbd, PlusGlyph, StatusGlyph, SubtaskProgress } from '~/ui';

// The task view's Subtasks and Blocked by boxes (screens.css .mbox, frames 051, 053, 054): one row per
// task with status, key, title and assignee; done or canceled rows read quiet; hidden blockers read
// "Removed task". The add line opens the subtask or blocker picker (⇧S, ⇧B). Mirrored tasks list what
// the file says and have no add line.

/** Project key of a task key: "PAY" for PAY-142 and PAY-786.1. */
export const projectOfKey = (key: string) => key.slice(0, Math.max(0, key.indexOf('-'))) || key;

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 mb-1.5 flex items-center gap-2 text-sm font-semibold text-fg-2">{children}</div>
  );
}

function RelationRow({
  task,
  quiet,
  onRemove,
}: {
  task: RelatedTask | null;
  /** Struck through in --fg-3: a canceled subtask, a blocker that no longer blocks. */
  quiet: boolean;
  onRemove?: () => void;
}) {
  const workspace = useWorkspaceSlug();
  if (!task) {
    return (
      <li className="flex h-8.5 items-center gap-2.5 border-b border-line-soft px-2.5 last:border-b-0">
        <span aria-hidden className="size-3.25 shrink-0" />
        <span className="text-md text-fg-3 italic">Removed task</span>
      </li>
    );
  }
  return (
    <li className="group relative flex h-8.5 items-center border-b border-line-soft last:border-b-0 hover:bg-bg-grp has-focus-visible:bg-bg-grp">
      <Link
        to="/w/$workspace/p/$projectKey/$taskKey"
        params={{ workspace, projectKey: projectOfKey(task.key), taskKey: task.key }}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-2.5 whitespace-nowrap outline-none focus-visible:focus-ring-inset"
      >
        <StatusGlyph status={task.status} />
        <span className="min-w-16 shrink-0 text-sm font-medium text-fg-3 tabular-nums">{task.key}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-md',
            quiet ? 'text-fg-3 line-through decoration-line' : 'text-fg',
          )}
        >
          {task.title}
        </span>
        {task.assignee ? (
          <Avatar name={task.assignee.name} kind={task.assignee.kind} className="shrink-0" />
        ) : null}
      </Link>
      {onRemove ? (
        <AriaButton
          onPress={onRemove}
          aria-label={`Remove blocker ${task.key}`}
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-sm bg-bg-grp text-fg-3 opacity-0 outline-none group-hover:opacity-100 hover:bg-bg-lane hover:text-fg focus-visible:opacity-100 focus-visible:focus-ring"
        >
          <CloseGlyph />
        </AriaButton>
      ) : null}
    </li>
  );
}

function AddLine({
  label,
  kbd,
  onPress,
  lineRef,
  boxed,
}: {
  label: string;
  kbd: string;
  onPress: () => void;
  lineRef: RefObject<HTMLButtonElement | null>;
  /** Inside a box (with a rule above it) or on its own (an empty list). */
  boxed: boolean;
}) {
  return (
    <AriaButton
      ref={lineRef}
      onPress={onPress}
      aria-keyshortcuts={kbd === '⇧S' ? 'Shift+S' : 'Shift+B'}
      className={cn(
        'flex h-8.5 w-full cursor-pointer items-center gap-2 text-left text-sm text-fg-3 outline-none hover:text-fg-2 focus-visible:focus-ring-inset',
        boxed ? 'border-t border-line-soft px-2.5 first:border-t-0 hover:bg-bg-grp' : 'rounded-sm px-0.5',
      )}
    >
      <PlusGlyph className="size-2.25" />
      {label}
      <span className="flex-1" />
      <Kbd aria-hidden>{kbd}</Kbd>
    </AriaButton>
  );
}

const box = 'overflow-hidden rounded-md border border-line-soft bg-surface';

export interface RelationSectionProps {
  task: Task;
  /** The task is mirrored or archived: rows only, no add line. */
  readOnly: boolean;
  /** M7: the task is archived: an empty list is left out. */
  hideEmpty?: boolean;
  /** Opens the picker (⇧S, ⇧B) over the add line. */
  onAdd: () => void;
  addRef: RefObject<HTMLButtonElement | null>;
}

/** "Subtasks  ◔ 3 of 4 done ………… 1 canceled". */
export function SubtasksSection({ task, readOnly, hideEmpty, onAdd, addRef }: RelationSectionProps) {
  const subtasks = task.subtasks ?? [];
  const progress = task.subtaskProgress ?? { done: 0, total: 0 };
  const canceled = subtasks.filter((item) => item.status === 'canceled').length;
  // A subtask can't have subtasks of its own (one level).
  if ((task.parent || hideEmpty) && subtasks.length === 0) return null;
  return (
    <section aria-label="Subtasks">
      <SectionHead>
        <h2 className="m-0 text-sm font-semibold">Subtasks</h2>
        {progress.total > 0 ? (
          <SubtaskProgress done={progress.done} total={progress.total} format="long" />
        ) : null}
        <span className="flex-1" />
        {canceled ? <span className="font-normal text-fg-3">{canceled} canceled</span> : null}
      </SectionHead>
      {subtasks.length ? (
        <div className={box}>
          <ul className="m-0 list-none p-0">
            {subtasks.map((item) => (
              <RelationRow key={item.key} task={item} quiet={item.status === 'canceled'} />
            ))}
          </ul>
          {readOnly ? null : <AddLine label="Add subtask" kbd="⇧S" onPress={onAdd} lineRef={addRef} boxed />}
        </div>
      ) : readOnly ? (
        <p className="m-0 flex h-8.5 items-center px-0.5 text-sm text-fg-3">None in the file</p>
      ) : (
        <AddLine label="Add subtask" kbd="⇧S" onPress={onAdd} lineRef={addRef} boxed={false} />
      )}
    </section>
  );
}

/** "Blocks PAY-150, PAY-151" (the reverse relation), links to each. */
function BlocksLine({ blocks }: { blocks: readonly (RelatedTask | null)[] }) {
  const workspace = useWorkspaceSlug();
  const visible = blocks.filter((item): item is RelatedTask => item != null);
  const hidden = blocks.length - visible.length;
  if (blocks.length === 0) return null;
  const shown = visible.slice(0, 3);
  const more = visible.length - shown.length + hidden;
  return (
    <span className="truncate font-normal text-fg-3">
      Blocks{' '}
      {shown.map((item, index) => (
        <span key={item.key}>
          {index > 0 ? ', ' : null}
          <Link
            to="/w/$workspace/p/$projectKey/$taskKey"
            params={{ workspace, projectKey: projectOfKey(item.key), taskKey: item.key }}
            title={item.title}
            className="rounded-sm outline-none hover:text-fg-2 focus-visible:focus-ring"
          >
            {item.key}
          </Link>
        </span>
      ))}
      {more > 0
        ? `${shown.length ? ' and ' : ''}${more} ${shown.length ? 'more' : more === 1 ? 'removed task' : 'removed tasks'}`
        : null}
    </span>
  );
}

/** "Blocked by  2 open ………… Blocks PAY-150". */
export function BlockedBySection({ task, readOnly, hideEmpty, onAdd, addRef }: RelationSectionProps) {
  const blockers = task.blockedBy ?? [];
  const open = blockers.filter((item) => item != null && isOpenStatus(item.status)).length;
  const { apply } = useFieldChange();
  if (hideEmpty && blockers.length === 0 && (task.blocks ?? []).length === 0) return null;
  return (
    <section aria-label="Blocked by">
      <SectionHead>
        <h2 className="m-0 text-sm font-semibold">Blocked by</h2>
        {open ? <span className="font-normal text-fg-3">{open} open</span> : null}
        <span className="flex-1" />
        <BlocksLine blocks={task.blocks ?? []} />
      </SectionHead>
      {blockers.length ? (
        <div className={box}>
          <ul className="m-0 list-none p-0">
            {blockers.map((item, index) => (
              <RelationRow
                key={item?.key ?? `removed-${index}`}
                task={item}
                quiet={item != null && !isOpenStatus(item.status)}
                onRemove={
                  readOnly || !item ? undefined : () => void apply([task], { removeBlockers: [item.key] })
                }
              />
            ))}
          </ul>
          {readOnly ? null : <AddLine label="Add blocker" kbd="⇧B" onPress={onAdd} lineRef={addRef} boxed />}
        </div>
      ) : readOnly ? (
        <p className="m-0 flex h-8.5 items-center px-0.5 text-sm text-fg-3">None in the file</p>
      ) : (
        <AddLine label="Add blocker" kbd="⇧B" onPress={onAdd} lineRef={addRef} boxed={false} />
      )}
    </section>
  );
}
