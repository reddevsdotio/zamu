import { useQuery } from '@tanstack/react-query';
import type { Task, TaskListItem } from '@zamu/contracts';
import { useState } from 'react';
import { relatedOf, taskQuery, useCreateTask } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import {
  Avatar,
  MenuNote,
  MenuTip,
  PickerMenu,
  type PickerMenuItem,
  StatusGlyph,
  UnassignedAvatar,
} from '~/ui';
import { failureText, useFieldChange } from './apply';
import { useTaskSearch } from './BlockerPicker';
import type { FieldPickerProps } from './StatusPicker';
import { FieldPopover, READ_ONLY_HINTS, ReadOnlyLine } from './shared';
import { type FieldTarget, isFieldLocked, toTargets } from './targets';
import { showFieldToast } from './toast';

// Add subtask (frame 076): an existing task of the same project that has no parent and no subtasks of
// its own, or a new one from the typed text with ⌘Enter. New subtasks take the parent's assignee.

export interface SubtaskMenuProps {
  /** The parent-to-be. */
  task: Pick<TaskListItem, 'key' | 'assignee'> & { parentKey: string | null; project: { name: string } };
  results: readonly TaskListItem[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: (task: TaskListItem) => void;
  onCreate: (title: string) => void;
  readOnly?: boolean;
  /** Why it is read-only (defaults to the Backlog.md lock text). */
  readOnlyText?: string;
  onClose?: () => void;
  autoFocus?: boolean;
}

/** "New subtasks are assigned to claude-dev, like PAY-142. You can change it after." */
export function inheritNote(task: Pick<TaskListItem, 'key' | 'assignee'>): string {
  return task.assignee
    ? `New subtasks are assigned to ${task.assignee.name}, like ${task.key}. You can change it after.`
    : `New subtasks start unassigned, like ${task.key}.`;
}

export function SubtaskMenu({
  task,
  results,
  query,
  onQueryChange,
  onAdd,
  onCreate,
  readOnly = false,
  readOnlyText,
  onClose,
  autoFocus,
}: SubtaskMenuProps) {
  const found = (results ?? []).filter(
    (item) =>
      item.key !== task.key &&
      item.key !== task.parentKey &&
      !item.parentKey &&
      (item.subtaskProgress?.total ?? 0) === 0,
  );
  if (task.parentKey) {
    return (
      <PickerMenu
        aria-label="Add subtask"
        items={[]}
        search={false}
        emptyText=""
        onClose={onClose}
        footer={{ hints: READ_ONLY_HINTS }}
      >
        <MenuNote>
          {task.key} is a subtask of {task.parentKey}. Subtasks go one level deep.
        </MenuNote>
      </PickerMenu>
    );
  }
  const items: PickerMenuItem[] = found.map((item) => ({
    id: item.key,
    taskKey: item.key,
    label: item.title,
    lead: <StatusGlyph status={item.status} decorative />,
    trailing: item.assignee ? (
      <Avatar name={item.assignee.name} kind={item.assignee.kind} decorative />
    ) : (
      <UnassignedAvatar decorative />
    ),
    isDisabled: readOnly,
  }));
  const typed = query.trim();
  return (
    <PickerMenu
      aria-label="Add subtask"
      selectionMode="none"
      sections={readOnly ? [] : [{ id: 'existing', title: 'Add an existing task', items }]}
      query={query}
      onQueryChange={onQueryChange}
      onAction={(id) => {
        const item = found.find((candidate) => candidate.key === id);
        if (item && !readOnly) onAdd(item);
      }}
      create={
        readOnly
          ? undefined
          : {
              label: (q) => `Create subtask “${q}”`,
              trigger: 'mod-enter',
              onCreate: (q) => {
                onCreate(q);
                onClose?.();
              },
            }
      }
      search={{ placeholder: 'Search or name a new subtask…', kbd: '⇧S' }}
      emptyText={
        readOnly
          ? 'Subtasks come from Backlog.md'
          : results
            ? 'No task to add. Type a title to create one.'
            : 'Searching…'
      }
      before={readOnly ? <ReadOnlyLine>{readOnlyText}</ReadOnlyLine> : undefined}
      footer={{
        hints: readOnly
          ? READ_ONLY_HINTS
          : [
              { keys: '↵', label: 'add' },
              { keys: '⌘↵', label: 'create' },
            ],
      }}
      onClose={onClose}
      autoFocus={autoFocus}
    >
      {!readOnly && typed ? <MenuTip>{inheritNote(task)}</MenuTip> : null}
    </PickerMenu>
  );
}

const parentKeyOf = (target: FieldTarget): string | null =>
  'createdBy' in target ? ((target as Task).parent?.key ?? null) : (target.parentKey ?? null);

function SubtaskPickerContent({ target, close }: { target: FieldTarget; close: () => void }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  // A row's parentKey is enough; the detail (when cached) has the parent too.
  const detail = useQuery({ ...taskQuery(api, target.key), enabled: false }).data;
  const search = useTaskSearch(target.project.key, query, { topLevel: true });
  const { apply } = useFieldChange();
  const create = useCreateTask();
  const parent = detail ?? target;
  return (
    <SubtaskMenu
      task={{ ...parent, parentKey: parentKeyOf(parent) }}
      results={search.data?.items}
      query={query}
      onQueryChange={setQuery}
      readOnly={isFieldLocked([target], 'subtasks')}
      onClose={close}
      onAdd={(child) => void apply([child], { parent: relatedOf(parent) })}
      onCreate={async (title) => {
        try {
          const task = await create.mutateAsync({ project: target.project.key, title, parent: target.key });
          showFieldToast({ text: `Created ${task.key} under ${target.key}` });
        } catch (error) {
          showFieldToast({ text: failureText(target.key, error), tone: 'error' });
        }
      }}
    />
  );
}

/** Adds a subtask to one task (Shift+S). Opens read-only on mirrored tasks. */
export function SubtaskPicker({ targets, ...anchor }: FieldPickerProps) {
  const target = toTargets(targets)[0];
  if (!target) return null;
  return (
    <FieldPopover label="Add subtask" width={420} {...anchor}>
      {(close) => <SubtaskPickerContent target={target} close={close} />}
    </FieldPopover>
  );
}
