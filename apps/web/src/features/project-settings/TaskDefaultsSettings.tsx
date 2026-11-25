// Project settings, Task defaults (M6 frames 025 to 027): the definition-of-done items every new task in
// the project starts with. Owners and admins add, reword in place, remove (with Undo) and reorder them, by
// dragging the grip or with Alt+↑ / Alt+↓ on a focused line. Each edit saves the whole list at once, and the
// page says that only new tasks are affected. Members read the list. A project that still mirrors
// Backlog.md creates no task here, so its defaults wait for the switch to Zamu.

import { useQuery } from '@tanstack/react-query';
import { MAX_WORK_ITEM_LENGTH, MAX_WORK_ITEMS } from '@zamu/contracts';
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { isMirrored, useProjectSummary } from '~/features/project-header';
import { meQuery } from '~/features/projects/queries';
import { isAdminRole } from '~/features/settings/format';
import {
  Banner,
  Button,
  CloseGlyph,
  cn,
  EmptyState,
  GripGlyph,
  Kbd,
  PlusGlyph,
  Skeleton,
  TextField,
  Toast,
} from '~/ui';
import { SettingsPage } from './ProjectSettingsLayout';
import { useSaveDefaultDoneItems } from './queries';
import {
  appliesText,
  cleanItem,
  defaultsFailure,
  itemError,
  movedText,
  moveItem,
  moveItemTo,
} from './task-defaults';

/** The Task defaults page wired to the API. */
export function TaskDefaultsSettings({ projectKey }: { projectKey: string }) {
  const project = useProjectSummary(projectKey);
  const me = useQuery(meQuery());
  const save = useSaveDefaultDoneItems(projectKey);
  // The list as last edited, shown until the save that carries it comes back; saves run one after another
  // so the server ends on the last edit.
  const [draft, setDraft] = useState<string[] | null>(null);
  const latest = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const onChange = async (next: string[]) => {
    const id = ++latest.current;
    setDraft(next);
    const run = queue.current.then(() => save.mutateAsync(next));
    queue.current = run.catch(() => undefined);
    try {
      await run;
    } finally {
      if (id === latest.current) setDraft(null);
    }
  };

  return (
    <TaskDefaultsView
      projectName={project?.name ?? projectKey}
      items={draft ?? (project ? (project.defaultDoneItems ?? []) : undefined)}
      openCount={project?.openCount}
      canEdit={isAdminRole(me.data?.role)}
      mirrored={isMirrored(project)}
      onChange={onChange}
    />
  );
}

export interface TaskDefaultsViewProps {
  projectName: string;
  /** undefined while loading. */
  items: readonly string[] | undefined;
  /** Open tasks of the project, for "40 open tasks keep the items they have". */
  openCount?: number;
  /** Owners and admins. */
  canEdit: boolean;
  /** The project still reads Backlog.md: the defaults apply once it is switched to Zamu. */
  mirrored?: boolean;
  /** Saves the whole list; rejects with the API error. */
  onChange: (items: string[]) => Promise<void>;
}

/** What the list is doing: rewording a line, or adding one at the end. */
type Mode = { kind: 'edit'; index: number } | { kind: 'add' } | null;

