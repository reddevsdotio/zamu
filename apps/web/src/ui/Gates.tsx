import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton, Dialog as AriaDialog, Popover as AriaPopover } from 'react-aria-components';
import { Button } from './Button';
import { cn } from './cn';
import { ConfirmBody, Dialog, DialogFooter, Modal } from './Dialog';
import { inputBase } from './Field';
import { AlertGlyph, CheckGlyph, GateGlyph, LockGlyph } from './Glyphs';
import { MenuFooter } from './PickerMenu';
import { SegmentedControl } from './SegmentedControl';
import { isEditableTarget, useHotkeys } from './useHotkeys';
import { ClippedText } from './WorkRecord';

/*
 * Gates of a milestone's waves (m8.css .gate, .gatebox, .gate-pop, .stopline, .okline, .dlg.lk): the pill
 * on a wave header, the box at the end of a wave with its checks and the latest result, the step that
 * records a result, the lines across the top of the milestone page when a gate failed or every gate passed,
 * and the warning a person sees before starting a task in a locked wave. A gate state always shows as a
 * word or a glyph, never as colour alone. Props are plain values; times come preformatted from the screen,
 * which formats them once useNow() has a value.
 */

/** A gate's state: Open until the first result, then the latest result. */
export type GateState = 'open' | 'passed' | 'failed';
/** A recorded result. */
export type GateResultState = Exclude<GateState, 'open'>;

export const GATE_STATE_LABELS: Record<GateState, string> = {
  open: 'Gate open',
  passed: 'Gate passed',
  failed: 'Gate failed',
};

/** "W3", the short name of a wave. */
export function waveRef(number: number): string {
  return `W${number}`;
}

const SMALL_NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Counts in running text: "five" up to ten, digits after. */
export function countWord(count: number, capital = false): string {
  const word = SMALL_NUMBERS[count] ?? String(count);
  return capital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** "W4", "W4 and W5", "W4, W5 and W6". */
export function listWaves(waves: readonly string[]): string {
  if (waves.length <= 1) return waves[0] ?? '';
  return `${waves.slice(0, -1).join(', ')} and ${waves[waves.length - 1]}`;
}

// ── Pill ────────────────────────────────────────────────────────────────────────────────────────────────

export type GatePillState = GateState | 'locked';

/** "Gate open", "Gate passed", "Gate failed"; a locked wave says what it waits for. */
export function gatePillText(state: GatePillState, lockedUntil?: string | null): string {
  if (state === 'locked') return lockedUntil ? `Locked until ${lockedUntil} passes` : 'Locked';
  return GATE_STATE_LABELS[state];
}

const PILL: Record<GatePillState, string> = {
  open: 'bg-bg-lane px-2.25 font-semibold text-fg-2',
  passed: 'bg-ok-soft px-2.25 font-semibold text-ok',
  failed: 'bg-danger-soft px-2.25 font-semibold text-danger',
  // A locked wave has no pill ground: the lock and its words sit at the end of the header.
  locked: 'font-medium text-fg-3',
};

export interface GatePillProps {
  state: GatePillState;
  /** Locked: the wave it waits for, "W3" ("Locked until W3 passes"). Leave it out for "Locked". */
  lockedUntil?: string | null;
  /** Replaces the words: "7 gates passed" on folded waves. */
  label?: string;
  className?: string;
}

/** The gate's state on a wave header (frames 103, 108): open, passed with a tick, failed with a mark, locked. */
export function GatePill({ state, lockedUntil, label, className }: GatePillProps) {
  return (
    <span
      data-part="gate-pill"
      data-state={state}
      className={cn(
        'box-border inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-pill text-xs whitespace-nowrap',
        PILL[state],
        className,
      )}
    >
      {state === 'passed' ? <CheckGlyph className="h-2 w-2.5" /> : null}
      {state === 'failed' ? <AlertGlyph className="size-3" /> : null}
      {state === 'locked' ? <LockGlyph /> : null}
      {label ?? gatePillText(state, lockedUntil)}
    </span>
  );
}

// ── Box ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface GateResultView {
  state: GateResultState;
  /** Who recorded it: "claude-dev", "Ana Ruiz". */
  by: string;
  /** The person an agent acted for: "Ana". */
  onBehalfOf?: string | null;
  /** When, preformatted once useNow() has a value: "20 min ago", "yesterday". Null before. */
  when?: string | null;
  /** The note, rendered by the screen (Markdown). */
  note: ReactNode;
}

