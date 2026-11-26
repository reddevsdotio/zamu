import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { TaskListItem } from '@zamu/contracts';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Dialog as AriaDialog } from 'react-aria-components';
import { taskHref } from '~/features/shell/paths';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import {
  ArchivedTag,
  CheckGlyph,
  cn,
  highlightMatch,
  Kbd,
  KeyHint,
  Modal,
  Pill,
  StatusGlyph,
  type TaskStatus,
} from '~/ui';
import { commandMatches, commandScore, SECTION_ORDER, SECTION_TITLES, shortcutChips } from './format';
import { useRecentTasks } from './recent';
import {
  type Command,
  closePalette,
  type PaletteOpenMode,
  type PaletteStep,
  usePaletteOpen,
  useRegisteredCommands,
} from './registry';

/*
 * The ⌘K palette (frames 089–096; margin.css .pal, .pal-ctx, .pal-in, .pal-h, .pal-i, .pal-ft).
 *
 *   [HBR-146 · Long French and Spanish labels…]   context pill: who the task actions apply to
 *   [Set status] Pick a status…                   crumb of the current step, then the input
 *   Recent / Suggested, or Tasks / Projects / commands for the typed text, or the step's commands
 *   ↑ ↓ move   ↵ open   ⌫ back   Esc close                       3 tasks · 0 projects
 *
 * Commands come from the registry (registry.ts): the shell's built-ins (pages, projects, create, theme,
 * sidebar, shortcuts) and whatever the current screen registers for its selection. Tasks are searched
 * by key or title through tasks.list with q; archived tasks (M7, frame 086) are asked for separately
 * (archived: only), come after the others with the Archived tag, and bring "Show archived tasks in
 * <project>" under Actions when the shell registered it for the project on screen. A command may answer with a step (Set status → the six
 * statuses); Backspace in the empty input backs out of it. G then P opens it filtered to projects.
 *
 * The list is a listbox driven from the input (aria-activedescendant), so focus never leaves the input.
 */

/** Ids of project commands ("Go to Payments"), registered by the shell; G then P shows only these. */
export const PROJECT_COMMAND_PREFIX = 'navigate.project.';

/** Id prefix of "Show archived tasks in <project>" (the shell's); offered under Actions next to archived results. */
export const ARCHIVED_COMMAND_PREFIX = 'navigate.archived.';

const ROOT_PLACEHOLDER = 'Type a command, or search tasks and projects…';
const SEARCH_DEBOUNCE_MS = 150;
const TASK_RESULTS = 8;

interface PaletteItem {
  id: string;
  /** Plain text: the option's accessible name. */
  label: string;
  title: ReactNode;
  icon?: ReactNode;
  taskKey?: string;
  /** M7: an archived task: a quieter title and the Archived tag. */
  archived?: boolean;
  hint?: string;
  chips?: readonly string[];
  checked?: boolean;
  disabledReason?: string;
  /** The command behind the item; tasks open directly. */
  command?: Command;
  open?: () => void;
}

interface PaletteSection {
  id: string;
  title?: string;
  items: PaletteItem[];
}

interface StepEntry {
  step: PaletteStep;
  /** The context pill of the step: the command's `context`. */
  context?: string;
}

