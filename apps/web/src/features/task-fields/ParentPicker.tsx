import { ORPCError } from '@orpc/client';
import { useQuery } from '@tanstack/react-query';
import type { Task, TaskListItem } from '@zamu/contracts';
import { useRef, useState } from 'react';
import { relatedOf, taskQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { MenuNote, PickerMenu, type PickerMenuItem, StatusGlyph } from '~/ui';
import { useFieldChange } from './apply';
import { useTaskSearch } from './BlockerPicker';
import type { FieldPickerProps } from './StatusPicker';
import { FieldPopover, READ_ONLY_HINTS, ReadOnlyLine } from './shared';
import { type FieldTarget, isFieldLocked, toTargets } from './targets';

// Parent (the task view's Parent row, the peek, quick create, the palette's "Set parent…"): an open
// top-level task of the same project, or no parent. Subtasks go one level deep, so a task that has
// subtasks of its own can't get a parent. The server's refusals (SUBTASK_DEPTH, NOT_SAME_PROJECT) show
// under the result that caused them. Mirrored tasks show their parent read-only.

const NO_PARENT = '__none__';

/** The parent as the menu shows it: a key, and its title when known. */
export type ParentValue = Pick<TaskListItem, 'key'> & { title?: string };

export interface ParentMenuProps {
  /** The task getting a parent; omit for a task not created yet (quick create). */
  task?: { key: string; hasSubtasks: boolean };
  /** The current parent. */
  value: ParentValue | null;
  /** Search results (open top-level tasks of the project); the menu leaves out the task itself. */
  results: readonly TaskListItem[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  /** A pick: a task, or null for "No parent". */
  onChange: (parent: TaskListItem | null) => void;
  /** Refusals from the server, by result key. */
  refusals?: ReadonlyMap<string, string>;
  /** "Only tasks in Payments" in the footer. */
  projectName?: string;
  readOnly?: boolean;
  /** Why it is read-only (defaults to the Backlog.md lock text). */
  readOnlyText?: string;
  onClose?: () => void;
  autoFocus?: boolean;
}

/** The inline refusal for a failed parent change, or null for errors the toast reports. */
export function parentRefusal(error: unknown, parentKey: string): string | null {
  if (!(error instanceof ORPCError)) return null;
  if (error.code === 'SUBTASK_DEPTH')
    return `Can’t set: ${parentKey} is a subtask. Subtasks go one level deep.`;
  if (error.code === 'NOT_SAME_PROJECT') return `Can’t set: ${parentKey} is in another project.`;
  return null;
}

export function ParentMenu({
  task,
  value,
  results,
  query,
  onQueryChange,
  onChange,
  refusals,
  projectName,
  readOnly = false,
  readOnlyText,
  onClose,
  autoFocus = true,
}: ParentMenuProps) {
  if (task?.hasSubtasks && !readOnly) {
    return (
      <PickerMenu
        aria-label="Parent"
        items={[]}
        search={false}
        emptyText=""
        onClose={onClose}
        footer={{ hints: READ_ONLY_HINTS }}
      >
        <MenuNote>{task.key} has subtasks. Subtasks go one level deep.</MenuNote>
      </PickerMenu>
    );
  }
  const found = (results ?? []).filter((item) => item.key !== task?.key && !item.parentKey);
  const current: PickerMenuItem[] =
    value && !found.some((item) => item.key === value.key)
      ? [{ id: value.key, taskKey: value.key, label: value.title ?? value.key, isDisabled: readOnly }]
      : [];
  const items: PickerMenuItem[] = readOnly
    ? current
    : [
        ...(value ? [{ id: NO_PARENT, label: 'No parent' }] : []),
        ...current,
        ...found.map(
          (item): PickerMenuItem => ({
            id: item.key,
            taskKey: item.key,
            label: item.title,
            lead: <StatusGlyph status={item.status} decorative />,
            ...(refusals?.get(item.key) ? { tone: 'dim' as const, refusal: refusals.get(item.key) } : {}),
          }),
        ),
      ];
  return (
    <PickerMenu
      aria-label="Parent"
      items={items}
      selectedKeys={value ? [value.key] : []}
      query={query}
      onQueryChange={onQueryChange}
      search={{ placeholder: 'Parent task…', filter: false }}
      emptyText={readOnly ? 'No parent' : results ? 'No open task matches' : 'Searching…'}
      before={readOnly ? <ReadOnlyLine>{readOnlyText}</ReadOnlyLine> : undefined}
      onAction={(id) => {
        if (readOnly) return;
        if (id === NO_PARENT) return onChange(null);
        const picked = found.find((item) => item.key === id);
        if (picked) onChange(picked);
      }}
      footer={{
        hints: readOnly
          ? READ_ONLY_HINTS
          : [
              { keys: '↵', label: 'pick' },
              { keys: 'Esc', label: 'close' },
            ],
        ...(projectName ? { end: `Only tasks in ${projectName}` } : {}),
      }}
      onClose={onClose}
      autoFocus={autoFocus}
    />
  );
}

const isFullTask = (target: FieldTarget): target is Task => 'createdBy' in target;

function ParentPickerContent({ target, close }: { target: FieldTarget; close: () => void }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [refusals, setRefusals] = useState<Map<string, string>>(() => new Map());
  // Rows know their parent's key and their subtask count; the detail (cached in the task view) knows more.
  const detail = useQuery({ ...taskQuery(api, target.key), enabled: !isFullTask(target) }).data;
  const task = detail ?? (isFullTask(target) ? target : undefined);
  const search = useTaskSearch(target.project.key, query, { topLevel: true });
  const { apply } = useFieldChange();
  /** A pick waits for the server, so a refusal can show under it; the menu closes once it's saved. */
  const saving = useRef(false);
  const parent: ParentValue | null = task?.parent
    ? task.parent
    : 'parentKey' in target && target.parentKey
      ? { key: target.parentKey }
      : null;
  const hasSubtasks = task
    ? (task.subtasks?.length ?? 0) > 0
    : ((target as TaskListItem).subtaskProgress?.total ?? 0) > 0;
  return (
    <ParentMenu
      task={{ key: target.key, hasSubtasks }}
      value={parent}
      results={search.data?.items}
      query={query}
      onQueryChange={setQuery}
      refusals={refusals}
      projectName={target.project.name}
      readOnly={isFieldLocked([target], 'parent')}
      onClose={() => {
        if (!saving.current) close();
      }}
      onChange={(next) => {
        if (next?.key === parent?.key) return close();
        saving.current = true;
        let refused = false;
        void apply(
          [task ?? target],
          { parent: next ? relatedOf(next) : null },
          {
            onError: (error) => {
              const refusal = next ? parentRefusal(error, next.key) : null;
              if (!refusal || !next) return false;
              refused = true;
              setRefusals((previous) => new Map(previous).set(next.key, refusal));
              return true;
            },
          },
        ).then(() => {
          saving.current = false;
          // Saved, or refused for a reason the toast gives: done. An inline refusal keeps it open.
          if (!refused) close();
        });
      }}
    />
  );
}

/** Sets or clears one task's parent. Opens read-only on mirrored tasks. */
export function ParentPicker({ targets, ...anchor }: FieldPickerProps) {
  const target = toTargets(targets)[0];
  if (!target) return null;
  return (
    <FieldPopover label="Parent" width={420} {...anchor}>
      {(close) => <ParentPickerContent target={target} close={close} />}
    </FieldPopover>
  );
}