/** "claude-dev for Ana, 20 min ago". */
export function gateResultByline(result: Pick<GateResultView, 'by' | 'onBehalfOf' | 'when'>): string {
  const who = result.onBehalfOf ? `${result.by} for ${result.onBehalfOf}` : result.by;
  return result.when ? `${who}, ${result.when}` : who;
}

/** Why Pass is disabled: "Pass unlocks when the 2 open tasks are done". */
export function passBlockedText(openTasks: number): string {
  return openTasks === 1
    ? 'Pass unlocks when the open task is done'
    : `Pass unlocks when the ${openTasks} open tasks are done`;
}

export interface GateBoxProps {
  /** The gate's state: open until a result is recorded, then the latest result. */
  state: GateState;
  /** What the gate checks, rendered by the screen (Markdown), or an editor while it is being changed. */
  description?: ReactNode;
  /** The latest result, shown under the description with who, for whom, when and the note. */
  result?: GateResultView | null;
  /**
   * Tasks of the wave that are not done or canceled. Above zero, Pass is disabled and says what it waits
   * for ("Pass unlocks when the 2 open tasks are done").
   */
  openTasks?: number;
  /** Replaces the reason computed from `openTasks`. */
  passBlockedReason?: ReactNode;
  /** Open gate: draws Pass. */
  onPass?: () => void;
  /** Open gate: draws Fail, which can be recorded at any time. */
  onFail?: () => void;
  /** Gate with a result: draws Record again. */
  onRecordAgain?: () => void;
  /** Key hint on Pass and Record again. Defaults to G; the screen binds the key. Null hides it. */
  recordKbd?: string | null;
  /** G while focus is inside the box: the screen opens the result step. */
  onGateKey?: () => void;
  /** Lines of the note shown before "Show the whole note". Defaults to 4. */
  noteLines?: number;
  /** Accessible name of the box: "Gate of W3 · Screens". */
  label?: string;
  /** The target of "Go to the gate". */
  id?: string;
  className?: string;
}

/**
 * The gate at the end of a wave (m8.css .gatebox, frames 103, 107 to 109, 121): what it checks, then Fail
 * and Pass while it is open (Pass disabled with its reason while tasks are open), or the latest result with
 * its note and Record again. A failed gate carries a danger rule on its left edge and the word Failed.
 */
export function GateBox({
  state,
  description,
  result,
  openTasks = 0,
  passBlockedReason,
  onPass,
  onFail,
  onRecordAgain,
  recordKbd = 'G',
  onGateKey,
  noteLines = 4,
  label = 'Gate',
  id,
  className,
}: GateBoxProps) {
  const reasonId = useId();
  const blocked = passBlockedReason ?? (openTasks > 0 ? passBlockedText(openTasks) : null);
  const showOpenActions = state === 'open' && (onPass != null || onFail != null);
  const onKeyDown = onGateKey
    ? (event: KeyboardEvent<HTMLElement>) => {
        if (isPlainKey(event, 'g') && !isEditableTarget(event.target)) {
          event.preventDefault();
          onGateKey();
        }
      }
    : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group with a name, not a form fieldset.
    <div
      role="group"
      aria-label={label}
      id={id}
      tabIndex={id ? -1 : undefined}
      data-part="gate-box"
      data-state={state}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex max-w-215 items-start gap-3 rounded-md bg-surface px-3.5 py-3 shadow-card outline-none',
        state === 'failed' && 'shadow-[var(--shadow-card),inset_3px_0_0_var(--danger)]',
        className,
      )}
    >
      <GateGlyph className="mt-1.25 text-fg-2" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.25">
        <div className="flex min-w-0 items-center gap-2 text-sm text-fg-3">
          <b className="text-md font-semibold text-fg">Gate</b>
          {result ? (
            <span className="min-w-0 truncate">
              <span
                data-part="result-word"
                className={cn('font-semibold', result.state === 'failed' ? 'text-danger' : 'text-ok')}
              >
                {result.state === 'failed' ? 'Failed' : 'Passed'}
              </span>
              {` · ${gateResultByline(result)}`}
            </span>
          ) : null}
        </div>
        {description ? (
          <div className="text-md leading-normal text-pretty text-fg">{description}</div>
        ) : (
          <div className="text-md text-fg-3">No checks written for this gate yet.</div>
        )}
        {result ? (
          <ClippedText
            lines={noteLines}
            showLabel="Show the whole note"
            lessLabel="Show less"
            contentClassName="border-l-2 border-line pl-2.5 text-md leading-normal text-pretty text-fg-2 [&_p]:m-0 [&_p+p]:mt-1.5"
          >
            {result.note}
          </ClippedText>
        ) : null}
      </div>
      {showOpenActions ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {onPass && blocked ? (
            <span id={reasonId} className="mr-1 text-xs text-fg-3">
              {blocked}
            </span>
          ) : null}
          {onFail ? (
            <Button variant="secondary" size="sm" onPress={onFail}>
              Fail
            </Button>
          ) : null}
          {onPass ? (
            <Button
              size="sm"
              kbd={recordKbd ?? undefined}
              isDisabled={blocked != null}
              aria-describedby={blocked ? reasonId : undefined}
              onPress={onPass}
            >
              Pass
            </Button>
          ) : null}
        </div>
      ) : state !== 'open' && onRecordAgain ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" kbd={recordKbd ?? undefined} onPress={onRecordAgain}>
            Record again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Recording a result ──────────────────────────────────────────────────────────────────────────────────