export function TaskDefaultsView({
  projectName,
  items,
  openCount,
  canEdit,
  mirrored = false,
  onChange,
}: TaskDefaultsViewProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [removed, setRemoved] = useState<{ text: string; index: number; key: number } | null>(null);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The line to focus once the list shows `text` at `index` (after a move, a removal or a reword).
  const pendingFocus = useRef<{ index: number; text: string | undefined } | null>(null);

  const list = items ?? [];
  const activeIndex = Math.min(active, Math.max(list.length - 1, 0));
  const full = list.length >= MAX_WORK_ITEMS;

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || mode !== null) return;
    if (pending.text !== undefined && list[pending.index] !== pending.text) return;
    pendingFocus.current = null;
    const index = Math.min(pending.index, list.length - 1);
    if (index >= 0) {
      setActive(index);
      lineRefs.current[index]?.focus();
    }
  });
  const focusLater = (index: number, text: string | undefined) => {
    pendingFocus.current = { index, text };
  };
  const keys = lineKeys(list);

  const save = (next: string[], failure = "Couldn't save the task defaults.") => {
    setError(null);
    return onChange(next).catch((cause: unknown) => {
      pendingFocus.current = null;
      setError(`${failure} ${defaultsFailure(cause)}`);
      throw cause;
    });
  };

  const move = (index: number, to: number) => {
    const text = list[index];
    if (text === undefined || to < 0 || to >= list.length || to === index) return;
    const next =
      Math.abs(to - index) === 1 ? moveItem(list, index, to > index ? 1 : -1) : moveItemTo(list, index, to);
    focusLater(to, text);
    setAnnouncement(movedText(text, to + 1, list.length));
    save(next, "Couldn't move the item.").catch(() => undefined);
  };

  const remove = (index: number) => {
    const text = list[index];
    if (text === undefined) return;
    const rest = list.filter((_, at) => at !== index);
    const next = index < rest.length ? index : index - 1;
    focusLater(next, rest[next]);
    save(rest, `Couldn't remove “${text}”.`).then(
      () => setRemoved({ text, index, key: Date.now() }),
      () => undefined,
    );
  };

  const undoRemove = () => {
    if (!removed) return;
    const next = [...list];
    next.splice(Math.min(removed.index, next.length), 0, removed.text);
    setRemoved(null);
    save(next, `Couldn't put “${removed.text}” back.`).catch(() => undefined);
  };

  const onLineKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!canEdit || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const plain = !event.altKey && !event.shiftKey;
    let handled = true;
    if ((key === 'ArrowUp' || key === 'ArrowDown') && event.altKey && !event.shiftKey) {
      move(index, index + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'ArrowDown' && plain) {
      focusLine(Math.min(index + 1, list.length - 1));
    } else if (key === 'ArrowUp' && plain) {
      focusLine(Math.max(index - 1, 0));
    } else if (key === 'e' && plain) {
      setMode({ kind: 'edit', index });
    } else if ((key === 'Backspace' || key === 'Delete') && plain) {
      remove(index);
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  };

  const focusLine = (index: number) => {
    setActive(index);
    lineRefs.current[index]?.focus();
  };

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (from !== null) move(from, index);
  };

  const empty = items !== undefined && list.length === 0 && mode?.kind !== 'add';

  return (
    <SettingsPage title="Task defaults" description={`What every new task in ${projectName} starts with.`}>
      <section
        aria-labelledby="task-defaults-dod"
        className="flex flex-col gap-3 border-t border-line-soft pt-5"
      >
        <h3 id="task-defaults-dod" className="m-0 text-md font-semibold text-fg">
          Definition of done
        </h3>
        <p className="m-0 max-w-160 leading-prose text-pretty text-fg-2">
          The checks every task must pass before it is finished, whatever the task is about. New tasks start
          with these items; tasks that already exist keep theirs. An agent can leave them out when a task
          changes no code.
        </p>
        {mirrored ? (
          <Banner tone="note">
            {projectName} copies its tasks from Backlog.md, so no task starts here yet. These items apply once
            it is switched to Zamu.
          </Banner>
        ) : null}
        {error ? (
          <Banner
            action={
              <Button variant="secondary" size="sm" onPress={() => setError(null)}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Banner>
        ) : null}
        {items === undefined ? (
          <LoadingList />
        ) : empty ? (
          <div className="rounded-md border border-line-soft bg-surface">
            <EmptyState
              align="center"
              title="No default items"
              text="Add the checks you would otherwise repeat on every task, such as “Tests and lint pass”."
              action={canEdit ? <Button onPress={() => setMode({ kind: 'add' })}>Add an item</Button> : null}
              className="py-8.5"
            />
          </div>
        ) : (
          <div className="rounded-md border border-line-soft bg-surface">
            {list.length ? (
              <ul aria-label="Default done items" className="m-0 list-none p-0">
                {list.map((text, index) =>
                  mode?.kind === 'edit' && mode.index === index && canEdit ? (
                    <li
                      key={keys[index]}
                      className="flex min-h-10.5 items-center gap-2.5 border-b border-line-soft py-1.5 pr-2.5 pl-3 last:border-b-0"
                    >
                      <GripGlyph className="text-fg-3" />
                      <ItemEditor
                        initial={text}
                        label={`Reword “${text}”`}
                        submitLabel="Save"
                        check={(value) => itemError(list, value, index)}
                        onSubmit={async (value) => {
                          if (value !== text) {
                            const next = [...list];
                            next[index] = value;
                            await save(next, `Couldn't reword “${text}”.`);
                          }
                          setMode(null);
                          focusLater(index, value);
                        }}
                        onCancel={() => {
                          setMode(null);
                          focusLater(index, text);
                        }}
                      />
                    </li>
                  ) : (
                    <li
                      key={keys[index]}
                      draggable={canEdit && mode === null}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', text);
                        setDragging(index);
                      }}
                      onDragOver={(event) => {
                        if (dragging === null) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setOver(index);
                      }}
                      onDragLeave={() => setOver((current) => (current === index ? null : current))}
                      onDrop={(event) => onDrop(event, index)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      className={cn(
                        'group/row relative flex min-h-10.5 items-center gap-2.5 border-b border-line-soft pr-2.5 pl-3 last:border-b-0',
                        'hover:bg-bg-grp has-[[data-line]:focus-visible]:z-1 has-[[data-line]:focus-visible]:rounded-sm has-[[data-line]:focus-visible]:bg-bg-grp has-[[data-line]:focus-visible]:shadow-[var(--focus-ring)]',
                        dragging === index && 'opacity-50',
                        over !== null &&
                          over === index &&
                          dragging !== null &&
                          dragging !== index &&
                          (dragging < index
                            ? 'shadow-[inset_0_-2px_0_var(--accent)]'
                            : 'shadow-[inset_0_2px_0_var(--accent)]'),
                      )}
                    >
                      {canEdit ? <GripGlyph className="cursor-grab text-fg-3" /> : null}
                      {canEdit ? (
                        // The words are a button that rewords the line (Enter, E or a click); the other
                        // keys of the line live on it too.
                        <button
                          type="button"
                          ref={(element) => {
                            lineRefs.current[index] = element;
                          }}
                          data-line
                          tabIndex={index === activeIndex ? 0 : -1}
                          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown E Backspace Delete"
                          aria-describedby="task-defaults-keys"
                          onFocus={() => setActive(index)}
                          onKeyDown={(event) => onLineKeyDown(event, index)}
                          onClick={() => setMode({ kind: 'edit', index })}
                          className="min-w-0 flex-1 cursor-text border-0 bg-transparent p-0 py-2.5 text-left font-medium text-pretty text-fg outline-none"
                        >
                          {text}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 py-2.5 font-medium text-pretty text-fg">{text}</span>
                      )}
                      {canEdit ? (
                        <span className="flex items-center gap-0.5 text-fg-3 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label={`Edit “${text}”`}
                            onPress={() => setMode({ kind: 'edit', index })}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            iconOnly
                            aria-label={`Remove “${text}”`}
                            onPress={() => remove(index)}
                          >
                            <CloseGlyph />
                          </Button>
                        </span>
                      ) : null}
                    </li>
                  ),
                )}
              </ul>
            ) : null}
            {canEdit && mode?.kind === 'add' ? (
              <div
                className={cn(
                  'flex min-h-10.5 items-center gap-2.5 py-1.5 pr-2.5 pl-3',
                  list.length > 0 && 'border-t border-line-soft',
                )}
              >
                <PlusGlyph className="size-2.25 text-fg-3" />
                <ItemEditor
                  initial=""
                  label="New default item"
                  placeholder="Tests and lint pass"
                  submitLabel="Add"
                  keepOpen
                  check={(value) => itemError(list, value, null)}
                  onSubmit={(value) => save([...list, value], `Couldn't add “${value}”.`)}
                  onCancel={() => setMode(null)}
                />
              </div>
            ) : canEdit && !full ? (
              <AriaButton
                onPress={() => setMode({ kind: 'add' })}
                className={cn(
                  'flex h-8.5 w-full cursor-pointer items-center gap-2 rounded-b-md px-3 text-left text-sm text-fg-3 outline-none hover:bg-bg-grp hover:text-fg-2 focus-visible:focus-ring-inset',
                  list.length > 0 && 'border-t border-line-soft',
                )}
              >
                <PlusGlyph className="size-2.25" />
                Add an item
              </AriaButton>
            ) : null}
          </div>
        )}
        {list.length > 0 ? (
          <p className="m-0 text-xs leading-normal text-fg-3">{appliesText(openCount)}</p>
        ) : null}
        {canEdit && full ? (
          <p className="m-0 text-xs leading-normal text-fg-3">
            A project can have {MAX_WORK_ITEMS} default items at most.
          </p>
        ) : null}
        {!canEdit && items !== undefined ? (
          <p className="m-0 text-xs leading-normal text-fg-3">
            Only owners and admins can change the defaults.
          </p>
        ) : null}
        <span id="task-defaults-keys" hidden>
          Alt+Up and Alt+Down move it, E rewords it, Delete removes it.
        </span>
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </section>
      {removed ? (
        <div className="fixed bottom-5.5 left-1/2 z-40 -translate-x-1/2">
          <Toast
            key={removed.key}
            timeout={6000}
            onDismiss={() => setRemoved(null)}
            action={{ label: 'Undo', onAction: undoRemove }}
          >
            Removed “{removed.text}”
          </Toast>
        </div>
      ) : null}
    </SettingsPage>
  );
}

