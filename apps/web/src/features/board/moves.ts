import { ORPCError } from '@orpc/client';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { TASK_CHANGED, type Task, type TaskListItem, type TaskStatus } from '@zamu/contracts';
import { useCallback, useRef, useState } from 'react';
import { dismissFieldToast, showFieldToast } from '~/features/task-fields/toast';
import { describeError } from '~/features/tasks/errors';
import {
  applyTaskPatch,
  inversePatch,
  type TaskPatch,
  toListItem,
  toUpdateInput,
} from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';
import { PRIORITY_LABELS, STATUS_LABELS } from '~/ui';
import {
  cardsOf,
  findCard,
  insertCard,
  type Placement,
  rankFor,
  removeCard,
  shiftCounts,
} from './board-cache';
import { placementBetween } from './layout';
import { boardQueries, invalidateBoard } from './queries';

// Card moves between status columns: one PATCH per move with the status, the position (manual order)
// and ifUpdatedAt, plus the lane's field on a swimlane board. The board changes at once; the server's
// answer confirms it, or the card goes back (a TASK_CHANGED conflict puts it where the current task says).
// Moves run one after another, so a quick second move sends the updatedAt the first one returned.
//
// Each move shows the shared field toast (features/task-fields/toast.tsx) with its Undo, so the board
// and the pickers have one Undo and one ⌘Z: the most recent change wins.

/** Fields a move into a swimlane (or a column of another grouping) sets with the status. */
export type MovePatch = Pick<TaskPatch, 'priority' | 'assignee' | 'milestone' | 'cycle'>;

export interface MoveIntent {
  key: string;
  to: TaskStatus;
  placement: Placement;
  /** The lane's field (swimlanes). */
  patch?: MovePatch;
  /**
   * Send the position (manual order, default true). Off when the column is ordered by priority, due date
   * or time: the server's order places the card, and its rank stays as it was.
   */
  sendPosition?: boolean;
  /** Drag or keyboard: only the wording of the conflict note differs. */
  via: 'drag' | 'keyboard';
}

interface MoveRecord {
  intent: MoveIntent;
  /** The card before the move. */
  before: TaskListItem;
  /** Its neighbours in its column before the move, to put it back on undo. */
  previous: string | null;
  next: string | null;
  isUndo: boolean;
  /** Set when an earlier failed move of the same card cancels this one. */
  cancelled: boolean;
  /** The toast that announced it. */
  toastId?: number;
}

export interface MoveProblem {
  key: string;
  /** "Couldn't move PAY-131 to In review. It went back to In progress." */
  text: string;
  /** Second line under the banner. */
  hint?: string;
  retry: () => void;
}

export interface MoveAnnouncement {
  id: number;
  /** For screen readers: "PAY-140 is now 2 of 5 in In review." */
  text: string;
}

const label = (status: TaskStatus) => STATUS_LABELS[status];

/** A full task as a board card. */
export function toCard(task: Task | TaskListItem): TaskListItem {
  return toListItem(task);
}

/** The card's home column (the cached column of its status) and its neighbours there. */
function locateCard(api: WorkspaceApi, queryClient: QueryClient, projectKey: string, key: string) {
  for (const { status, data } of boardQueries(api, queryClient, projectKey)) {
    const card = findCard(data, key);
    if (!card || card.status !== status) continue;
    const cards = cardsOf(data);
    const index = cards.findIndex((item) => item.key === key);
    return { card, previous: cards[index - 1]?.key ?? null, next: cards[index + 1]?.key ?? null };
  }
  return null;
}

/** Puts `card` (with its new status) into every cached column of the project and fixes the counts. */
function placeCard(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
  card: TaskListItem,
  placement: Placement,
  fromStatus: TaskStatus,
) {
  for (const { queryKey, status, data } of boardQueries(api, queryClient, projectKey)) {
    let next = removeCard(data, card.key);
    if (status === card.status) {
      const rank = rankFor(cardsOf(next), placement, card.rank);
      next = insertCard(next, { ...card, rank }, placement);
    }
    next = shiftCounts(next, fromStatus, card.status);
    if (next !== data) queryClient.setQueryData(queryKey, next);
  }
}

/** Where the card is now in its column: "position 2 of 5". */
function positionOf(
  api: WorkspaceApi,
  queryClient: QueryClient,
  projectKey: string,
  key: string,
  status: TaskStatus,
) {
  for (const entry of boardQueries(api, queryClient, projectKey)) {
    if (entry.status !== status) continue;
    const index = cardsOf(entry.data).findIndex((card) => card.key === key);
    if (index < 0) continue;
    const total = entry.data.pages[0]?.counts[status] ?? cardsOf(entry.data).length;
    return { position: index + 1, total: Math.max(total, index + 1) };
  }
  return null;
}

function patchTaskCache(api: WorkspaceApi, queryClient: QueryClient, key: string, card: TaskListItem) {
  const queryKey = api.orpc.tasks.get.queryKey({ input: { key } });
  const task = queryClient.getQueryData(queryKey);
  if (task) queryClient.setQueryData(queryKey, { ...task, ...card });
}