/** The longest note the server takes. */
export const GATE_NOTE_MAX_LENGTH = 10_000;

/** The line under the note: what happens once the result is recorded. */
export function gateNextStepText(state: GateResultState, nextWave?: string | null): string {
  if (state === 'passed') {
    return nextWave
      ? `The note stays with the gate. ${nextWave} unlocks as soon as this passes.`
      : 'The note stays with the gate. This is the last gate of the milestone.';
  }
  return nextWave
    ? `The note stays with the gate, and ${nextWave} stays locked. No task is reopened: log the fix as a task in this wave.`
    : 'The note stays with the gate. No task is reopened: log the fix as a task in this wave.';
}

export interface GateResultPanelProps {
  /** "Gate of W3 · Screens". Also the dialog's accessible name. */
  title: string;
  /** The result picked when the step opens. Defaults to Passed, or Failed while Pass is blocked. */
  defaultState?: GateResultState;
  /** Pass is not possible yet: Passed can't be picked, and this says why. */
  passBlockedReason?: ReactNode;
  defaultNote?: string;
  /** The wave after this one, "W4", for the next-step line. Null on the last wave. */
  nextWave?: string | null;
  /** Called with the result and the trimmed note on ⌘↵ or Record, when the note is not empty. */
  onRecord: (state: GateResultState, note: string) => void;
  /** Esc in the step. */
  onCancel: () => void;
  /** The request is running: Record shows its pending dot. */
  isPending?: boolean;
  /** The server refused the result (open tasks, no permission). */
  error?: ReactNode;
  /** Focus the note on mount. On in GateResultPopover. */
  autoFocus?: boolean;
  maxLength?: number;
  className?: string;
}

/**
 * Recording a gate result (m8.css .gate-pop, frame 107): Passed or Failed, the note (required: a result is
 * evidence) and one line on what happens next. ⌘↵ records, Esc cancels. Works on its own in galleries and
 * inside GateResultPopover.
 */
