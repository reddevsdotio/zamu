import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton, type Key } from 'react-aria-components';
import { Button } from './Button';
import { cn } from './cn';
import { inputBase } from './Field';
import { GatePill, type GateState, isPlainKey, waveRef } from './Gates';
import { AlertGlyph, CaretGlyph, CheckGlyph, GripGlyph, LockGlyph, PlusGlyph } from './Glyphs';
import { Kbd } from './Kbd';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from './Menu';
import { ProgressBar } from './Progress';

/*
 * Waves of a milestone (m8.css .wave-hd, .wave-n, .wave-add, .ms-wv, the move toast): the header of a wave
 * with its number, name, progress and gate pill; the folded line for a run of passed waves; the header of
 * the tasks in no wave; adding a wave; the wave status under a milestone's name in the list; the hint while
 * a task moves between waves; and the lock mark on a task in a locked wave. Props are plain values, so the
 * milestone page and the list can feed them from the contract types.
 */

/** Longest wave name the server takes. */
export const WAVE_NAME_MAX_LENGTH = 100;

// ── Number chip ─────────────────────────────────────────────────────────────────────────────────────────

export interface WaveNumberProps {
  /** "W3", or "W1–7" on folded waves. */
  children: ReactNode;
  /** The current wave: accent fill. */
  current?: boolean;
  /** A locked wave: quiet text. */
  locked?: boolean;
  className?: string;
}

