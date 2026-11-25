import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { Home, HomeGroup, HomeGroupKey, HomeItem, HomeTab } from '@zamu/contracts';
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { togglePeek, usePeek } from '~/features/peek/store';
import { usePageSearchRef } from '~/features/shell/page-search';
import { useOptionalQuickCreate } from '~/features/shell/quick-create';
import { useTaskFieldKeys } from '~/features/task-fields';
import { useNow } from '~/features/tasks/clock';
import { describeError } from '~/features/tasks/errors';
import { meQuery } from '~/features/tasks/queries';
import { FilterButton, rememberTaskNavigation, type TaskFilter, useTaskSelection } from '~/features/views';
import {
  Banner,
  Button,
  CheckGlyph,
  EmptyState,
  Kbd,
  SearchField,
  SkeletonRows,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  useHotkeys,
} from '~/ui';
import { AgentCards } from './AgentCards';
import { Deadlines } from './Deadlines';
import { HomeFilterChips, useFilterWanted, useHomeFilterFields } from './filters';
import { agentsLine, greeting, groupHint, groupTitle, longDate, needYouText } from './format';
import { GroupHeader, HomeRow } from './HomeRow';
import { homeQuery } from './queries';
import {
  type HomeFilter,
  type HomeSearch,
  hasHomeFilter,
  homeFilterOf,
  homeFilterSearch,
  homeInput,
  homeTabOf,
} from './search';

// Home (/, frames 099–106): what needs the viewer, grouped by why, across every project. Tabs Mine
// (default), Everyone and Agents with their counts; the deadlines strip on Mine and Everyone; groups
// of Home rows, each task once; agent cards and "Waiting on a person" on Agents; "All clear" when
// nothing waits. Tab and filter live in the URL (?tab=everyone&project=PAY&label=backend).
//
// Keys (shortcuts.md "Lists and boards", "A selected or open task"): J / K and ↓ / ↑ move the focus,
// X selects, Shift+↓ / ↑ extend, ⌘A selects all, Space peeks, Enter opens the task view, and S, P, A,
// I, L, Shift+D … act on the focused or selected tasks.

export interface HomeScreenProps {
  search: HomeSearch;
}

const TABS: readonly { id: HomeTab; label: string }[] = [
  { id: 'mine', label: 'Mine' },
  { id: 'everyone', label: 'Everyone' },
  { id: 'agents', label: 'Agents' },
];

const VIEW_NAME = 'Home';

/** The task last opened from Home: focused again when the person comes back (Esc in the task view). */
let returnFocus: string | null = null;

function matchesText(item: HomeItem, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return item.task.key.toLowerCase().includes(needle) || item.task.title.toLowerCase().includes(needle);
}

interface GroupView {
  group: HomeGroup;
  items: HomeItem[];
}

