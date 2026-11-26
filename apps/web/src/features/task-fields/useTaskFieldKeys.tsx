import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useCallback, useMemo, useState } from 'react';
import { type Command, openPalette, useRegisterCommands } from '~/features/palette/registry';
import { meQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { copyText, localToday, useHotkeys } from '~/ui';
import { AssigneePicker } from './AssigneePicker';
import { useFieldChange } from './apply';
import { BlockerPicker } from './BlockerPicker';
import { CheckAgainPicker } from './CheckAgainPicker';
import { DuePicker } from './DuePicker';
import { LabelPicker } from './LabelPicker';
import { ParentPicker } from './ParentPicker';
import { CyclePicker, MilestonePicker } from './PlanningPickers';
import { FIELD_COMMANDS, fieldStep } from './palette';
import { useProjectPlanning } from './planning';
import { type FieldPickerProps, PriorityPicker, StatusPicker } from './StatusPicker';
import { SubtaskPicker } from './SubtaskPicker';
import {
  contextOf,
  type FieldTarget,
  fieldRefusal,
  isFieldLocked,
  projectKeysOf,
  READ_ONLY_TEXT,
  type TaskFieldKey,
  toTargets,
} from './targets';
import { showFieldToast } from './toast';

// The keys of "A selected or open task" (shortcuts.md): S, P, A, I, L, Shift+D, Shift+M, Shift+C,
// Shift+B, Shift+S (one task only), Shift+W (M7, the check-again day, one task), ⌘C and ⌘⇧C, for the
// focused or selected tasks. Each opens its
// picker over the element the screen gives, or the matching palette step when there is none. The same
// actions are registered in the command palette (section "task", with the "PAY-142" or "3 selected"
// context pill).

/** Picker components by field. */
export const FIELD_PICKERS: Record<TaskFieldKey, (props: FieldPickerProps) => ReactNode> = {
  status: StatusPicker,
  priority: PriorityPicker,
  assignee: AssigneePicker,
  labels: LabelPicker,
  dueDate: DuePicker,
  milestone: MilestonePicker,
  cycle: CyclePicker,
  blockedBy: BlockerPicker,
  subtasks: SubtaskPicker,
  parent: ParentPicker,
  checkAgain: CheckAgainPicker,
};

const FIELD_ORDER: readonly TaskFieldKey[] = [
  'status',
  'priority',
  'assignee',
  'labels',
  'dueDate',
  'milestone',
  'cycle',
  'blockedBy',
  'subtasks',
  'parent',
  'checkAgain',
];

/**
 * Fields without a palette step: the check-again reason is typed in its picker, so the key opens the
 * picker over the screen's anchor, and without one it says where to set it.
 */
const PICKER_ONLY: ReadonlySet<TaskFieldKey> = new Set(['checkAgain']);

export type FieldAnchors =
  | RefObject<Element | null>
  | Partial<Record<TaskFieldKey, RefObject<Element | null>>>;

export interface UseTaskFieldKeysOptions {
  /** The open or focused task, or the selection. Nothing (or []) turns the keys off. */
  targets: FieldTarget | readonly FieldTarget[] | null | undefined;
  enabled?: boolean;
  /**
   * Where pickers open: one element for every field (the focused row), or one per field (property
   * rows). Fields without one open as a palette step.
   */
  anchors?: FieldAnchors;
  /** The screen opens its own picker for this field (a property row's): return true when it did. */
  onOpenField?: (field: TaskFieldKey) => boolean | undefined;
  /** Register the actions as palette commands (default true). */
  commands?: boolean;
  /** Absolute URL of a task, for ⌘⇧C. Defaults to this origin's /p/KEY/TASK. */
  linkOf?: (target: FieldTarget) => string;
}

export interface TaskFieldKeys {
  /** The field whose anchored picker is open. */
  open: TaskFieldKey | null;
  /** What the key for `field` does: opens its picker, or its palette step, or says why not. */
  openField: (field: TaskFieldKey) => void;
  close: () => void;
  assignToMe: () => void;
  copyKeys: () => void;
  copyLinks: () => void;
  /** Render once: the open anchored picker and the change toast. */
  pickers: ReactNode;
}

/** What the commands and keys read of a task: a new value when any of it changes. */
function signatureOf(target: FieldTarget): string {
  return [
    target.key,
    target.updatedAt,
    target.status,
    target.assignee?.id ?? '',
    (target.labels ?? []).map((label) => label.name).join('|'),
    (target.locked ?? []).join('|'),
    target.archivedAt ?? '',
    target.checkAgain ? `${target.checkAgain.on}|${target.checkAgain.reason}` : '',
  ].join(':');
}

function isRef(anchors: FieldAnchors | undefined): anchors is RefObject<Element | null> {
  return anchors != null && 'current' in anchors;
}

const defaultLink = (target: FieldTarget) =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/p/${target.project.key}/${target.key}`;

/** True while the person has text highlighted: ⌘C copies it, as usual. */
function hasTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  return (window.getSelection()?.toString() ?? '') !== '';
}

export function useTaskFieldKeys({
  targets,
  enabled = true,
  anchors,
  onOpenField,
  commands: withCommands = true,
  linkOf = defaultLink,
}: UseTaskFieldKeysOptions): TaskFieldKeys {
  const api = useApi();
  // Screens pass new arrays on every render; the commands only change when the tasks do.
  const given = toTargets(targets);
  const signature = given.map(signatureOf).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for `given`.
  const list = useMemo(() => given, [signature]);
  const active = enabled && list.length > 0;
  const queryClient = useQueryClient();
  const { apply } = useFieldChange();
  const me = useQuery({ ...meQuery(api), enabled: active }).data?.user;
  const singleProject = projectKeysOf(list).length === 1 ? list[0]?.project.key : undefined;
  const planning = useProjectPlanning(singleProject, active);
  const [open, setOpen] = useState<TaskFieldKey | null>(null);

  const anchorFor = useCallback(
    (field: TaskFieldKey): RefObject<Element | null> | undefined =>
      isRef(anchors) ? anchors : anchors?.[field],
    [anchors],
  );

  const stepContext = useCallback(
    () => ({ targets: list, apply, queryClient, context: contextOf(list), today: localToday() }),
    [list, apply, queryClient],
  );

  const openField = useCallback(
    (field: TaskFieldKey) => {
      if (list.length === 0) return;
      const refusal = fieldRefusal(list, field);
      const readOnly = list.length === 1 && isFieldLocked(list, field);
      if (refusal && !readOnly) {
        showFieldToast({ text: refusal, tone: 'error' });
        return;
      }
      if (onOpenField?.(field)) return;
      if (anchorFor(field)?.current) {
        setOpen(field);
        return;
      }
      if (readOnly) {
        showFieldToast({ text: READ_ONLY_TEXT, tone: 'error' });
        return;
      }
      if (PICKER_ONLY.has(field)) {
        showFieldToast({ text: 'Open the task to set its check-again day.', tone: 'error' });
        return;
      }
      void fieldStep(api, field, stepContext()).then(
        (step) => openPalette({ kind: 'step', step }),
        () => showFieldToast({ text: "Couldn't load the choices. Try again.", tone: 'error' }),
      );
    },
    [list, onOpenField, anchorFor, stepContext, api],
  );

  const assignToMe = useCallback(() => {
    if (!me || list.length === 0) return;
    const refusal = fieldRefusal(list, 'assignee');
    if (refusal) {
      showFieldToast({ text: refusal, tone: 'error' });
      return;
    }
    void apply(list, { assignee: { id: me.id, name: me.name, kind: me.kind, responsible: null } });
  }, [me, list, apply]);

  const copyKeys = useCallback(() => {
    if (list.length === 0) return;
    void copyText(list.map((target) => target.key).join(', ')).then((ok) =>
      showFieldToast(
        ok
          ? { text: list.length === 1 ? `Copied ${list[0]?.key}` : `Copied ${list.length} keys` }
          : { text: "Couldn't copy. Your browser blocked the clipboard.", tone: 'error' },
      ),
    );
  }, [list]);

  const copyLinks = useCallback(() => {
    if (list.length === 0) return;
    void copyText(list.map(linkOf).join('\n')).then((ok) =>
      showFieldToast(
        ok
          ? { text: list.length === 1 ? `Copied the link to ${list[0]?.key}` : `Copied ${list.length} links` }
          : { text: "Couldn't copy. Your browser blocked the clipboard.", tone: 'error' },
      ),
    );
  }, [list, linkOf]);

  const showsField = useCallback(
    (field: TaskFieldKey) => {
      if (field === 'milestone') return !planning.isKnown || planning.usesMilestones;
      if (field === 'cycle') return !planning.isKnown || planning.usesCycles;
      if (field === 'subtasks' || field === 'blockedBy' || field === 'parent') return list.length === 1;
      return true;
    },
    [planning.isKnown, planning.usesMilestones, planning.usesCycles, list.length],
  );

  const key = (field: TaskFieldKey) => (showsField(field) ? () => openField(field) : null);
  useHotkeys(
    {
      s: key('status'),
      p: key('priority'),
      a: key('assignee'),
      i: assignToMe,
      l: key('labels'),
      'Shift+d': key('dueDate'),
      'Shift+m': key('milestone'),
      'Shift+c': key('cycle'),
      'Shift+b': key('blockedBy'),
      // A subtask needs one parent: with several tasks selected Shift+S does nothing (conflict 7).
      'Shift+s': key('subtasks'),
      'Shift+w': key('checkAgain'),
      'Mod+c': {
        allowInInputs: false,
        preventDefault: false,
        handler: (event) => {
          if (hasTextSelection()) return;
          event.preventDefault();
          copyKeys();
        },
      },
      'Mod+Shift+c': { allowInInputs: false, handler: copyLinks },
    },
    // While a picker of this hook is open, its own keys apply.
    { enabled: active && open === null },
  );

  const commands = useMemo<Command[]>(() => {
    if (!active || !withCommands) return [];
    const context = contextOf(list);
    const many = list.length > 1;
    const fieldCommands = FIELD_ORDER.filter((field) => showsField(field) && !PICKER_ONLY.has(field)).map(
      (field): Command => {
        const meta = FIELD_COMMANDS[field];
        const refusal = fieldRefusal(list, field);
        return {
          id: `task.${field}`,
          title: meta.title,
          section: 'task',
          keywords: meta.keywords,
          ...(meta.shortcut ? { shortcut: meta.shortcut } : {}),
          context,
          ...(refusal ? { disabledReason: refusal } : {}),
          run: () => fieldStep(api, field, stepContext()),
        };
      },
    );
    const assignRefusal = fieldRefusal(list, 'assignee');
    return [
      ...fieldCommands,
      {
        id: 'task.assign-me',
        title: 'Assign to me',
        section: 'task',
        keywords: ['me', 'mine', 'take'],
        shortcut: 'i',
        context,
        ...(assignRefusal ? { disabledReason: assignRefusal } : {}),
        run: () => {
          assignToMe();
          return undefined;
        },
      },
      {
        id: 'task.copy-keys',
        title: many ? `Copy ${list.length} keys` : 'Copy key',
        section: 'task',
        keywords: ['copy', 'id'],
        shortcut: 'Mod+c',
        context,
        run: () => {
          copyKeys();
          return undefined;
        },
      },
      {
        id: 'task.copy-links',
        title: many ? `Copy ${list.length} links` : 'Copy link',
        section: 'task',
        keywords: ['copy', 'url', 'share'],
        shortcut: 'Mod+Shift+c',
        context,
        run: () => {
          copyLinks();
          return undefined;
        },
      },
    ];
  }, [active, withCommands, list, showsField, stepContext, assignToMe, copyKeys, copyLinks, api]);
  useRegisterCommands(commands);

  const close = useCallback(() => setOpen(null), []);
  const Picker = open ? FIELD_PICKERS[open] : null;
  const anchor = open ? anchorFor(open) : undefined;
  const pickers = (
    <>
      {Picker && anchor && list.length > 0 ? (
        <Picker
          key={`${open}:${list.map((target) => target.key).join(',')}`}
          targets={list}
          isOpen
          onOpenChange={(isOpen) => {
            if (!isOpen) setOpen(null);
          }}
          triggerRef={anchor}
        />
      ) : null}
    </>
  );

  return { open, openField, close, assignToMe, copyKeys, copyLinks, pickers };
}
