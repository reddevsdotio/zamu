import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { GateResultState, MilestonePlan, TaskListItem, Wave } from '@zamu/contracts';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isTextDropItem, useDrag, useDrop } from 'react-aria-components';
import { togglePeek, usePeek } from '~/features/peek/store';
import { dismissFieldToast, showFieldToast, useTaskFieldKeys } from '~/features/task-fields';
import { useNow } from '~/features/tasks/clock';
import { describeError } from '~/features/tasks/errors';
import { atTime, formatAge, formatRelative } from '~/features/tasks/format';
import { Markdown } from '~/features/tasks/Markdown';
import { meQuery } from '~/features/tasks/queries';
import { type DisplayOptions, rememberTaskNavigation, useTaskSelection } from '~/features/views';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import {
  AddWaveRow,
  Banner,
  Button,
  ConfirmDialog,
  cn,
  FoldedWavesHeader,
  GateBox,
  GateResultPopover,
  inputBase,
  localToday,
  MoveHint,
  NoWaveHeader,
  PlanDoneLine,
  PlanStopLine,
  passBlockedText,
  Skeleton,
  useHotkeys,
  WaveHeader,
  WaveLockMark,
} from '~/ui';
import { isControl, TaskRow } from './PlanningTaskTable';
import { useCreateWave, useDeleteWave, usePutTasksInWave, useRecordGate, useUpdateWave } from './queries';
import {
  allGatesPassed,
  foldedRun,
  moreTasksText,
  moveStep,
  resultBy,
  shownTasks,
  startsExpanded,
  stoppedAt,
  taskWaveOf,
  type WaveSections,
  waveRefOf,
  waveSections,
  waveTitle,
} from './waves';

// A milestone's tasks grouped by wave (M8, frames 103 to 116 and 121 to 126):
//
//   ▾ W3  Screens  ▬▬▬ 4 of 6                                        Gate open
//      PAY-168  ◉ Payout page: attempts and next run                       (cd)
//      ◇ Gate  All checks pass, and a walkthrough …        Fail  Pass G
//   ▸ W4  End-to-end tests  0 of 3                    🔒 Locked until W3 passes
//   ▸ Not in a wave  2 tasks                   No gate. These never hold a wave up.
//   + Add a wave ⇧N
//
// Waves come from the plan (GET /milestones/{id}/plan): headers, gates, progress and locks. The rows
// are the page's task list (filters applied), each in the wave it carries. Passed and locked waves
// start collapsed and the current one open; with more than six waves the leading passed ones fold
// into one line, and a wave with more than eight rows shows six and "N more tasks in this wave".
// A failed gate puts the stop line across the top; once every gate passed, the done line.
//
// Keys: the list keys of PlanningTaskTable (J / K, X, Space, Enter, the field keys), Alt+↑ / Alt+↓
// move the focused task to the previous or next wave (with the hint; releasing Alt or a pause moves
// it, Esc cancels), ← / → on a header fold it, G on a header or gate records the gate (Shift+N, bound
// by the page, opens "Add a wave"). Rows drag onto another wave; a header's grip drags the wave to another place.

const TASK_DRAG = 'application/x-zamu-task';
const WAVE_DRAG = 'application/x-zamu-wave';
/** "Not in a wave", as a drop target and an expanded key. */
const NONE = 'none';
const FOLDED = 'folded';
/** A keyboard move goes through this long after the last Alt+↑ / Alt+↓, if Alt is never released. */
const MOVE_SETTLE_MS = 1500;

export interface WavePlanProps {
  projectKey: string;
  milestoneId: string;
  plan: MilestonePlan;
  /** The page's task rows, filters applied. */
  rows: readonly TaskListItem[];
  display: DisplayOptions;
  /** The page as the task view names it: "Milestone". */
  from: string;
  /** The rows are still loading. */
  isLoadingRows?: boolean;
  /** Open "+ Add a wave" at once (after "+ Add waves" on a milestone without waves). */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}

interface PendingMove {
  key: string;
  from: string | null;
  to: string | null;
}

interface GatePopover {
  waveId: string;
  defaultState?: GateResultState;
}