export interface CommandPaletteProps {
  /** Whose Recent tasks to show: the signed-in person in this workspace (`<userId>:<workspaceId>`). */
  userId?: string;
  /** Command ids shown under Suggested on the empty palette, in order; missing ones are skipped. */
  suggested?: readonly string[];
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function commandItem(command: Command, query = ''): PaletteItem {
  return {
    id: `cmd:${command.id}`,
    label: command.title,
    title: highlightMatch(command.title, query),
    icon: command.icon,
    hint: command.hint,
    chips: shortcutChips(command.shortcut),
    checked: command.checked,
    disabledReason: command.disabledReason,
    command,
  };
}

function taskItem(
  task: { key: string; title: string; status: TaskStatus; projectName: string; archived?: boolean },
  open: () => void,
  query = '',
  prefix = 'task',
): PaletteItem {
  return {
    id: `${prefix}:${task.key}`,
    label: task.archived ? `${task.key} ${task.title}, archived` : `${task.key} ${task.title}`,
    title: highlightMatch(task.title, query),
    icon: <StatusGlyph status={task.status} decorative />,
    taskKey: task.key,
    hint: task.projectName,
    ...(task.archived ? { archived: true } : {}),
    open,
  };
}

/**
 * Search results in the palette's order: live tasks first, then archived ones (core doesn't sort them,
 * so they come from their own request). A task in both answers (archived meanwhile) shows once, archived.
 */
export function orderSearchResults(
  live: readonly TaskListItem[],
  archived: readonly TaskListItem[],
): { task: TaskListItem; archived: boolean }[] {
  const archivedKeys = new Set(archived.map((task) => task.key));
  return [
    ...live
      .filter((task) => !archivedKeys.has(task.key) && task.archivedAt == null)
      .map((task) => ({ task, archived: false })),
    ...archived.map((task) => ({ task, archived: true })),
  ];
}

/** Commands grouped by section in display order, best matches first within a section. */
function groupCommands(commands: readonly Command[], query: string): PaletteSection[] {
  const sections: PaletteSection[] = [];
  for (const section of SECTION_ORDER) {
    const matching = commands
      .filter((command) => command.section === section && commandMatches(command, query))
      .map((command, index) => ({ command, index, score: commandScore(command, query) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ command }) => commandItem(command, query));
    if (matching.length) sections.push({ id: section, title: SECTION_TITLES[section], items: matching });
  }
  return sections;
}

/** Mounts the palette. The shell renders it once; openPalette() shows it. */
export function CommandPalette(props: CommandPaletteProps) {
  const mode = usePaletteOpen();
  return (
    <Modal
      isOpen={mode != null}
      onOpenChange={(open) => !open && closePalette()}
      width={660}
      top={96}
      className="overflow-hidden"
    >
      {mode ? <PalettePanel mode={mode} {...props} /> : null}
    </Modal>
  );
}

function PalettePanel({ mode, userId, suggested = [] }: CommandPaletteProps & { mode: PaletteOpenMode }) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const router = useRouter();
  const registered = useRegisteredCommands();
  const recent = useRecentTasks(userId);
  const [stack, setStack] = useState<StepEntry[]>(() => (mode.kind === 'step' ? [{ step: mode.step }] : []));
  const [projectsOnly, setProjectsOnly] = useState(mode.kind === 'projects');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A new openPalette() while open (G then P, a fallback step) starts over in its mode.
  const [shownMode, setShownMode] = useState(mode);
  if (shownMode !== mode) {
    setShownMode(mode);
    setStack(mode.kind === 'step' ? [{ step: mode.step }] : []);
    setProjectsOnly(mode.kind === 'projects');
    setQuery('');
  }