/** React keys for the lines: the text, numbered when it repeats, so a moved line keeps its element. */
function lineKeys(items: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return items.map((text) => {
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return count ? `${text}#${count}` : text;
  });
}

/**
 * The field of a line being reworded or added (frame 027): Enter saves, Esc cancels, an error shows
 * under it. `keepOpen` (adding) empties the field after a save for the next line.
 */
function ItemEditor({
  initial,
  label,
  placeholder,
  submitLabel,
  keepOpen = false,
  check,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  keepOpen?: boolean;
  check: (value: string) => string | null;
  onSubmit: (value: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    const clean = cleanItem(value);
    if (!clean) {
      onCancel();
      return;
    }
    const problem = check(clean);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(clean);
      if (keepOpen) setValue('');
    } catch {
      // The page's banner says what went wrong; the text stays to try again.
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5">
      <TextField
        aria-label={label}
        autoFocus
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        maxLength={MAX_WORK_ITEM_LENGTH}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        isInvalid={error !== null}
        errorMessage={error}
        validationBehavior="aria"
        className="min-w-0 flex-1"
        inputClassName="h-7.5"
      />
      <Button variant="secondary" size="sm" className="mt-0.5" onPress={onCancel}>
        Cancel
      </Button>
      <Button size="sm" className="mt-0.5" onPress={() => void submit()} isPending={pending}>
        {submitLabel}
        <Kbd aria-hidden className="ml-1">
          ↵
        </Kbd>
      </Button>
    </div>
  );
}

function LoadingList() {
  return (
    <div aria-busy className="rounded-md border border-line-soft bg-surface">
      {[180, 140, 220].map((width) => (
        <div
          key={width}
          className="flex h-10.5 items-center gap-2.5 border-b border-line-soft px-3 last:border-b-0"
        >
          <Skeleton width={6} />
          <Skeleton width={width} />
        </div>
      ))}
    </div>
  );
}