export function WavePlan({
  projectKey,
  milestoneId,
  plan,
  rows,
  display,
  from,
  isLoadingRows = false,
  adding,
  onAddingChange,
}: WavePlanProps) {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location.href });
  const viewerId = useQuery(meQuery(api)).data?.user.id ?? null;
  const now = useNow();

  const sections = useMemo(() => waveSections(plan, rows), [plan, rows]);
  const waves = plan.waves;
  const run = foldedRun(waves);
  const passedAll = allGatesPassed(waves);
  const stopped = stoppedAt(waves);

  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isExpanded = (id: string) => expandedOf(id, expandedOverrides, waves);
  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedOverrides((current) => new Map(current).set(id, expanded));
  }, []);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());

  // Rows in view order, for J / K, the selection and the field keys.
  const keys = useMemo(
    () => visibleTaskKeys(sections, expandedOverrides, showAll),
    [sections, expandedOverrides, showAll],
  );
  const byKey = useMemo(() => new Map(rows.map((task) => [task.key, task])), [rows]);

  const rowEls = useRef(new Map<string, HTMLElement>());
  const focusedRow = useRef<HTMLElement | null>(null);
  const selection = useTaskSelection(keys, {
    view: from,
    onFocusChange: (key) => {
      if (key) rowEls.current.get(key)?.scrollIntoView?.({ block: 'nearest' });
    },
  });
  focusedRow.current = selection.focusedKey ? (rowEls.current.get(selection.focusedKey) ?? null) : null;
  const targets = useMemo(
    () =>
      selection.targetKeys.map((key) => byKey.get(key)).filter((task): task is TaskListItem => task != null),
    [selection.targetKeys, byKey],
  );
  const peek = usePeek();
  const peekHere = peek != null && peek.from === from;
  const fieldKeys = useTaskFieldKeys({ targets, enabled: !peekHere, anchors: focusedRow });

  const remember = useCallback(
    (key: string) => rememberTaskNavigation(workspaceId, { keys, from, returnTo: location }, key),
    [workspaceId, keys, from, location],
  );
  const open = useCallback(
    (key: string) => {
      remember(key);
      void navigate({
        to: '/w/$workspace/p/$projectKey/$taskKey',
        params: { workspace, projectKey, taskKey: key },
      });
    },
    [remember, navigate, projectKey, workspace],
  );

  // ── Writes ────────────────────────────────────────────────────────────────────────────────────────
  const createWave = useCreateWave();
  const updateWave = useUpdateWave();
  const deleteWave = useDeleteWave();
  const putTasks = usePutTasksInWave();
  const recordGate = useRecordGate();

  const moveTask = useCallback(
    (key: string, to: string | null) => {
      const task = byKey.get(key);
      if ((task?.wave?.id ?? null) === to) return;
      const wave = to ? waves.find((item) => item.id === to) : null;
      if (to && !wave) return;
      if (to) setExpanded(to, true);
      else setExpanded(NONE, true);
      putTasks.mutate(
        { milestone: milestoneId, wave: wave ? taskWaveOf(wave) : null, keys: [key] },
        {
          onSuccess: () =>
            showFieldToast({
              text: wave ? `Moved ${key} to ${waveTitle(wave)}` : `Took ${key} out of its wave`,
            }),
          onError: failed(`Couldn't move ${key}.`),
        },
      );
    },
    [byKey, waves, milestoneId, putTasks, setExpanded],
  );

  // ── Alt+↑ / Alt+↓ with the hint ─────────────────────────────────────────────────────────────────────
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const pendingRef = useRef<PendingMove | null>(null);
  pendingRef.current = pendingMove;
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);
  const commitMove = useCallback(() => {
    clearTimer();
    const move = pendingRef.current;
    pendingRef.current = null;
    setPendingMove(null);
    if (move && move.to !== move.from) moveTask(move.key, move.to);
  }, [moveTask, clearTimer]);
  const cancelMove = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    setPendingMove(null);
  }, [clearTimer]);
  const stepMove = (direction: 1 | -1) => {
    const key = selection.focusedKey;
    const task = key ? byKey.get(key) : undefined;
    if (!key || !task) return;
    const current = pendingRef.current?.key === key ? pendingRef.current : null;
    const origin = task.wave?.id ?? null;
    const at = current ? current.to : origin;
    const next = moveStep(waves, at, direction);
    if (next === undefined) return;
    const move = { key, from: origin, to: next };
    // The hint sits where the toast does: the last change's toast makes way.
    if (!current) dismissFieldToast();
    pendingRef.current = move;
    setPendingMove(move);
    clearTimer();
    settleTimer.current = setTimeout(commitMove, MOVE_SETTLE_MS);
  };
  useEffect(() => {
    if (!pendingMove) return;
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') commitMove();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelMove();
    };
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [pendingMove, commitMove, cancelMove]);
  useEffect(() => clearTimer, [clearTimer]);

  // ── Drag and drop ───────────────────────────────────────────────────────────────────────────────────
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const onDropTask = (key: string, target: string) => {
    setDragging(null);
    setDropTarget(null);
    moveTask(key, target === NONE ? null : target);
  };
  const onDropWave = (id: string, target: Wave) => {
    setDropTarget(null);
    const wave = waves.find((item) => item.id === id);
    if (!wave || wave.id === target.id) return;
    updateWave.mutate(
      { id, position: target.number },
      { onError: failed(`Couldn't move ${waveRefOf(wave)}.`) },
    );
  };

  // ── Gates ───────────────────────────────────────────────────────────────────────────────────────────
  const gateEls = useRef(new Map<string, HTMLElement>());
  const headerEls = useRef(new Map<string, HTMLElement>());
  const [popover, setPopover] = useState<GatePopover | null>(null);
  const openGate = (wave: Wave, defaultState?: GateResultState) => {
    recordGate.reset();
    setExpanded(wave.id, true);
    if (run && wave.number <= run.to) setExpanded(FOLDED, true);
    setPopover({ waveId: wave.id, ...(defaultState ? { defaultState } : {}) });
  };
  const popoverWave = popover ? waves.find((wave) => wave.id === popover.waveId) : undefined;
  const anchor: RefObject<Element | null> = useMemo(
    () => ({
      get current() {
        const id = popover?.waveId;
        if (!id) return null;
        return gateEls.current.get(id) ?? headerEls.current.get(id) ?? null;
      },
    }),
    [popover?.waveId],
  );
  const goToGate = (wave: Wave) => {
    setExpanded(wave.id, true);
    if (run && wave.number <= run.to) setExpanded(FOLDED, true);
    requestAnimationFrame(() => {
      const box = document.getElementById(gateId(wave.id));
      box?.scrollIntoView?.({ block: 'center' });
      box?.focus({ preventScroll: true });
    });
  };

  // ── Waves ───────────────────────────────────────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Wave | null>(null);
  const [editingGate, setEditingGate] = useState<string | null>(null);

  const addWave = (name: string) => {
    createWave.mutate(
      { milestone: milestoneId, name },
      {
        onSuccess: (wave) => {
          onAddingChange(false);
          setExpanded(wave.id, true);
          showFieldToast({ text: `Added ${waveTitle(wave)}` });
        },
        onError: failed("Couldn't add the wave."),
      },
    );
  };

  const focusedKey = selection.focusedKey;
  useHotkeys({
    Enter: {
      preventDefault: false,
      handler: (event) => {
        if (!focusedKey || isControl(event.target)) return;
        event.preventDefault();
        open(focusedKey);
      },
    },
    Space: {
      preventDefault: false,
      handler: (event) => {
        if (!focusedKey || isControl(event.target)) return;
        event.preventDefault();
        togglePeek({ key: focusedKey, keys, from, onMove: (key) => selection.focus(key) });
      },
    },
    'Alt+ArrowDown': { allowInInputs: false, handler: () => stepMove(1) },
    'Alt+ArrowUp': { allowInInputs: false, handler: () => stepMove(-1) },
  });

  const age = atTime(formatAge, now);
  const relative = atTime(formatRelative, now);
  const today = now == null ? undefined : localToday(new Date(now));

  const renderRows = (tasks: readonly TaskListItem[]) => (
    <ul className="m-0 list-none p-0">
      {tasks.map((task) => (
        <DraggableRow
          key={task.key}
          task={task}
          projectKey={projectKey}
          display={display}
          viewerId={viewerId}
          today={today}
          updated={age(task.updatedAt)}
          created={age(task.createdAt)}
          isFocused={selection.focusedKey === task.key}
          isSelected={selection.isSelected(task.key)}
          isMoving={pendingMove?.key === task.key || dragging === task.key}
          rowRef={(element) => {
            if (element) rowEls.current.set(task.key, element);
            else rowEls.current.delete(task.key);
          }}
          onClick={(event) => {
            if ((event.target as Element).closest('a')) return;
            if (window.getSelection()?.toString()) return;
            if (selection.handleClick(task.key, event)) return;
            open(task.key);
          }}
          onLinkPress={() => {
            selection.focus(task.key);
            remember(task.key);
          }}
          onDragStart={() => {
            dismissFieldToast();
            setDragging(task.key);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropTarget(null);
          }}
        />
      ))}
    </ul>
  );

  const moveTarget = pendingMove ? pendingMove.to : null;
  const isMoveTarget = (id: string) =>
    (pendingMove != null && (moveTarget ?? NONE) === id) || (dragging != null && dropTarget === id);
  const hint = pendingMove
    ? { key: pendingMove.key, to: pendingMove.to }
    : dragging && dropTarget
      ? { key: dragging, to: dropTarget === NONE ? null : dropTarget }
      : null;
  const hintTo = hint?.to ? waves.find((wave) => wave.id === hint.to) : null;

  const renderWave = ({ wave, tasks }: (typeof sections.waves)[number]) => {
    const expanded = isExpanded(wave.id);
    const bodyId = `wave-body-${wave.id}`;
    const { shown, more } = shownTasks(tasks, showAll.has(wave.id));
    const firstAfterHold = wave.lockedUntil != null && wave.lockedUntil.number === wave.number - 1;
    const result = wave.gate.result;
    const inProgress = wave.tasks.filter(
      (task) => task.status === 'in_progress' || task.status === 'in_review',
    ).length;
    return (
      <DropZone
        key={wave.id}
        label={waveTitle(wave)}
        isTarget={isMoveTarget(wave.id)}
        onDropTask={(key) => onDropTask(key, wave.id)}
        onDropWave={(id) => onDropWave(id, wave)}
        onEnter={() => setDropTarget(wave.id)}
        onExit={() => setDropTarget((current) => (current === wave.id ? null : current))}
      >
        {(isTarget) => (
          <>
            <WaveGrip wave={wave}>
              {(gripProps) => (
                <div
                  data-gate-key
                  ref={(element) => {
                    if (element) headerEls.current.set(wave.id, element);
                    else headerEls.current.delete(wave.id);
                  }}
                >
                  <WaveHeader
                    number={wave.number}
                    name={wave.name}
                    done={wave.progress.done + wave.progress.canceled}
                    total={wave.progress.total}
                    inProgress={inProgress}
                    gate={wave.gate.state}
                    current={wave.current}
                    locked={wave.locked}
                    lockedUntil={firstAfterHold ? (wave.lockedUntil?.number ?? null) : null}
                    openAfterPass={wave.gate.state === 'passed' ? wave.progress.open : 0}
                    expanded={expanded}
                    onExpandedChange={(value) => setExpanded(wave.id, value)}
                    controls={bodyId}
                    renaming={renaming === wave.id}
                    onRename={(name) => {
                      setRenaming(null);
                      if (name === wave.name) return;
                      updateWave.mutate(
                        { id: wave.id, name },
                        { onError: failed(`Couldn't rename ${waveRefOf(wave)}.`) },
                      );
                    }}
                    onRenameCancel={() => setRenaming(null)}
                    onRenameStart={() => setRenaming(wave.id)}
                    onMoveUp={() =>
                      updateWave.mutate(
                        { id: wave.id, position: wave.number - 1 },
                        { onError: failed(`Couldn't move ${waveRefOf(wave)}.`) },
                      )
                    }
                    {...(wave.number < waves.length
                      ? {
                          onMoveDown: () =>
                            updateWave.mutate(
                              { id: wave.id, position: wave.number + 1 },
                              { onError: failed(`Couldn't move ${waveRefOf(wave)}.`) },
                            ),
                        }
                      : {})}
                    onRemove={() => setRemoving(wave)}
                    gripProps={gripProps}
                    onGateKey={() => openGate(wave)}
                  />
                </div>
              )}
            </WaveGrip>
            {expanded ? (
              <div id={bodyId} className="relative">
                {isTarget ? <DropLine /> : null}
                {renderRows(shown)}
                {more > 0 ? (
                  <div className="flex h-8 items-center gap-1 pl-17 text-sm text-accent-text">
                    <span>{moreTasksText(more)}</span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      onClick={() => setShowAll((current) => new Set(current).add(wave.id))}
                      className="cursor-pointer rounded-sm font-medium outline-none hover:underline focus-visible:focus-ring"
                    >
                      Show all
                    </button>
                  </div>
                ) : null}
                {tasks.length === 0 && wave.progress.total > 0 ? (
                  <p className="m-0 py-2 pl-17 text-sm text-fg-3">No tasks in this wave match the filters.</p>
                ) : null}
                {wave.progress.total === 0 ? (
                  <p className="m-0 py-2 pl-17 text-sm text-fg-3">
                    No tasks yet. Drag a task here, or press ⌥↓ on one above.
                  </p>
                ) : null}
                <div className="border-b border-line-soft px-4.5 pt-1.5 pb-3.5 pl-11.5">
                  <div
                    data-gate-key
                    className="group/gate max-w-215"
                    ref={(element) => {
                      if (element) gateEls.current.set(wave.id, element);
                      else gateEls.current.delete(wave.id);
                    }}
                  >
                    <GateBox
                      id={gateId(wave.id)}
                      label={`Gate of ${waveTitle(wave)}`}
                      state={wave.gate.state}
                      description={
                        editingGate === wave.id ? (
                          <GateDescriptionEditor
                            label={`What the gate of ${waveRefOf(wave)} checks`}
                            defaultValue={wave.gate.description ?? ''}
                            isPending={updateWave.isPending}
                            onCancel={() => setEditingGate(null)}
                            onSave={(text) =>
                              updateWave.mutate(
                                { id: wave.id, gateDescription: text.trim() ? text : null },
                                {
                                  onSuccess: () => setEditingGate(null),
                                  onError: failed("Couldn't save the gate."),
                                },
                              )
                            }
                          />
                        ) : (
                          <GateDescription
                            text={wave.gate.description}
                            onEdit={() => setEditingGate(wave.id)}
                          />
                        )
                      }
                      result={
                        result
                          ? {
                              state: result.state,
                              ...resultBy(result),
                              when:
                                now == null ? null : relative(result.at).replace(/^Just now$/, 'just now'),
                              note: <Markdown source={result.note} />,
                            }
                          : null
                      }
                      openTasks={wave.progress.open}
                      onPass={() => openGate(wave, 'passed')}
                      onFail={() => openGate(wave, 'failed')}
                      onRecordAgain={() => openGate(wave)}
                      onGateKey={() => openGate(wave)}
                    />
                  </div>
                </div>
              </div>
            ) : null}
            {!expanded && isTarget ? <DropLine /> : null}
          </>
        )}
      </DropZone>
    );
  };

  const foldedWaves = run ? sections.waves.filter((section) => section.wave.number <= run.to) : [];
  const restWaves = run ? sections.waves.filter((section) => section.wave.number > run.to) : sections.waves;
  const outsideOpen = plan.notInWave.filter(
    (task) => task.status !== 'done' && task.status !== 'canceled',
  ).length;
  const showNone = sections.none.length > 0 || plan.notInWave.length > 0 || waves.length === 0;

  return (
    <section aria-label="Waves" className="pb-24">
      {fieldKeys.pickers}
      {stopped ? (
        <div className="px-4.5 pt-3">
          <PlanStopLine
            wave={waveTitle(stopped)}
            locked={waves.filter((wave) => wave.number > stopped.number).map(waveRefOf)}
            onGoToGate={() => goToGate(stopped)}
          />
        </div>
      ) : passedAll ? (
        <div className="px-4.5 pt-3">
          <PlanDoneLine
            gates={waves.length}
            openOutside={outsideOpen}
            openInWaves={waves.reduce((sum, wave) => sum + wave.progress.open, 0)}
          />
        </div>
      ) : null}
      {run ? (
        <>
          <FoldedWavesHeader
            from={run.from}
            to={run.to}
            tasks={foldedWaves.reduce((sum, section) => sum + section.wave.progress.total, 0)}
            expanded={isExpanded(FOLDED)}
            onExpandedChange={(value) => setExpanded(FOLDED, value)}
          />
          {isExpanded(FOLDED) ? foldedWaves.map(renderWave) : null}
        </>
      ) : null}
      {restWaves.map(renderWave)}
      {showNone ? (
        <DropZone
          label="Not in a wave"
          isTarget={isMoveTarget(NONE)}
          onDropTask={(key) => onDropTask(key, NONE)}
          onEnter={() => setDropTarget(NONE)}
          onExit={() => setDropTarget((current) => (current === NONE ? null : current))}
        >
          {(isTarget) => (
            <>
              <NoWaveHeader
                tasks={sections.none.length}
                expanded={isExpanded(NONE)}
                onExpandedChange={(value) => setExpanded(NONE, value)}
                controls="wave-body-none"
              />
              {isExpanded(NONE) ? (
                <div id="wave-body-none" className="relative border-b border-line-soft">
                  {isTarget ? <DropLine /> : null}
                  {isLoadingRows && rows.length === 0 ? <RowsSkeleton /> : renderRows(sections.none)}
                  {sections.none.length === 0 && !isLoadingRows ? (
                    <p className="m-0 py-2 pl-17 text-sm text-fg-3">
                      {waves.length === 0
                        ? 'No tasks in this milestone yet.'
                        : 'Every task of this milestone is in a wave.'}
                    </p>
                  ) : null}
                </div>
              ) : isTarget ? (
                <DropLine />
              ) : null}
            </>
          )}
        </DropZone>
      ) : null}
      <AddWaveRow
        nextNumber={waves.length + 1}
        adding={adding}
        onAddStart={() => onAddingChange(true)}
        onAdd={addWave}
        onCancel={() => onAddingChange(false)}
        kbd="⇧N"
      />
      {hint ? (
        <div className="pointer-events-none fixed bottom-5.5 left-1/2 z-10 -translate-x-1/2">
          <MoveHint taskKey={hint.key} to={hintTo ? waveRefOf(hintTo) : null} />
        </div>
      ) : null}
      {popoverWave ? (
        <GateResultPopover
          key={`${popoverWave.id}-${popover?.defaultState ?? ''}`}
          triggerRef={anchor}
          isOpen
          title={`Gate of ${waveTitle(popoverWave)}`}
          {...(popover?.defaultState ? { defaultState: popover.defaultState } : {})}
          passBlockedReason={popoverWave.canPass ? undefined : passBlockedText(popoverWave.progress.open)}
          nextWave={(() => {
            const next = waves.find((wave) => wave.number === popoverWave.number + 1);
            return next ? waveRefOf(next) : null;
          })()}
          isPending={recordGate.isPending}
          error={recordGate.error ? describeError(recordGate.error).message : undefined}
          onCancel={() => setPopover(null)}
          onRecord={(state, note) =>
            recordGate.mutate(
              { id: popoverWave.id, state, note },
              {
                onSuccess: () => {
                  setPopover(null);
                  showFieldToast({
                    text: `Recorded ${state === 'passed' ? 'a pass' : 'a failure'} for ${waveTitle(popoverWave)}`,
                  });
                },
              },
            )
          }
        />
      ) : null}
      <ConfirmDialog
        isOpen={removing != null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoving(null);
        }}
        title={removing ? `Remove ${waveTitle(removing)}?` : 'Remove the wave?'}
        confirmLabel="Remove wave"
        onConfirm={() => (removing ? deleteWave.mutateAsync(removing.id) : undefined)}
      >
        {removing ? <RemoveWaveText wave={removing} /> : null}
      </ConfirmDialog>
    </section>
  );
}

