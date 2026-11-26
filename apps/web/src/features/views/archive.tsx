import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { type Command, useRegisterCommands } from '~/features/palette/registry';
import { usePeek } from '~/features/peek/store';
import { isMirroredTarget } from '~/features/task-fields/targets';
import { showFieldToast } from '~/features/task-fields/toast';
import { MIRRORED_ARCHIVE_TEXT, useArchiveActions } from '~/features/tasks/archive';
import { type CachedTask, cachedTask } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { ArchiveGlyph, Button, useHotkeys } from '~/ui';
import { getCurrentTaskSelection, useCurrentTaskSelection } from './selection';

// Archiving from lists, boards and Home (M7, frames 084 and 085; shortcuts.md M7): Shift+E archives the
// selected tasks, or the focused one, and restores them when they are all archived already. The toast
// says what happened with Undo, and ⌘Z undoes while it shows (tasks/archive.ts). The view publishes its
// selection (useCurrentTaskSelection), so the shell mounts <ArchiveKeys /> once and every view gets the
// key and the palette command without wiring. The task view binds its own Shift+E; the peek has none.
// <ArchiveSelectionButton> is the action bar's Archive (frame 084).

/** What Shift+E does for these tasks: archive them, restore them, or refuse (mirrored projects). */
export type ArchiveIntent =
  | { kind: 'archive'; keys: string[] }
  | { kind: 'restore'; keys: string[] }
  | { kind: 'refuse'; text: string }
  | { kind: 'none' };

/**
 * Archive the ones not archived yet; restore when every one is archived. A task of a mirrored project
 * refuses the lot: Backlog.md's archive folder decides. Tasks not in any cache are archived.
 */
export function archiveIntent(
  keys: readonly string[],
  lookup: (key: string) => Pick<CachedTask, 'archivedAt' | 'locked'> | undefined,
): ArchiveIntent {
  if (keys.length === 0) return { kind: 'none' };
  const tasks = keys.map((key) => ({ key, task: lookup(key) }));
  if (tasks.some(({ task }) => task && isMirroredTarget(task as CachedTask))) {
    return { kind: 'refuse', text: MIRRORED_ARCHIVE_TEXT };
  }
  const archived = (task: { archivedAt?: string | null } | undefined) => task?.archivedAt != null;
  if (tasks.every(({ task }) => archived(task))) return { kind: 'restore', keys: [...keys] };
  return { kind: 'archive', keys: tasks.filter(({ task }) => !archived(task)).map(({ key }) => key) };
}

/** Runs an intent through tasks/archive.ts. */
function useRunIntent() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { archive, restore, isPending } = useArchiveActions();
  const intentFor = (keys: readonly string[]) =>
    archiveIntent(keys, (key) => cachedTask(api, queryClient, key));
  const run = (keys: readonly string[]) => {
    const intent = intentFor(keys);
    if (intent.kind === 'refuse') showFieldToast({ text: intent.text, tone: 'error' });
    else if (intent.kind === 'archive') void archive(intent.keys);
    else if (intent.kind === 'restore') void restore(intent.keys);
  };
  return { run, intentFor, isPending };
}

/** "Archive" or "Restore" for the selection or focused task: Shift+E and a palette command. */
export function ArchiveKeys() {
  const selection = useCurrentTaskSelection();
  const peekOpen = usePeek() != null;
  const { run, intentFor } = useRunIntent();
  // The palette command keeps one identity per title; it runs the latest action on the latest selection.
  const runRef = useRef(run);
  runRef.current = run;
  const keys = selection.targetKeys;
  const active = selection.view != null && keys.length > 0 && !peekOpen;

  useHotkeys({
    'Shift+e': active ? () => run(getCurrentTaskSelection().targetKeys) : null,
  });

  const kind = active ? intentFor(keys).kind : 'none';
  const context = keys.length === 1 ? keys[0] : `${keys.length} selected`;
  const commands = useMemo<Command[]>(
    () =>
      active && kind !== 'none'
        ? [
            {
              id: 'task.archive',
              title: kind === 'restore' ? 'Restore' : 'Archive',
              section: 'task',
              keywords: kind === 'restore' ? ['unarchive', 'archived'] : ['archived', 'hide', 'remove'],
              shortcut: 'Shift+e',
              icon: <ArchiveGlyph />,
              ...(context ? { context } : {}),
              ...(kind === 'refuse' ? { disabledReason: MIRRORED_ARCHIVE_TEXT } : {}),
              run: () => {
                runRef.current(getCurrentTaskSelection().targetKeys);
                return undefined;
              },
            },
          ]
        : [],
    [active, kind, context],
  );
  useRegisterCommands(commands);
  return null;
}

/**
 * The action bar's Archive (frame 084): "Archive ⇧E" for the selection, "Restore ⇧E" when every
 * selected task is archived. Mirrored projects leave it out (Backlog.md decides).
 */
export function ArchiveSelectionButton({ keys }: { keys: readonly string[] }) {
  const { run, intentFor, isPending } = useRunIntent();
  const intent = intentFor(keys);
  if (intent.kind === 'none' || intent.kind === 'refuse') return null;
  return (
    <Button variant="quiet" kbd="⇧E" isPending={isPending} onPress={() => run(keys)}>
      <ArchiveGlyph />
      {intent.kind === 'restore' ? 'Restore' : 'Archive'}
    </Button>
  );
}