export function HomeScreen({ search }: HomeScreenProps) {
  const navigate = useNavigate();
  const quickCreate = useOptionalQuickCreate();
  const href = useRouterState({ select: (state) => state.location.href });
  const tab = homeTabOf(search);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is these three params.
  const filter = useMemo(
    () => homeFilterOf(search as Record<string, unknown>),
    [search.project, search.label, search.priority],
  );
  const filtered = hasHomeFilter(filter);
  const input = useMemo(() => homeInput(tab, filter), [tab, filter]);
  const query = useQuery(homeQuery(input));
  const data: Home | undefined = query.data?.tab === tab ? query.data : undefined;
  const me = useQuery(meQuery()).data;
  const viewerId = me?.user.id;
  const firstName = me?.user.name.trim().split(/\s+/)[0] ?? '';
  const workspace = me?.workspace.name ?? 'the workspace';
  const now = useNow();

  // ---- URL ------------------------------------------------------------------------------------------
  const setTab = (next: HomeTab) =>
    navigate({ to: '/', search: { ...search, tab: next === 'mine' ? undefined : next }, replace: true });
  const setFilter = (next: HomeFilter) =>
    navigate({
      to: '/',
      search: { ...(search.tab ? { tab: search.tab } : {}), ...homeFilterSearch(next) },
      replace: true,
    });

  // ---- Rows -----------------------------------------------------------------------------------------
  const [text, setText] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<HomeGroupKey>>(() => new Set());
  const [showAssigned, setShowAssigned] = useState(false);
  const [lastTab, setLastTab] = useState(tab);
  if (lastTab !== tab) {
    setLastTab(tab);
    setShowAssigned(false);
  }

  const assigned = data?.groups.find((group) => group.key === 'assigned');
  const isClear =
    data !== undefined &&
    !filtered &&
    (tab === 'mine'
      ? data.counts.mine === 0 && !showAssigned
      : tab === 'everyone'
        ? data.groups.every((group) => group.total === 0)
        : false);

  const groups = useMemo<GroupView[]>(() => {
    if (!data || isClear) return [];
    return data.groups
      .filter((group) => group.total > 0)
      .map((group) => ({ group, items: group.items.filter((item) => matchesText(item, text)) }))
      .filter((view) => !text.trim() || view.items.length > 0);
  }, [data, isClear, text]);

  const items = useMemo(
    () => groups.filter((view) => !collapsed.has(view.group.key)).flatMap((view) => view.items),
    [groups, collapsed],
  );
  const keys = useMemo(() => items.map((item) => item.task.key), [items]);
  const itemByKey = useMemo(() => new Map(items.map((item) => [item.task.key, item])), [items]);
  const allItems = useMemo(() => groups.flatMap((view) => view.items), [groups]);

  // ---- Focus and selection -------------------------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);
  const peek = usePeek();
  const peekHere = peek?.from === VIEW_NAME;
  const rowOf = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-task-key="${CSS.escape(key)}"]`) ?? null;
  const selection = useTaskSelection(keys, {
    view: VIEW_NAME,
    hotkeys: !peekHere,
    initialFocus: returnFocus,
    onFocusChange: (key) => {
      if (!key) return;
      const show = () => {
        const row = rowOf(key);
        if (!row) return false;
        row.scrollIntoView?.({ block: 'nearest' });
        if (document.activeElement !== row && !isTyping()) row.focus({ preventScroll: true });
        return true;
      };
      if (!show()) requestAnimationFrame(show);
    },
  });
  useEffect(() => {
    returnFocus = null;
  }, []);

  const targets = useMemo(
    () =>
      selection.targetKeys.flatMap((key) => {
        const item = itemByKey.get(key);
        return item ? [item.task] : [];
      }),
    [selection.targetKeys, itemByKey],
  );
  const fieldKeys = useTaskFieldKeys({ targets, enabled: !peekHere, anchors: anchorRef });

  const openTask = useCallback(
    (key: string) => {
      const item = itemByKey.get(key);
      if (!item) return;
      returnFocus = key;
      rememberTaskNavigation({ keys, from: VIEW_NAME, returnTo: href }, key);
      void navigate({
        to: '/p/$projectKey/$taskKey',
        params: { projectKey: item.task.project.key, taskKey: key },
      });
    },
    [itemByKey, keys, href, navigate],
  );

  const focusedKey =
    selection.focusedKey && itemByKey.has(selection.focusedKey) ? selection.focusedKey : null;
  useHotkeys({
    Space: focusedKey
      ? () =>
          togglePeek({
            key: focusedKey,
            keys,
            from: VIEW_NAME,
            onMove: (key) => selection.focus(key),
          })
      : null,
    Enter: {
      enabled: focusedKey != null && !peekHere,
      preventDefault: false,
      handler: (event) => {
        // A focused row (a link) opens itself; buttons and fields keep their own Enter.
        const target = event.target;
        if (focusedKey && (target === document.body || target === document.documentElement)) {
          event.preventDefault();
          openTask(focusedKey);
        }
      },
    },
  });

  const onRowClick = (key: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (selection.handleClick(key, event)) return;
    openTask(key);
  };

  const toggleGroup = (key: HomeGroupKey) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ---- Header ---------------------------------------------------------------------------------------
  const [filterWanted, wantFilter] = useFilterWanted();
  const fields = useHomeFilterFields(filter, allItems, filterWanted);
  const searchRef = usePageSearchRef();
  const counts = query.data?.counts;

  const title =
    tab === 'everyone'
      ? 'Everyone'
      : tab === 'agents'
        ? 'Agents'
        : now == null
          ? ' '
          : greeting(firstName, now);
  const subtitle =
    tab === 'everyone'
      ? `What needs attention across ${workspace}`
      : tab === 'agents'
        ? data
          ? agentsLine(data.agents)
          : ''
        : now == null
          ? ''
          : data && data.counts.mine > 0
            ? `${longDate(now)} · ${needYouText(data.counts.mine)}`
            : longDate(now);

  const loadError = data === undefined && query.isError ? describeError(query.error) : null;
  const isLoading = data === undefined && !loadError;

  return (
    <>
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as HomeTab)}
        className="h-dvh min-w-0 flex-1 bg-bg text-fg"
      >
        <header className="relative z-3 flex h-13 shrink-0 items-center gap-2 border-b border-line-soft pr-3.5 pl-4.5">
          <span className="mr-3.5 font-serif text-xl font-medium">Home</span>
          <TabList aria-label="Home">
            {TABS.map((item) => (
              <Tab key={item.id} id={item.id} count={counts ? counts[item.id] || undefined : undefined}>
                {item.label}
              </Tab>
            ))}
          </TabList>
          <span className="ml-1.5 inline-flex" onPointerDownCapture={wantFilter} onFocusCapture={wantFilter}>
            <FilterButton
              fields={fields}
              filter={filter as TaskFilter}
              onChange={(next) => setFilter(next as HomeFilter)}
            />
          </span>
          <span className="min-w-2 flex-1" />
          <SearchField
            width={200}
            value={text}
            onChange={setText}
            inputRef={searchRef}
            aria-label="Search Home"
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                const first = keys[0];
                if (first) {
                  selection.focus(first);
                  rowOf(first)?.focus();
                }
              } else {
                event.continuePropagation();
              }
            }}
          />
          <Button
            kbd="C"
            onPress={() => quickCreate?.open(undefined, { pickProject: true })}
            aria-keyshortcuts="c"
          >
            New task
          </Button>
        </header>
        <HomeFilterChips fields={fields} filter={filter} onChange={setFilter} />
        <TabPanel id={tab} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex items-baseline gap-3.5 px-4.5 pt-5.5 pb-1">
            <h1 className="m-0 font-serif text-2xl font-medium">{title}</h1>
            <span className="text-sm text-fg-3">{subtitle}</span>
          </div>
          {tab !== 'agents' && data ? <Deadlines deadlines={data.deadlines} /> : null}
          {loadError ? (
            <div className="px-4.5 pt-4">
              <Banner
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    isPending={query.isFetching}
                    onPress={() => query.refetch()}
                  >
                    Try again
                  </Button>
                }
              >
                Couldn't load Home. {loadError.message}
              </Banner>
            </div>
          ) : isLoading ? (
            <SkeletonRows count={8} label="Loading Home" className="pt-4" />
          ) : isClear ? (
            <AllClear
              tab={tab}
              workspace={workspace}
              assignedTotal={assigned?.total ?? 0}
              everyoneCount={counts?.everyone ?? 0}
              onShowAssigned={() => setShowAssigned(true)}
              onEveryone={() => setTab('everyone')}
            />
          ) : (
            <div ref={listRef} className="flex flex-col pb-6">
              {tab === 'agents' && data ? <AgentCards agents={data.agents} now={now} /> : null}
              {tab === 'agents' && data && data.agents.length === 0 && groups.length === 0 ? (
                <EmptyState
                  align="center"
                  title="No agents yet"
                  text="Add an agent in workspace settings, Members. Its work and its questions show here."
                  action={
                    <Button variant="secondary" onPress={() => void navigate({ to: '/settings/members' })}>
                      Open Members
                    </Button>
                  }
                />
              ) : null}
              {groups.map((view) => {
                const expanded = !collapsed.has(view.group.key);
                const headerId = `home-group-${view.group.key}`;
                return (
                  <section key={view.group.key} aria-labelledby={headerId}>
                    <GroupHeader
                      id={headerId}
                      title={groupTitle(view.group.key, tab)}
                      count={text.trim() ? view.items.length : view.group.total}
                      hint={groupHint(view.group, tab)}
                      expanded={expanded}
                      onToggle={() => toggleGroup(view.group.key)}
                    />
                    {expanded ? (
                      <ul aria-labelledby={headerId} className="m-0 list-none p-0">
                        {view.items.map((item) => {
                          const key = item.task.key;
                          const focused = key === focusedKey;
                          return (
                            <li key={key}>
                              <HomeRow
                                item={item}
                                tab={tab}
                                group={view.group.key}
                                viewerId={viewerId}
                                now={now}
                                focused={focused}
                                selected={selection.isSelected(key)}
                                showPriority={tab !== 'agents'}
                                rowRef={
                                  focused
                                    ? (node) => {
                                        anchorRef.current = node;
                                      }
                                    : undefined
                                }
                                onFocus={() => selection.focus(key)}
                                onClick={onRowClick(key)}
                              />
                            </li>
                          );
                        })}
                        {!text.trim() && view.group.total > view.items.length ? (
                          <li className="flex h-9 items-center pl-4 text-sm text-fg-3">
                            Showing {view.items.length} of {view.group.total}. Filter by project or label to
                            see the rest.
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </section>
                );
              })}
              {data && groups.length === 0 && (filtered || text.trim()) ? (
                <EmptyState
                  align="center"
                  title="Nothing matches"
                  text={
                    text.trim()
                      ? `No task here matches “${text.trim()}”.`
                      : 'No task here matches these filters.'
                  }
                  action={
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setText('');
                        if (filtered) void setFilter({});
                      }}
                    >
                      Clear {text.trim() && !filtered ? 'search' : 'filters'}
                    </Button>
                  }
                />
              ) : null}
            </div>
          )}
        </TabPanel>
      </Tabs>
      {/* Outside Tabs: React Aria collections inside <Tabs> confuse the pickers' menus. */}
      {fieldKeys.pickers}
    </>
  );
}

function isTyping(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
}

interface AllClearProps {
  tab: HomeTab;
  workspace: string;
  assignedTotal: number;
  everyoneCount: number;
  onShowAssigned: () => void;
  onEveryone: () => void;
}

/** Frame 102: nothing waits on the viewer (or, on Everyone, on anyone). */
function AllClear({
  tab,
  workspace,
  assignedTotal,
  everyoneCount,
  onShowAssigned,
  onEveryone,
}: AllClearProps) {
  const mine = tab === 'mine';
  const onTrack =
    assignedTotal === 0
      ? ''
      : assignedTotal === 1
        ? ' Your 1 assigned task is on track.'
        : ` Your ${assignedTotal} assigned tasks are on track.`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-16">
      <span aria-hidden className="grid size-11 place-items-center rounded-full bg-ok-soft text-ok">
        <CheckGlyph className="size-4" />
      </span>
      <EmptyState
        align="center"
        size="lg"
        className="pt-2.5"
        title="All clear"
        text={
          mine
            ? `Nothing waits on you: no reviews, mentions, blocked or overdue work.${onTrack}`
            : `Nothing needs attention across ${workspace}: no reviews, blocked, overdue or due work this week.`
        }
        action={
          mine ? (
            <>
              {assignedTotal > 0 ? (
                <Button variant="secondary" onPress={onShowAssigned}>
                  See assigned tasks
                </Button>
              ) : null}
              <Button variant="secondary" onPress={onEveryone}>
                Everyone
                {everyoneCount > 0 ? <Kbd aria-hidden>{everyoneCount}</Kbd> : null}
              </Button>
            </>
          ) : null
        }
      />
    </div>
  );
}