/** The consequence in the remove confirm: where its tasks go. */
export function RemoveWaveText({ wave }: { wave: Pick<Wave, 'progress' | 'gate'> }) {
  const count = wave.progress.total;
  const results = wave.gate.result ? ' and its recorded results' : '';
  return count === 0 ? (
    <>It has no tasks. Its gate{results} go with it. The waves after it move up one.</>
  ) : (
    <>
      Its <b>{count === 1 ? '1 task goes' : `${count} tasks go`}</b> to Not in a wave. Its gate{results} go
      with it, and the waves after it move up one.
    </>
  );
}

const gateId = (waveId: string) => `gate-${waveId}`;

/** A toast for a refused wave write: "Couldn't move PAY-173. <why>". */
const failed = (what: string) => (error: unknown) =>
  showFieldToast({ text: `${what} ${describeError(error).message}`, tone: 'error' });

/** Whether a wave (by id), the folded run or "Not in a wave" is open: the person's pick, else the default. */
function expandedOf(id: string, overrides: ReadonlyMap<string, boolean>, waves: readonly Wave[]): boolean {
  const override = overrides.get(id);
  if (override !== undefined) return override;
  if (id === FOLDED) return false;
  if (id === NONE) return allGatesPassed(waves) || waves.length === 0;
  const wave = waves.find((item) => item.id === id);
  return wave ? startsExpanded(wave, waves) : false;
}