  const top = stack.at(-1);
  const trimmed = query.trim();
  const searching = !top && !projectsOnly && trimmed.length > 0;
  const debounced = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);
  const tasks = useQuery({
    ...api.orpc.tasks.list.queryOptions({ input: { q: debounced, limit: TASK_RESULTS } }),
    enabled: searching && debounced.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const archivedTasks = useQuery({
    ...api.orpc.tasks.list.queryOptions({ input: { q: debounced, archived: 'only', limit: TASK_RESULTS } }),
    enabled: searching && debounced.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  // While a newer search is on its way the last answer stays, narrowed to what still matches the text,
  // so Enter right after typing never opens a task from an older search.
  const stillMatches = (task: TaskListItem) =>
    commandMatches(
      { title: `${task.key} ${task.title}`, keywords: task.backlogId ? [task.backlogId] : [] },
      trimmed,
    );
  const taskResults =
    searching && debounced
      ? orderSearchResults(
          (tasks.data?.items ?? []).filter(stillMatches),
          (archivedTasks.data?.items ?? []).filter(stillMatches),
        )
      : [];
  const hasArchivedResults = taskResults.some((result) => result.archived);

  const openTask = (key: string) => () => {
    closePalette();
    void router.navigate({ href: taskHref(workspace, key) });
  };

  const taskCommands = registered.filter((command) => command.section === 'task');
  const rootContext = taskCommands.find((command) => command.context)?.context;
  const context = top ? top.context : rootContext;
  const projectCommands = registered.filter((command) => command.id.startsWith(PROJECT_COMMAND_PREFIX));

  const sections = ((): PaletteSection[] => {
    if (top) {
      const items = top.step.commands
        .filter((command) => commandMatches(command, trimmed))
        .map((command) => commandItem(command, trimmed));
      return [{ id: 'step', items }];
    }
    if (projectsOnly) {
      const items = projectCommands
        .filter((command) => commandMatches(command, trimmed))
        .map((command) => commandItem(command, trimmed));
      return [{ id: 'projects', title: 'Projects', items }];
    }
    if (!trimmed) {
      const list: PaletteSection[] = [];
      if (taskCommands.length) {
        list.push({ id: 'task', title: SECTION_TITLES.task, items: taskCommands.map((c) => commandItem(c)) });
      }
      if (recent.length) {
        list.push({
          id: 'recent',
          title: 'Recent',
          items: recent.map((task) => taskItem(task, openTask(task.key), '', 'recent')),
        });
      }
      const byId = new Map(registered.map((command) => [command.id, command]));
      const picks = suggested.flatMap((id) => {
        const command = byId.get(id);
        return command ? [commandItem(command)] : [];
      });
      if (picks.length) list.push({ id: 'suggested', title: 'Suggested', items: picks });
      return list;
    }
    const list: PaletteSection[] = [];
    if (taskResults.length) {
      list.push({
        id: 'tasks',
        title: 'Tasks',
        items: taskResults.map(({ task, archived }) =>
          taskItem(
            {
              key: task.key,
              title: task.title,
              status: task.status,
              projectName: task.project.name,
              archived,
            },
            openTask(task.key),
            trimmed,
          ),
        ),
      });
    }
    const projects = projectCommands
      .filter((command) => commandMatches(command, trimmed))
      .map((command) => commandItem(command, trimmed));
    if (projects.length) list.push({ id: 'projects', title: 'Projects', items: projects });
    const grouped = groupCommands(
      registered.filter((command) => !command.id.startsWith(PROJECT_COMMAND_PREFIX)),
      trimmed,
    );
    list.push(...grouped);
    // Archived results bring "Show archived tasks in Payments" under Actions (frame 086), unless the
    // typed text already lists it.
    const archivedCommand = hasArchivedResults
      ? registered.find((command) => command.id.startsWith(ARCHIVED_COMMAND_PREFIX))
      : undefined;
    const listed = grouped.some((section) =>
      section.items.some((item) => item.command?.id === archivedCommand?.id),
    );
    // Last, so Enter on a typed command name still runs that command (frame 090).
    const actions: PaletteItem[] =
      archivedCommand && !listed
        ? [{ ...commandItem(archivedCommand), id: `action:${archivedCommand.id}` }]
        : [];
    actions.push(
      ...registered.flatMap((command): PaletteItem[] => {
        const withText = command.withText;
        if (!withText) return [];
        const label = withText.title(trimmed);
        return [
          {
            id: `text:${command.id}`,
            label,
            title: label,
            icon: command.icon,
            chips: shortcutChips(command.shortcut),
            disabledReason: command.disabledReason,
            open: () => {
              closePalette();
              withText.run(trimmed);
            },
          },
        ];
      }),
    );
    if (actions.length) list.push({ id: 'actions', title: 'Actions', items: actions });
    return list;
  })();

  const items = sections.flatMap((section) => section.items);

  // The first item is highlighted whenever the list changes (typing, a step, new task results).
  const itemIds = items.map((item) => item.id).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a different list, not on every render
  useLayoutEffect(() => setActive(0), [itemIds]);

  const activeItem = items[Math.min(active, items.length - 1)];
  const optionId = (item: PaletteItem) => `${listId}-${item.id}`;
  const activeOptionId = activeItem ? optionId(activeItem) : undefined;

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  const run = async (item: PaletteItem | undefined) => {
    if (!item || item.disabledReason || pending) return;
    if (item.open) {
      item.open();
      return;
    }
    const command = item.command;
    if (!command) return;
    const outcome = command.run();
    let result: undefined | PaletteStep;
    if (outcome instanceof Promise) {
      setPending(true);
      try {
        result = await outcome;
      } finally {
        setPending(false);
      }
    } else {
      result = outcome;
    }
    if (result) {
      setStack((current) => [...current, { step: result, context: command.context ?? context }]);
      setProjectsOnly(false);
      setQuery('');
      inputRef.current?.focus();
    } else {
      closePalette();
    }
  };

  const back = () => {
    if (stack.length) setStack((current) => current.slice(0, -1));
    else if (projectsOnly) setProjectsOnly(false);
    else return false;
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + step + items.length) % items.length);
      return;
    }
    if (event.key === 'Home' && items.length && !query) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End' && items.length && !query) {
      event.preventDefault();
      setActive(items.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void run(activeItem);
      return;
    }
    // In a step, a digit on the empty input picks the command with that shortcut (1–6 in Set status).
    if (
      top &&
      query === '' &&
      /^[0-9]$/.test(event.key) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const match = items.find((item) => item.command?.shortcut === event.key);
      if (match) {
        event.preventDefault();
        void run(match);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (back()) event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      closePalette();
    }
  };

  const crumb = top ? top.step.title : projectsOnly ? 'Projects' : undefined;
  const placeholder = top
    ? (top.step.placeholder ?? `${top.step.title}…`)
    : projectsOnly
      ? 'Jump to a project…'
      : ROOT_PLACEHOLDER;
  const canGoBack = stack.length > 0 || projectsOnly;
  const enterText = top ? 'set' : items.length && activeItem?.open ? 'open' : 'run';

  let footerEnd: ReactNode = null;
  if (searching && debounced && hasArchivedResults) {
    footerEnd = 'Archived tasks come last and carry the tag';
  } else if (searching && debounced) {
    const projectCount = sections.find((section) => section.id === 'projects')?.items.length ?? 0;
    footerEnd = `${taskResults.length} ${taskResults.length === 1 ? 'task' : 'tasks'} · ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;
  } else if (!top && !projectsOnly && rootContext) {
    footerEnd = `Actions apply to ${rootContext}`;
  }

  return (
    <AriaDialog
      aria-label="Command palette"
      className="flex max-h-[calc(100dvh-128px)] min-h-0 flex-col outline-none"
    >
      {context ? (
        <div className="flex items-center gap-1.5 px-4.5 pt-2.5">
          <Pill className="max-w-140 truncate" data-testid="palette-context">
            {context}
          </Pill>
        </div>
      ) : null}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line-soft px-4.5">
        {crumb ? <Pill tone="accent">{crumb}</Pill> : null}
        <input
          ref={inputRef}
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
          autoFocus
          role="combobox"
          aria-label={crumb ? `${crumb}: ${placeholder.replace(/…$/, '')}` : 'Command'}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-lg text-fg caret-accent outline-none placeholder:text-fg-3"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={crumb ?? 'Commands and tasks'}
        className="flex min-h-0 flex-col overflow-y-auto px-2 pt-1.5 pb-2"
      >
        {items.length === 0 ? (
          <div className="px-2.5 py-3 text-sm text-fg-3">
            {searching && tasks.isFetching
              ? 'Searching…'
              : trimmed
                ? `Nothing matches “${trimmed}”`
                : 'Nothing here yet'}
          </div>
        ) : null}
        {sections.map((section) =>
          section.items.length ? (
            // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox, not a form fieldset
            <div key={section.id} role="group" aria-label={section.title ?? crumb} className="flex flex-col">
              {section.title ? (
                <div aria-hidden className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-fg-3">
                  {section.title}
                </div>
              ) : null}
              {section.items.map((item) => {
                const isActive = item === activeItem;
                return (
                  // Keys go through the input (aria-activedescendant), so options are not tab stops.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: see above
                  // biome-ignore lint/a11y/useFocusableInteractive: see above
                  <div
                    key={item.id}
                    id={optionId(item)}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={item.disabledReason ? true : undefined}
                    aria-label={item.disabledReason ? `${item.label}. ${item.disabledReason}` : item.label}
                    title={item.disabledReason}
                    data-active={isActive || undefined}
                    onPointerMove={() => {
                      const index = items.indexOf(item);
                      if (index !== active) setActive(index);
                    }}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => void run(item)}
                    className={cn(
                      'flex h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 whitespace-nowrap',
                      isActive && 'bg-bg-lane',
                      item.disabledReason ? 'cursor-default text-fg-3' : 'text-fg',
                    )}
                  >
                    <span aria-hidden className="grid w-4.5 shrink-0 place-items-center text-fg-3">
                      {item.icon ?? null}
                    </span>
                    {item.taskKey ? (
                      <span className="shrink-0 text-xs font-medium text-fg-3 tabular-nums">
                        {item.taskKey}
                      </span>
                    ) : null}
                    <span className={cn('min-w-0 truncate font-medium', item.archived && 'text-fg-3')}>
                      {item.title}
                    </span>
                    <span className="flex-1" />
                    {item.archived ? <ArchivedTag /> : null}
                    {item.disabledReason ? (
                      <span className="shrink-0 truncate text-xs text-fg-3">{item.disabledReason}</span>
                    ) : null}
                    {item.hint ? <span className="shrink-0 text-sm text-fg-3">{item.hint}</span> : null}
                    {item.checked ? (
                      <span className="grid w-3.5 shrink-0 place-items-center text-accent-text">
                        <CheckGlyph />
                      </span>
                    ) : null}
                    {item.chips?.length ? (
                      <span aria-hidden className="flex shrink-0 gap-1">
                        {item.chips.map((chip, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: chips repeat (G G) and never reorder
                          <Kbd key={index}>{chip}</Kbd>
                        ))}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null,
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3.5 border-t border-line-soft px-4.5 py-2.25 text-xs text-fg-3">
        <KeyHint keys={['↑', '↓']}>move</KeyHint>
        <KeyHint keys="↵">{enterText}</KeyHint>
        {canGoBack ? <KeyHint keys="⌫">back</KeyHint> : null}
        <KeyHint keys="Esc">close</KeyHint>
        <span className="flex-1" />
        {footerEnd ? <span className="truncate">{footerEnd}</span> : null}
      </div>
    </AriaDialog>
  );
}