export function GateResultPanel({
  title,
  defaultState,
  passBlockedReason,
  defaultNote = '',
  nextWave,
  onRecord,
  onCancel,
  isPending = false,
  error,
  autoFocus = false,
  maxLength = GATE_NOTE_MAX_LENGTH,
  className,
}: GateResultPanelProps) {
  const passBlocked = passBlockedReason != null && passBlockedReason !== false;
  const [state, setState] = useState<GateResultState>(passBlocked ? 'failed' : (defaultState ?? 'passed'));
  const [note, setNote] = useState(defaultNote);
  const [missing, setMissing] = useState(false);
  const titleId = useId();
  const noteId = useId();
  const labelId = useId();
  const helpId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // Focused in an effect, as in WaivePanel: the popover's focus scope must exist first.
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const submit = () => {
    if (isPending) return;
    const trimmed = note.trim();
    if (trimmed) onRecord(state, trimmed);
    else {
      setMissing(true);
      field.current?.focus();
    }
  };
  return (
    <div className={cn('flex flex-col text-sm text-fg', className)}>
      <div id={titleId} className="px-3.5 pt-3 pb-1.5 text-xs font-medium text-fg-3">
        {title}
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-2">
        <SegmentedControl<GateResultState>
          aria-label="Result"
          items={[
            { id: 'passed', label: 'Passed', isDisabled: passBlocked },
            { id: 'failed', label: 'Failed' },
          ]}
          value={state}
          onChange={setState}
          className="self-start"
        />
        {passBlocked ? <span className="text-xs text-fg-3">{passBlockedReason}</span> : null}
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        <label id={labelId} htmlFor={noteId} className="text-sm font-medium text-fg-2">
          Note
        </label>
        <textarea
          ref={field}
          id={noteId}
          value={note}
          rows={3}
          maxLength={maxLength}
          placeholder="What was checked, and what it found"
          aria-describedby={helpId}
          aria-invalid={missing || undefined}
          data-invalid={missing || undefined}
          className={cn(inputBase, 'min-h-16 resize-y px-2.75 py-2 leading-normal')}
          onChange={(event) => {
            setNote(event.target.value);
            if (missing) setMissing(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Escape') {
              // Handled here so the popover does not close a second time.
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        <span id={helpId} className={cn('text-xs', missing ? 'font-medium text-danger' : 'text-fg-3')}>
          {missing
            ? 'Write what was checked: the note is the evidence for the result.'
            : gateNextStepText(state, nextWave)}
        </span>
        {error ? (
          <p role="alert" className="m-0 text-xs font-medium text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <MenuFooter
        hints={[
          { keys: '⌘↵', label: 'record' },
          { keys: 'Esc', label: 'cancel' },
        ]}
        end={
          <Button size="sm" isPending={isPending} onPress={submit}>
            Record
          </Button>
        }
      />
    </div>
  );
}

export interface GateResultPopoverProps extends Omit<GateResultPanelProps, 'autoFocus' | 'className'> {
  /** Pass, Fail or Record again: the popover opens above it, at its right edge. */
  triggerRef: RefObject<Element | null>;
  isOpen: boolean;
}

/** GateResultPanel in a 380px popover anchored to the button that opened it. Clicking outside cancels. */
export function GateResultPopover({ triggerRef, isOpen, onCancel, ...panel }: GateResultPopoverProps) {
  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      placement="top end"
      offset={6}
      className="w-95 max-w-[calc(100vw-24px)] overflow-hidden rounded-lg bg-surface-pop text-fg shadow-pop outline-none"
    >
      <AriaDialog aria-label={panel.title} className="outline-none">
        <GateResultPanel {...panel} onCancel={onCancel} autoFocus />
      </AriaDialog>
    </AriaPopover>
  );
}

// ── Lines across the top of the page ────────────────────────────────────────────────────────────────────

export interface PlanStopLineProps {
  /** The wave whose gate failed: "W3 · Screens". */
  wave: string;
  /** The waves it keeps locked: ["W4", "W5"]. */
  locked?: readonly string[];
  /** Draws "Go to the gate": scroll to the gate box and focus it. */
  onGoToGate?: () => void;
  className?: string;
}

/** A failed gate stops the plan (m8.css .stopline, frame 108). */
export function PlanStopLine({ wave, locked = [], onGoToGate, className }: PlanStopLineProps) {
  const rest =
    locked.length === 0
      ? 'The plan stops here until it passes.'
      : `The plan stops here: ${listWaves(locked)} ${locked.length === 1 ? 'stays' : 'stay'} locked until it passes.`;
  return (
    <div
      role="note"
      data-part="plan-stop"
      className={cn(
        'flex items-center gap-2.5 rounded-md bg-danger-soft px-3.5 py-2.75 text-md font-medium text-danger',
        className,
      )}
    >
      <AlertGlyph />
      <p className="m-0 min-w-0 flex-1">
        <b className="font-semibold">The gate of {wave} failed.</b>{' '}
        <span className="font-normal">{rest}</span>
      </p>
      {onGoToGate ? (
        <AriaButton
          onPress={onGoToGate}
          className="shrink-0 cursor-pointer rounded-sm text-danger underline underline-offset-2 outline-none hover:opacity-80 focus-visible:focus-ring"
        >
          Go to the gate
        </AriaButton>
      ) : null}
    </div>
  );
}

export interface PlanDoneLineProps {
  /** How many gates passed: all of them. */
  gates: number;
  /** Tasks of the milestone in no wave that are not done or canceled. */
  openOutside?: number;
  /** Tasks in passed waves that were added or reopened after their gate passed. */
  openInWaves?: number;
  className?: string;
}

/** "All five gates passed. Two tasks outside the waves are still open." */
export function planDoneText({ gates, openOutside = 0, openInWaves = 0 }: PlanDoneLineProps): string {
  const head = gates === 1 ? 'The gate passed.' : `All ${countWord(gates)} gates passed.`;
  const inWaves =
    openInWaves > 0
      ? ` ${countWord(openInWaves, true)} ${openInWaves === 1 ? 'task in the waves is' : 'tasks in the waves are'} open again.`
      : '';
  const outside =
    openOutside > 0
      ? ` ${countWord(openOutside, true)} ${openOutside === 1 ? 'task outside the waves is' : 'tasks outside the waves are'} still open.`
      : '';
  return head + inWaves + outside;
}

/** Every gate passed (m8.css .okline, frame 109). */
export function PlanDoneLine({ className, ...counts }: PlanDoneLineProps) {
  return (
    <div
      role="note"
      data-part="plan-done"
      className={cn(
        'flex items-center gap-2.5 rounded-md bg-ok-soft px-3.5 py-2.75 text-md font-medium text-ok',
        className,
      )}
    >
      <CheckGlyph />
      <p className="m-0 min-w-0 flex-1">{planDoneText(counts)}</p>
    </div>
  );
}

// ── Locked-wave warning ─────────────────────────────────────────────────────────────────────────────────

export interface LockedWaveWarningProps {
  /** The locked wave: "W4". */
  wave: string;
  /** The wave whose gate it waits for: "W3 · Screens". */
  waitsFor: string;
  /** The task being started: "PAY-174". */
  taskKey: string;
  /** Cancel and Esc: the status stays. */
  onCancel: () => void;
  /** Start anyway and ⌘↵. */
  onStart: () => void;
  /** Gallery frames: a plain heading instead of the dialog title, and no ⌘↵ binding. */
  isStatic?: boolean;
}

/**
 * The warning a person sees before starting a task in a locked wave (m8.css .dlg.lk, frame 114): title,
 * what it means, a note that agents are refused, Cancel and Start anyway (⌘↵). Put it inside a Dialog, or
 * use LockedWaveDialog.
 */
export function LockedWaveWarning({
  wave,
  waitsFor,
  taskKey,
  onCancel,
  onStart,
  isStatic = false,
}: LockedWaveWarningProps) {
  useHotkeys({ 'Mod+Enter': onStart }, { enabled: !isStatic, allowInOverlays: true });
  return (
    <>
      <ConfirmBody title={`${wave} is still locked`} isStatic={isStatic}>
        The gate of {waitsFor} hasn’t passed yet. Starting {taskKey} now works ahead of the plan, and its
        result may have to be redone.
      </ConfirmBody>
      <DialogFooter
        start={<span className="text-xs text-fg-3">Agents can’t start tasks in a locked wave.</span>}
      >
        <Button variant="secondary" onPress={onCancel} autoFocus={!isStatic}>
          Cancel
        </Button>
        <Button kbd="⌘↵" onPress={onStart}>
          Start anyway
        </Button>
      </DialogFooter>
    </>
  );
}

export interface LockedWaveDialogProps extends Omit<LockedWaveWarningProps, 'isStatic'> {
  isOpen: boolean;
}

/** LockedWaveWarning in a 500px alert dialog. Esc and a click on the scrim cancel. */
export function LockedWaveDialog({ isOpen, onCancel, ...props }: LockedWaveDialogProps) {
  return (
    <Modal
      width={500}
      top={220}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog role="alertdialog">
        <LockedWaveWarning {...props} onCancel={onCancel} />
      </Dialog>
    </Modal>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────

/** A bare key with no modifier: G records a gate, not ⌘G or ⇧G. */
export function isPlainKey(event: KeyboardEvent<Element>, key: string): boolean {
  return (
    event.key.toLowerCase() === key &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing
  );
}