/** The task keys the page shows, top to bottom: open waves (the folded run only when open), then no wave. */
export function visibleTaskKeys(
  sections: WaveSections,
  overrides: ReadonlyMap<string, boolean>,
  showAll: ReadonlySet<string>,
): string[] {
  const waves = sections.waves.map((section) => section.wave);
  const run = foldedRun(waves);
  const list: string[] = [];
  for (const { wave, tasks } of sections.waves) {
    if (run && wave.number <= run.to && !expandedOf(FOLDED, overrides, waves)) continue;
    if (!expandedOf(wave.id, overrides, waves)) continue;
    for (const task of shownTasks(tasks, showAll.has(wave.id)).shown) list.push(task.key);
  }
  if (expandedOf(NONE, overrides, waves)) for (const task of sections.none) list.push(task.key);
  return list;
}

/** The accent line where a dragged or moved task lands. */
function DropLine() {
  return <div aria-hidden className="pointer-events-none absolute inset-x-11.5 top-0 z-2 h-0.5 bg-accent" />;
}

/** A wave (or "Not in a wave") that takes dropped tasks, and dropped waves to reorder. */
function DropZone({
  label,
  isTarget,
  onDropTask,
  onDropWave,
  onEnter,
  onExit,
  children,
}: {
  label: string;
  isTarget: boolean;
  onDropTask: (key: string) => void;
  onDropWave?: (id: string) => void;
  onEnter: () => void;
  onExit: () => void;
  children: (isTarget: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) =>
      types.has(TASK_DRAG) || (onDropWave && types.has(WAVE_DRAG)) ? 'move' : 'cancel',
    onDropEnter: onEnter,
    onDropExit: onExit,
    onDrop: async (event) => {
      for (const item of event.items) {
        if (!isTextDropItem(item)) continue;
        if (item.types.has(TASK_DRAG)) {
          const key = await item.getText(TASK_DRAG);
          if (key) onDropTask(key);
          return;
        }
        if (onDropWave && item.types.has(WAVE_DRAG)) {
          const id = await item.getText(WAVE_DRAG);
          if (id) onDropWave(id);
          return;
        }
      }
    },
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named region of the page, not a form group
    <div ref={ref} {...dropProps} role="group" aria-label={label} className="relative">
      {children(isTarget || isDropTarget)}
    </div>
  );
}