const hasPatch = (patch: MovePatch | undefined): patch is MovePatch =>
  patch != null && Object.keys(patch).length > 0;

function samePlace(card: TaskListItem, previous: string | null, next: string | null, intent: MoveIntent) {
  if (hasPatch(intent.patch) || card.status !== intent.to) return false;
  if (intent.sendPosition === false) return true;
  const placement = intent.placement;
  if (placement === 'top') return previous === null;
  if (placement === 'rank') return true;
  if ('before' in placement) return placement.before === card.key || placement.before === next;
  return placement.after === card.key || placement.after === previous;
}

/** ", assigned to Ana Ruiz", ", no milestone": what the lane part of a move changed. */
function patchWords(patch: MovePatch | undefined): string {
  if (!patch) return '';
  const parts: string[] = [];
  if (patch.assignee !== undefined)
    parts.push(patch.assignee ? `assigned to ${patch.assignee.name}` : 'unassigned');
  if (patch.milestone !== undefined)
    parts.push(patch.milestone ? `in ${patch.milestone.name}` : 'no milestone');
  if (patch.cycle !== undefined) parts.push(patch.cycle ? `in Cycle ${patch.cycle.number}` : 'no cycle');
  if (patch.priority !== undefined)
    parts.push(patch.priority === 'none' ? 'no priority' : `${PRIORITY_LABELS[patch.priority]} priority`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

function moveText(intent: MoveIntent, before: TaskListItem, isUndo: boolean): string {
  const lane = patchWords(intent.patch);
  if (isUndo) return `Moved ${intent.key} back to ${label(intent.to)}${lane}`;
  if (before.status === intent.to && !hasPatch(intent.patch))
    return `Moved ${intent.key} within ${label(intent.to)}`;
  return `Moved ${intent.key} to ${label(intent.to)}${lane}`;
}

function conflictTask(error: unknown): Task | null {
  if (!(error instanceof ORPCError) || error.code !== TASK_CHANGED) return null;
  const task = (error.data as { task?: Task } | undefined)?.task;
  return task ?? null;
}

export interface BoardMoves {
  /** Moves a card. False when nothing changes (same place, card not on the board). */
  move: (intent: MoveIntent) => boolean;
  /** Undoes the newest move still on the stack. Returns the card's key, or null when nothing moved. */
  undo: () => string | null;
  canUndo: boolean;
  /** The last move, for a screen reader live region. */
  announcement: MoveAnnouncement | null;
  problem: MoveProblem | null;
  dismissProblem: () => void;
}

export interface BoardMovesOptions {
  /** Called with the card's key after an Undo from the toast put it back (to keep the keyboard on it). */
  onUndone?: (key: string) => void;
}

export function useBoardMoves(projectKey: string, { onUndone }: BoardMovesOptions = {}): BoardMoves {
  const api = useApi();
  const queryClient = useQueryClient();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const touched = useRef(new Set<string>());
  const records = useRef<MoveRecord[]>([]);
  const undoStack = useRef<MoveRecord[]>([]);
  /** updatedAt of each card as the server last returned it, for ifUpdatedAt. */
  const serverUpdatedAt = useRef(new Map<string, string>());
  const announceId = useRef(0);
  const [announcement, setAnnouncement] = useState<MoveAnnouncement | null>(null);
  const [problem, setProblem] = useState<MoveProblem | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const onUndoneRef = useRef(onUndone);
  onUndoneRef.current = onUndone;

  const syncUndo = useCallback(() => setCanUndo(undoStack.current.length > 0), []);

  const settle = useCallback(() => {
    pending.current--;
    if (pending.current > 0) return;
    const keys = [...touched.current];
    touched.current.clear();
    void invalidateBoard(api, queryClient, projectKey);
    void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.get.key({ input: { key } }) });
      void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.activity.key({ input: { key } }) });
      void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.timeline.key({ input: { key } }) });
    }
  }, [queryClient, projectKey, api]);

  // `move`, `send` and `undoRecord` call each other (retry, the toast's Undo); refs keep them current.
  const moveRef = useRef<(intent: MoveIntent, isUndo?: boolean) => boolean>(() => false);
  const undoRecordRef = useRef<(record: MoveRecord) => string | null>(() => null);

  const send = useCallback(
    async (record: MoveRecord) => {
      const { intent, before } = record;
      if (record.cancelled) return;
      try {
        const task = await api.client.tasks.update({
          ...toUpdateInput({ key: intent.key, patch: intent.patch ?? {} }),
          ...(intent.to !== before.status ? { status: intent.to } : {}),
          ...(intent.sendPosition !== false && typeof intent.placement === 'object'
            ? { position: intent.placement }
            : {}),
          ifUpdatedAt: serverUpdatedAt.current.get(intent.key) ?? before.updatedAt,
        });
        serverUpdatedAt.current.set(task.key, task.updatedAt);
        const card = toCard(task);
        // Keep the card where the board put it; take the server's fields (rank, updatedAt).
        for (const { queryKey, status, data } of boardQueries(api, queryClient, projectKey)) {
          if (status !== card.status || !findCard(data, card.key)) continue;
          queryClient.setQueryData(queryKey, {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.key === card.key ? { ...item, ...card } : item)),
            })),
          });
        }
        queryClient.setQueryData(api.orpc.tasks.get.queryKey({ input: { key: task.key } }), task);
      } catch (error) {
        const current = conflictTask(error);
        // Later moves of this card were built on this one: drop them.
        for (const other of records.current) {
          if (other !== record && other.intent.key === intent.key) other.cancelled = true;
        }
        undoStack.current = undoStack.current.filter((entry) => entry.intent.key !== intent.key);
        syncUndo();
        const truth = current ? toCard(current) : before;
        if (current) serverUpdatedAt.current.set(current.key, current.updatedAt);
        else serverUpdatedAt.current.delete(intent.key);
        const shown = locateCard(api, queryClient, projectKey, intent.key)?.card;
        placeCard(api, queryClient, projectKey, truth, 'rank', shown?.status ?? intent.to);
        if (current)
          queryClient.setQueryData(api.orpc.tasks.get.queryKey({ input: { key: current.key } }), current);
        else patchTaskCache(api, queryClient, intent.key, truth);
        for (const other of [record, ...records.current]) {
          if (other.intent.key === intent.key && other.toastId !== undefined)
            dismissFieldToast(other.toastId);
        }
        const where =
          truth.status === intent.to && before.status === intent.to
            ? `Couldn't move ${intent.key}. It went back to its place in ${label(truth.status)}.`
            : `Couldn't move ${intent.key} to ${label(intent.to)}. It went back to ${label(truth.status)}.`;
        setProblem({
          key: intent.key,
          text: where,
          hint: current
            ? `Someone else changed the task while you ${intent.via === 'drag' ? 'dragged' : 'moved'} it. The board shows the latest version.`
            : describeError(error).message,
          retry: () => {
            setProblem(null);
            moveRef.current({ ...intent, ...(intent.placement === 'rank' ? { placement: 'top' } : {}) });
          },
        });
      }
    },
    [queryClient, projectKey, syncUndo, api],
  );

  const move = useCallback(
    (intent: MoveIntent, isUndo = false): boolean => {
      const located = locateCard(api, queryClient, projectKey, intent.key);
      if (!located) return false;
      const { card, previous, next } = located;
      if (samePlace(card, previous, next, intent)) return false;
      // Touched now, as the server will say: "Hide done tasks after" and the time orders keep it in view.
      const moved = applyTaskPatch(
        { ...card, status: intent.to },
        intent.patch ?? {},
        new Date().toISOString(),
      );
      void queryClient.cancelQueries({ queryKey: api.orpc.tasks.list.key() });
      placeCard(api, queryClient, projectKey, moved, intent.placement, card.status);
      patchTaskCache(api, queryClient, intent.key, moved);

      const record: MoveRecord = { intent, before: card, previous, next, isUndo, cancelled: false };
      records.current.push(record);
      if (!isUndo) {
        undoStack.current.push(record);
        syncUndo();
      }
      setProblem(null);
      record.toastId = showFieldToast({
        text: moveText(intent, card, isUndo),
        ...(isUndo
          ? {}
          : {
              undo: () => {
                const key = undoRecordRef.current(record);
                if (key) onUndoneRef.current?.(key);
              },
            }),
      });
      const position = positionOf(api, queryClient, projectKey, intent.key, intent.to);
      announceId.current++;
      setAnnouncement({
        id: announceId.current,
        text: position
          ? `${intent.key} is now ${position.position} of ${position.total} in ${label(intent.to)}.`
          : `${intent.key} is now in ${label(intent.to)}.`,
      });

      pending.current++;
      touched.current.add(intent.key);
      queue.current = queue.current
        .then(() => send(record))
        .finally(() => {
          records.current = records.current.filter((entry) => entry !== record);
          settle();
        });
      return true;
    },
    [queryClient, projectKey, send, settle, syncUndo, api],
  );
  moveRef.current = move;

  /** Puts one move back: the card returns to its status, its place and its lane's old value. */
  const undoRecord = useCallback(
    (record: MoveRecord): string | null => {
      const index = undoStack.current.indexOf(record);
      if (index < 0) return null;
      undoStack.current.splice(index, 1);
      syncUndo();
      const { before, intent } = record;
      const patch = hasPatch(intent.patch) ? (inversePatch(before, intent.patch) as MovePatch) : undefined;
      const moved = move(
        {
          key: before.key,
          to: before.status,
          placement: placementBetween(record.previous, record.next),
          ...(patch ? { patch } : {}),
          ...(intent.sendPosition === false ? { sendPosition: false } : {}),
          via: 'keyboard',
        },
        true,
      );
      return moved ? before.key : null;
    },
    [move, syncUndo],
  );
  undoRecordRef.current = undoRecord;

  const undo = useCallback((): string | null => {
    const record = undoStack.current.at(-1);
    return record ? undoRecord(record) : null;
  }, [undoRecord]);

  return {
    move,
    undo,
    canUndo,
    announcement,
    problem,
    dismissProblem: useCallback(() => setProblem(null), []),
  };
}
