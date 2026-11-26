import { useQueryClient } from '@tanstack/react-query';
import type { Task, WorkItem, WorkItemKind } from '@zamu/contracts';
import { type ReactNode, type Ref, useCallback } from 'react';
import { failureText, showFieldToast } from '~/features/task-fields';
import { useApi } from '~/lib/workspace';
import { Checklist, type ChecklistHandle, type ChecklistItem, cn, ProgressMark } from '~/ui';
import { type ItemOps, isFromDefaults, LIST_OF, progressNote, progressOf, type WorkPatch } from './ops';
import { useWorkRecordUpdate } from './queries';

// The task view's "Acceptance criteria" and "Definition of done" (m6.css .mbox + .crit, frames 001, 003,
// 004, 009, 010, 021): a header with the progress mark and its note, then the checklist. Every edit is
// one optimistic write; removing a line shows the Undo toast. Criteria are numbered, done items are
// named by their text. Mirrored tasks show the lists read-only with the lock tooltip.

export const SECTION_TITLE: Record<WorkItemKind, string> = {
  criterion: 'Acceptance criteria',
  done: 'Definition of done',
};

const NOUN: Record<WorkItemKind, { one: string; many: string }> = {
  criterion: { one: 'criterion', many: 'criteria' },
  done: { one: 'done item', many: 'done items' },
};

/** "criterion 5", "“Changelog has a line”": how toasts and history name an item. */
export function itemName(kind: WorkItemKind, item: Pick<WorkItem, 'number' | 'text'>): string {
  return kind === 'criterion' ? `criterion ${item.number}` : `“${item.text}”`;
}

/** The heading row of a list: title, progress mark, and the note at the right. */
export function SectionHead({
  title,
  id,
  mark,
  end,
}: {
  title: string;
  id?: string;
  mark?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <div className="mt-6 mb-1.5 flex min-w-0 items-center gap-2 text-sm text-fg-2">
      <h2 id={id} className="m-0 text-sm font-semibold">
        {title}
      </h2>
      {mark}
      <span className="flex-1" />
      {end ? <span className="truncate text-fg-3">{end}</span> : null}
    </div>
  );
}

/** Writes to one list of a task, with the toasts. */
export function useItemActions(task: Task, kind: WorkItemKind) {
  const api = useApi();
  const queryClient = useQueryClient();
  const update = useWorkRecordUpdate(task.key);
  const { mutateAsync } = update;
  const list = LIST_OF[kind];

  const send = useCallback(
    async (ops: ItemOps): Promise<boolean> => {
      const patch: WorkPatch = { [list]: ops };
      try {
        await mutateAsync({ key: task.key, patch });
        return true;
      } catch (error) {
        showFieldToast({ text: failureText(task.key, error), tone: 'error' });
        return false;
      }
    },
    [list, mutateAsync, task.key],
  );

  /** The list as cached now (after the writes already sent). */
  const current = useCallback(
    () =>
      (queryClient.getQueryData(api.orpc.tasks.get.queryKey({ input: { key: task.key } }))?.[list] ??
        []) as WorkItem[],
    [queryClient, list, task.key, api],
  );

  /** Puts a removed line back where it was, with its state: added at the end, then moved. */
  const restore = useCallback(
    async (removed: WorkItem) => {
      if (!(await send({ add: [removed.text] }))) return;
      const number = current().length;
      const ops: ItemOps = {};
      if (removed.state === 'checked') ops.check = [number];
      if (removed.state === 'waived' && removed.waivedReason) {
        ops.waive = [{ number, reason: removed.waivedReason }];
      }
      if (removed.number < number) ops.move = [{ from: number, to: removed.number }];
      if (Object.keys(ops).length) await send(ops);
    },
    [send, current],
  );

  return {
    toggle: (item: ChecklistItem) =>
      void send(item.state === 'checked' ? { uncheck: [item.number] } : { check: [item.number] }),
    waive: (item: ChecklistItem, reason: string) => void send({ waive: [{ number: item.number, reason }] }),
    unwaive: (item: ChecklistItem) => void send({ unwaive: [item.number] }),
    edit: (item: ChecklistItem, text: string) => void send({ edit: [{ number: item.number, text }] }),
    move: (item: ChecklistItem, direction: -1 | 1) =>
      void send({ move: [{ from: item.number, to: item.number + direction }] }),
    add: (text: string) => void send({ add: [text] }),
    remove: (item: ChecklistItem) => {
      const removed = current().find((other) => other.number === item.number);
      void send({ remove: [item.number] }).then((ok) => {
        if (!ok || !removed) return;
        const name = itemName(kind, removed);
        showFieldToast({
          text: `Removed ${name}`,
          undo: () => void restore(removed),
        });
      });
    },
  };
}

export interface WorkItemSectionProps {
  task: Task;
  kind: WorkItemKind;
  /** The project's default done items, for "from the project defaults". */
  defaults?: readonly string[];
  /** Shift+A and Shift+X reach the list through this. */
  listRef?: Ref<ChecklistHandle>;
  className?: string;
}

export function WorkItemSection({ task, kind, defaults = [], listRef, className }: WorkItemSectionProps) {
  const items = (kind === 'criterion' ? task.criteria : task.doneItems) ?? [];
  const mirrored = (task.locked?.length ?? 0) > 0;
  // M7: an archived task is read-only too, and leaves out the lists it doesn't have.
  const archived = task.archivedAt != null;
  const readOnly = mirrored || archived;
  const progress = progressOf(items);
  const actions = useItemActions(task, kind);
  const title = SECTION_TITLE[kind];
  const noun = NOUN[kind];
  const titleId = `work-${kind}-title`;
  if (archived && items.length === 0) return null;

  const end = mirrored
    ? 'from the file'
    : kind === 'done' && isFromDefaults(items, defaults)
      ? 'from the project defaults'
      : progressNote(progress);

  return (
    <section aria-labelledby={titleId} data-work-list={kind} className={cn('flex flex-col', className)}>
      <SectionHead
        id={titleId}
        title={title}
        mark={
          items.length ? (
            <ProgressMark {...progress} format="long" noun={noun.many} className="font-semibold" />
          ) : null
        }
        end={items.length || !readOnly ? end : null}
      />
      {readOnly && items.length === 0 ? (
        <p className="m-0 flex h-8.5 items-center px-0.5 text-sm text-fg-3">None in the file</p>
      ) : (
        <Checklist
          ref={listRef}
          aria-label={title}
          items={items}
          noun={noun.one}
          numbered={kind === 'criterion'}
          readOnly={readOnly}
          {...(readOnly
            ? {}
            : {
                onToggle: actions.toggle,
                onWaive: actions.waive,
                onUnwaive: actions.unwaive,
                onEdit: actions.edit,
                onMove: actions.move,
                onRemove: actions.remove,
                onAdd: actions.add,
              })}
          addLabel={kind === 'criterion' ? 'Add a criterion' : 'Add a done item'}
          {...(kind === 'criterion'
            ? { addKbd: '⇧A', addHint: 'What must be true when this is done' }
            : { addHint: 'What every task needs before it is done' })}
        />
      )}
    </section>
  );
}