/** The drag grip of a wave header: drags the wave to another place. */
function WaveGrip({
  wave,
  children,
}: {
  wave: Wave;
  children: (gripProps: ReturnType<typeof useDrag>['dragProps']) => ReactNode;
}) {
  const { dragProps } = useDrag({
    hasDragButton: true,
    getItems: () => [{ [WAVE_DRAG]: wave.id, 'text/plain': waveTitle(wave) }],
  });
  return <>{children({ ...dragProps, 'aria-hidden': true } as typeof dragProps)}</>;
}

type DraggableRowProps = Omit<Parameters<typeof TaskRow>[0], 'hide' | 'lockMark' | 'rowProps'> & {
  onDragStart: () => void;
  onDragEnd: () => void;
};

/** A task row that drags onto another wave, with the lock of a locked wave. */
function DraggableRow({ onDragStart, onDragEnd, ...props }: DraggableRowProps) {
  const { task } = props;
  const { dragProps } = useDrag({
    hasDragButton: true,
    getItems: () => [{ [TASK_DRAG]: task.key, 'text/plain': task.key }],
    onDragStart,
    onDragEnd,
  });
  const wave = task.wave;
  const until = wave?.lockedUntil && wave.lockedUntil.number === wave.number - 1 ? wave.lockedUntil : null;
  return (
    <TaskRow
      {...props}
      hide="milestone"
      rowProps={dragProps}
      lockMark={wave?.locked ? <WaveLockMark lockedUntil={until ? `W${until.number}` : null} /> : null}
    />
  );
}