/** The wave's number in a 20px chip (m8.css .wave-n). */
export function WaveNumber({ children, current = false, locked = false, className }: WaveNumberProps) {
  return (
    <span
      data-part="wave-number"
      data-current={current || undefined}
      className={cn(
        'inline-grid h-5 min-w-7 shrink-0 place-items-center rounded-[5px] px-1.5 text-xs font-semibold tabular-nums',
        current ? 'bg-accent text-accent-ink' : 'bg-bg-lane',
        !current && (locked ? 'text-fg-3' : 'text-fg-2'),
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────────────────────────────────

/** The row look shared by wave headers, the folded line, "Not in a wave" and "Add a wave". */
const headerRow =
  'group/wave relative flex h-11 min-w-0 items-center gap-2.5 border-b border-line-soft pr-4.5 pl-4 whitespace-nowrap';

/** Shown on hover, keyboard focus inside the row, and while the menu is open. */
const onHover =
  'opacity-0 group-hover/wave:opacity-100 group-focus-within/wave:opacity-100 aria-expanded:opacity-100';

export interface WaveHeaderProps {
  /** Position in the milestone, from 1: drawn as "W3". */
  number: number;
  name: string;
  /** Tasks done or canceled. */
  done: number;
  /** Tasks in the wave (hidden ones left out). */
  total: number;
  /** Tasks in progress or in review, drawn after `done` in the bar. */
  inProgress?: number;
  /** The gate's state. A locked wave shows the lock in its place. */
  gate: GateState;
  /** The first wave whose gate has not passed: the number takes the accent. */
  current?: boolean;
  /** An earlier gate has not passed. */
  locked?: boolean;
  /** The wave it waits for, when it is the first wave after the gate that holds it ("Locked until W3 passes"). */
  lockedUntil?: number | null;
  /** Tasks open in a passed wave (added or reopened after the pass): "1 task open" next to the pill. */
  openAfterPass?: number;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Id of the wave's body, for aria-controls. */
  controls?: string;
  /** The name is an input: Enter saves, Esc cancels. */
  renaming?: boolean;
  onRename?: (name: string) => void;
  onRenameCancel?: () => void;
  /** Header menu items; each one that is set appears. */
  onRenameStart?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  /** Props for the drag grip (the screen wires drag and drop). The grip shows when this is set. */
  gripProps?: HTMLAttributes<HTMLSpanElement>;
  /** G while the header has focus: the screen opens the gate's result step. */
  onGateKey?: () => void;
  /** Galleries and static frames only: draw the hover look without the pointer. */
  look?: 'hover';
  id?: string;
  className?: string;
}

/**
 * The header of a wave (m8.css .wave-hd, frames 103, 113): caret, number, name, progress and the gate pill.
 * The caret, number and name are one disclosure button; ← and → collapse and expand it, and G asks for the
 * gate's result. On hover and focus a grip and a menu (rename, move, remove) appear before the pill.
 */
export function WaveHeader({
  number,
  name,
  done,
  total,
  inProgress = 0,
  gate,
  current = false,
  locked = false,
  lockedUntil,
  openAfterPass = 0,
  expanded,
  onExpandedChange,
  controls,
  renaming = false,
  onRename,
  onRenameCancel,
  onRenameStart,
  onMoveUp,
  onMoveDown,
  onRemove,
  gripProps,
  onGateKey,
  look,
  id,
  className,
}: WaveHeaderProps) {
  const ref = waveRef(number);
  const hasMenu = onRenameStart != null || onMoveUp != null || onMoveDown != null || onRemove != null;
  const forced = look === 'hover';
  const onKeyDown = (event: KeyboardEvent<Element>) => {
    if (event.key === 'ArrowLeft' && expanded) {
      event.preventDefault();
      onExpandedChange?.(false);
    } else if (event.key === 'ArrowRight' && !expanded) {
      event.preventDefault();
      onExpandedChange?.(true);
    } else if (onGateKey && isPlainKey(event, 'g')) {
      event.preventDefault();
      onGateKey();
    }
  };
  const onAction = (key: Key) => {
    if (key === 'rename') onRenameStart?.();
    else if (key === 'up') onMoveUp?.();
    else if (key === 'down') onMoveDown?.();
    else if (key === 'remove') onRemove?.();
  };
  return (
    <div
      id={id}
      data-part="wave-header"
      data-current={current || undefined}
      data-locked={locked || undefined}
      className={cn(headerRow, 'hover:bg-bg-grp', forced && 'bg-bg-grp', className)}
    >
      <AriaButton
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={renaming ? ref : `${ref} · ${name}`}
        onPress={() => onExpandedChange?.(!expanded)}
        onKeyDown={onKeyDown}
        className={cn(
          'flex min-w-0 shrink cursor-pointer items-center gap-2.5 rounded-sm outline-none focus-visible:focus-ring',
          !renaming && 'max-w-[60%]',
        )}
      >
        <CaretGlyph className={cn('text-fg-3 transition-transform', !expanded && '-rotate-90')} />
        <WaveNumber current={current} locked={locked}>
          {ref}
        </WaveNumber>
        {renaming ? null : (
          <span className={cn('min-w-0 truncate font-semibold', locked ? 'text-fg-3' : 'text-fg')}>
            {name}
          </span>
        )}
      </AriaButton>
      {renaming ? (
        <WaveNameInput
          label={`Name of ${ref}`}
          defaultValue={name}
          onSave={(value) => onRename?.(value)}
          onCancel={() => onRenameCancel?.()}
          className="w-70"
        />
      ) : null}
      <span className="inline-flex shrink-0 items-center gap-2 text-sm text-fg-3 tabular-nums">
        <ProgressBar
          done={done}
          inProgress={inProgress}
          total={total}
          label={`${ref} progress`}
          className="w-16 flex-none"
        />
        <span aria-hidden>
          {done} of {total}
        </span>
      </span>
      <span className="flex-1" />
      {gripProps ? (
        <span
          {...gripProps}
          data-part="grip"
          className={cn(
            'inline-flex h-6.5 w-4 cursor-grab items-center justify-center text-fg-3',
            !forced && onHover,
            gripProps.className,
          )}
        >
          <GripGlyph />
        </span>
      ) : null}
      {hasMenu ? (
        <MenuTrigger>
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label={`Actions for ${ref}`}
            className={cn('tracking-widest', !forced && onHover)}
          >
            ···
          </Button>
          <Menu onAction={onAction}>
            {onRenameStart ? <MenuItem id="rename">Rename</MenuItem> : null}
            {onMoveUp ? (
              <MenuItem id="up" isDisabled={number === 1}>
                Move up
              </MenuItem>
            ) : null}
            {onMoveDown ? <MenuItem id="down">Move down</MenuItem> : null}
            {onRemove ? <MenuSeparator /> : null}
            {onRemove ? (
              <MenuItem id="remove" tone="danger">
                Remove wave
              </MenuItem>
            ) : null}
          </Menu>
        </MenuTrigger>
      ) : null}
      {gate === 'passed' && openAfterPass > 0 && !locked ? (
        <span className="text-xs text-fg-3">
          {openAfterPass === 1 ? '1 task open' : `${openAfterPass} tasks open`}
        </span>
      ) : null}
      {locked ? (
        <GatePill state="locked" lockedUntil={lockedUntil ? waveRef(lockedUntil) : null} />
      ) : (
        <GatePill state={gate} />
      )}
    </div>
  );
}

// ── Folded passed waves, "Not in a wave" ────────────────────────────────────────────────────────────────

export interface FoldedWavesHeaderProps {
  /** First and last wave of the run: 1 and 7 draw "W1–7". */
  from: number;
  to: number;
  /** Tasks in those waves. */
  tasks: number;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  controls?: string;
  className?: string;
}

/** A run of passed waves folded into one line (frame 121): "W1–7  7 waves, all passed  41 tasks". */
export function FoldedWavesHeader({
  from,
  to,
  tasks,
  expanded,
  onExpandedChange,
  controls,
  className,
}: FoldedWavesHeaderProps) {
  const count = to - from + 1;
  return (
    <div data-part="folded-waves" className={cn(headerRow, 'hover:bg-bg-grp', className)}>
      <Disclosure
        label={`W${from} to W${to}, ${count} waves, all passed`}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        controls={controls}
      >
        <WaveNumber>{`W${from}–${to}`}</WaveNumber>
        <span className="font-medium text-fg-2">{count} waves, all passed</span>
      </Disclosure>
      <span className="text-sm text-fg-3 tabular-nums">{tasks === 1 ? '1 task' : `${tasks} tasks`}</span>
      <span className="flex-1" />
      <GatePill state="passed" label={`${count} gates passed`} />
    </div>
  );
}

export interface NoWaveHeaderProps {
  /** Tasks of the milestone in no wave. */
  tasks: number;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  controls?: string;
  className?: string;
}

/** The group of tasks in no wave, at the end (frames 103, 109). It has no gate. */
export function NoWaveHeader({ tasks, expanded, onExpandedChange, controls, className }: NoWaveHeaderProps) {
  return (
    <div data-part="no-wave" className={cn(headerRow, 'hover:bg-bg-grp', className)}>
      <Disclosure
        label="Not in a wave"
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        controls={controls}
      >
        <span className="font-medium text-fg-2">Not in a wave</span>
      </Disclosure>
      <span className="text-sm text-fg-3 tabular-nums">{tasks === 1 ? '1 task' : `${tasks} tasks`}</span>
      <span className="flex-1" />
      <span className="text-xs font-medium text-fg-3">No gate. These never hold a wave up.</span>
    </div>
  );
}

function Disclosure({
  label,
  expanded,
  onExpandedChange,
  controls,
  children,
}: {
  label: string;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  controls?: string;
  children: ReactNode;
}) {
  return (
    <AriaButton
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
      onPress={() => onExpandedChange?.(!expanded)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && expanded) onExpandedChange?.(false);
        else if (event.key === 'ArrowRight' && !expanded) onExpandedChange?.(true);
      }}
      className="flex min-w-0 shrink cursor-pointer items-center gap-2.5 rounded-sm outline-none focus-visible:focus-ring"
    >
      <CaretGlyph className={cn('text-fg-3 transition-transform', !expanded && '-rotate-90')} />
      {children}
    </AriaButton>
  );
}

// ── Adding a wave ───────────────────────────────────────────────────────────────────────────────────────

export interface AddWaveRowProps {
  /** The number the new wave gets: drawn as "W6" beside the field. */
  nextNumber: number;
  /** The field is open. */
  adding: boolean;
  /** "Add a wave" pressed: open the field. */
  onAddStart: () => void;
  /** Enter on a non-empty name. */
  onAdd: (name: string) => void;
  /** Esc in the field. */
  onCancel: () => void;
  /** Key hint on the link, for example ⇧N. The screen binds the key. */
  kbd?: string;
  /** Text of the link. Defaults to "Add a wave"; "Add waves" on a milestone without any. */
  children?: ReactNode;
  className?: string;
}

/** "+ Add a wave" under the waves, and the field with the next number (frames 103, 113). */
export function AddWaveRow({
  nextNumber,
  adding,
  onAddStart,
  onAdd,
  onCancel,
  kbd,
  children = 'Add a wave',
  className,
}: AddWaveRowProps) {
  const ref = waveRef(nextNumber);
  return (
    <div data-part="add-wave" className={cn(headerRow, 'border-b-0 text-sm text-fg-3', className)}>
      {adding ? (
        <>
          <PlusGlyph className="h-2.25 w-2.25" />
          <WaveNumber>{ref}</WaveNumber>
          <WaveNameInput
            label={`Name of ${ref}`}
            defaultValue=""
            placeholder="Name of the wave"
            onSave={onAdd}
            onCancel={onCancel}
            className="w-80"
          />
          <Kbd aria-hidden>↵</Kbd>
        </>
      ) : (
        <AriaButton
          onPress={onAddStart}
          aria-keyshortcuts={kbd === '⇧N' ? 'Shift+N' : undefined}
          className="inline-flex h-7 cursor-pointer items-center gap-2 rounded-sm text-fg-3 outline-none hover:text-fg focus-visible:focus-ring"
        >
          <PlusGlyph className="h-2.25 w-2.25" />
          {children}
          {kbd ? <Kbd aria-hidden>{kbd}</Kbd> : null}
        </AriaButton>
      )}
    </div>
  );
}

function WaveNameInput({
  label,
  defaultValue,
  placeholder,
  onSave,
  onCancel,
  className,
}: {
  label: string;
  defaultValue: string;
  placeholder?: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [missing, setMissing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, []);
  return (
    <span className={cn('relative flex min-w-0 shrink', className)}>
      <input
        ref={field}
        type="text"
        value={value}
        maxLength={WAVE_NAME_MAX_LENGTH}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={missing || undefined}
        aria-describedby={missing ? errorId : undefined}
        data-invalid={missing || undefined}
        className={cn(inputBase, 'h-7.5 w-full font-medium')}
        onChange={(event) => {
          setValue(event.target.value);
          if (missing) setMissing(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            const trimmed = value.trim();
            if (trimmed) onSave(trimmed);
            else setMissing(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {missing ? (
        <span id={errorId} className="sr-only">
          Give the wave a name
        </span>
      ) : null}
    </span>
  );
}

// ── Milestone list ──────────────────────────────────────────────────────────────────────────────────────

/** The wave summary the milestone list gets with each milestone. */
export interface WaveSummary {
  /** Waves in the milestone. */
  count: number;
  /** Number of the current wave (the first whose gate has not passed); null when all passed. */
  current: number | null;
  /** The current wave's gate. */
  currentState: 'open' | 'failed' | null;
  allPassed: boolean;
}

export interface WaveStatusLineProps {
  /** Null or zero waves: "No waves". */
  waves: WaveSummary | null;
  /** Tasks of the milestone not done or canceled, for "· 1 task open" after all gates passed. */
  openTasks?: number;
  className?: string;
}

/** The words of the wave status line. */
export function waveStatusText(waves: WaveSummary | null, openTasks = 0): string {
  if (!waves || waves.count === 0) return 'No waves';
  if (waves.allPassed || waves.current == null) {
    const head = waves.count === 1 ? 'The gate passed' : `All ${waves.count} gates passed`;
    if (openTasks <= 0) return head;
    return `${head} · ${openTasks === 1 ? '1 task open' : `${openTasks} tasks open`}`;
  }
  if (waves.currentState === 'failed') return `Gate failed in wave ${waves.current} of ${waves.count}`;
  return `Wave ${waves.current} of ${waves.count} · gate open`;
}

/**
 * Under a milestone's name in the list (m8.css .ms-wv, frame 118): "Wave 3 of 5 · gate open", "Gate failed
 * in wave 8 of 12" with a mark, "All 4 gates passed" with a tick, "No waves".
 */
export function WaveStatusLine({ waves, openTasks = 0, className }: WaveStatusLineProps) {
  const text = waveStatusText(waves, openTasks);
  const tone =
    !waves || waves.count === 0
      ? 'none'
      : waves.allPassed || waves.current == null
        ? 'passed'
        : waves.currentState === 'failed'
          ? 'failed'
          : 'open';
  return (
    <span
      data-part="wave-status"
      data-state={tone}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap',
        tone === 'failed' && 'font-semibold text-danger',
        tone === 'passed' && 'font-medium text-ok',
        (tone === 'open' || tone === 'none') && 'text-fg-3',
        className,
      )}
    >
      {tone === 'failed' ? <AlertGlyph className="size-3" /> : null}
      {tone === 'passed' ? <CheckGlyph className="h-2 w-2.5" /> : null}
      <span className="truncate">{text}</span>
    </span>
  );
}

// ── Moving a task, locked tasks ─────────────────────────────────────────────────────────────────────────

export interface MoveHintProps {
  /** The task that moves: "PAY-173". */
  taskKey: string;
  /** Where it goes: "W4", or null for "Not in a wave". */
  to: string | null;
  /** Float at the bottom centre of the nearest positioned ancestor. */
  floating?: boolean;
  className?: string;
}

/** "Moving PAY-173 to W4". */
export function moveHintText(taskKey: string, to: string | null): string {
  return to ? `Moving ${taskKey} to ${to}` : `Moving ${taskKey} out of the waves`;
}

/** The toast while a task moves between waves with Alt+↑ / Alt+↓ or a drag (frame 113). */
export function MoveHint({ taskKey, to, floating = false, className }: MoveHintProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-part="move-hint"
      className={cn(
        'flex h-10.5 items-center gap-2.5 rounded-md bg-fg px-3.5 text-sm whitespace-nowrap text-bg shadow-lift',
        floating && 'absolute bottom-5.5 left-1/2 z-7 -translate-x-1/2',
        className,
      )}
    >
      <span>{moveHintText(taskKey, to)}</span>
      <Kbd variant="inverse" aria-hidden>
        ⌥↓
      </Kbd>
      <Kbd variant="inverse" aria-hidden>
        ⌥↑
      </Kbd>
      <span className="opacity-75">Esc cancels</span>
    </div>
  );
}

export interface WaveLockMarkProps {
  /** The wave it waits for: "W3" ("Locked until W3 passes"). Null for "Locked". */
  lockedUntil?: string | null;
  className?: string;
}

/** The lock on a task row in a locked wave (frames 113, 114), named for assistive tech and in a tooltip. */
export function WaveLockMark({ lockedUntil, className }: WaveLockMarkProps) {
  const label = lockedUntil ? `Locked until ${lockedUntil} passes` : 'Locked';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-part="wave-lock"
      className={cn('inline-flex shrink-0 items-center text-fg-3', className)}
    >
      <LockGlyph />
    </span>
  );
}