/** What the gate checks, with Edit on hover and focus. */
function GateDescription({ text, onEdit }: { text: string | null; onEdit: () => void }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        {text ? (
          <Markdown source={text} className="[&_p]:m-0 [&_p+p]:mt-1.5" />
        ) : (
          <span className="text-fg-3">No checks written for this gate yet.</span>
        )}
      </div>
      <Button
        variant="quiet"
        size="sm"
        onPress={onEdit}
        className="h-5.5 shrink-0 px-1.5 opacity-0 group-hover/gate:opacity-100 group-focus-within/gate:opacity-100"
      >
        {text ? 'Edit' : 'Write the checks'}
      </Button>
    </div>
  );
}

/** Editing what a gate checks: ⌘↵ or Save keeps it, Esc or Cancel leaves it as it was. */
function GateDescriptionEditor({
  label,
  defaultValue,
  isPending,
  onSave,
  onCancel,
}: {
  label: string;
  defaultValue: string;
  isPending: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={field}
        id={id}
        value={value}
        rows={3}
        maxLength={4000}
        placeholder="What has to be true before the next wave starts"
        className={cn(inputBase, 'min-h-16 resize-y px-2.75 py-2 leading-normal')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave(value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-1.5">
        <Button size="sm" kbd="⌘↵" isPending={isPending} onPress={() => onSave(value)}>
          Save
        </Button>
        <Button size="sm" variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading tasks" className="flex flex-col">
      {[46, 38].map((width) => (
        <div key={width} className="flex h-9.5 items-center gap-2.5 pr-4.5 pl-8">
          <Skeleton width={48} height={8} />
          <Skeleton width={13} height={13} round />
          <Skeleton width={`${width}%`} height={8} />
        </div>
      ))}
    </div>
  );
}

/** The plan while it loads (frame 122): skeleton wave headers. */
export function WavesSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the waves" className="flex flex-col">
      {[350, 526, 234, 350].map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed skeleton rows
        <div key={index} className="flex h-11 items-center gap-3.5 border-b border-line-soft px-4.5">
          <Skeleton width={48} height={8} />
          <Skeleton width={width} height={8} />
        </div>
      ))}
    </div>
  );
}

/** The plan couldn't load (frame 123). */
export function WavesError({ onRetry, isRetrying }: { onRetry: () => void; isRetrying: boolean }) {
  return (
    <div className="px-4.5 py-4">
      <Banner
        action={
          <Button variant="secondary" size="sm" isPending={isRetrying} onPress={onRetry}>
            Try again
          </Button>
        }
      >
        Couldn’t load the waves of this milestone.
      </Banner>
    </div>
  );
}
