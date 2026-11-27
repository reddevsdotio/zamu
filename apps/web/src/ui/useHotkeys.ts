import { useEffect, useRef } from 'react';

/**
 * Global keyboard shortcuts.
 *
 * Keys are written as `c`, `/`, `Enter`, `Escape` (or `Esc`), `Mod+Enter`, `Shift+?`. `Mod` is ⌘ on
 * Apple platforms and Ctrl elsewhere. Keys match the character typed (`event.key`), so they follow the
 * keyboard layout; `code:BracketLeft` matches the physical key instead (`event.code`), for keys that need
 * AltGr on some layouts (the sidebar's `[`). Plain keys never fire while the user types in a text field;
 * combos with Mod, Ctrl, Meta or Alt do. Bindings registered outside an open dialog, menu or listbox
 * do not fire for keys pressed inside it, unless `allowInOverlays` is set (dialogs set it for their
 * own shortcuts, such as Mod+Enter and I in quick create).
 *
 * The listener runs in the bubble phase on `document`, so components that handle a key themselves
 * (a modal closing on Esc, a table moving on arrow keys) stop it before it gets here.
 */
export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface HotkeyBinding {
  handler: HotkeyHandler;
  /** Fire even when focus is in a text field. Defaults to true for Mod/Ctrl/Meta/Alt combos. */
  allowInInputs?: boolean;
  enabled?: boolean;
  /** Call preventDefault on the event. Default true. */
  preventDefault?: boolean;
}

export type HotkeyMap = Record<string, HotkeyHandler | HotkeyBinding | false | null | undefined>;

export interface UseHotkeysOptions {
  enabled?: boolean;
  /** Let these bindings fire when focus is inside a dialog, menu or listbox. */
  allowInOverlays?: boolean;
}

export interface ParsedHotkey {
  key: string;
  /** Set for `code:…` bindings: the physical key, lower-cased (`bracketleft`). */
  code?: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

export function parseHotkey(combo: string): ParsedHotkey {
  // Split on "+" but keep a literal "+" key ("Shift++").
  const parts = combo.split(/\+(?!$)/).map((part) => part.trim().toLowerCase());
  const key = parts.pop() ?? '';
  const has = (name: string) => parts.includes(name);
  const code = key.startsWith('code:') ? key.slice('code:'.length) : undefined;
  return {
    key: code ? '' : (KEY_ALIASES[key] ?? key),
    ...(code ? { code } : {}),
    mod: has('mod'),
    ctrl: has('ctrl') || has('control'),
    meta: has('meta') || has('cmd') || has('command'),
    alt: has('alt') || has('option'),
    shift: has('shift'),
  };
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform || navigator.userAgent);
}

export function matchesHotkey(
  event: KeyboardEvent,
  hotkey: ParsedHotkey,
  apple = isApplePlatform(),
): boolean {
  const wantCtrl = hotkey.ctrl || (hotkey.mod && !apple);
  const wantMeta = hotkey.meta || (hotkey.mod && apple);
  if (hotkey.code) {
    // Physical keys: AltGr may be down on layouts where the character needs it, so only Ctrl and Meta count.
    if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false;
    return (event.code ?? '').toLowerCase() === hotkey.code && event.shiftKey === hotkey.shift;
  }
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta || event.altKey !== hotkey.alt) return false;
  const key = event.key.toLowerCase();
  if (key !== hotkey.key) return false;
  // Shift matters for letters (C is not Shift+C) and for named keys; for symbols the layout decides.
  const isSymbol = hotkey.key.length === 1 && !/[a-z0-9]/.test(hotkey.key);
  if (hotkey.shift) return event.shiftKey;
  return isSymbol || !event.shiftKey;
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'password',
  'url',
  'tel',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** True when the element accepts typed text. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type || 'text');
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  // isContentEditable is not implemented everywhere (jsdom); the attribute check covers inherited editing.
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  const role = target.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

export function isInsideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) != null;
}

interface CompiledBinding {
  hotkey: ParsedHotkey;
  binding: HotkeyBinding;
}

function compile(map: HotkeyMap): CompiledBinding[] {
  const compiled: CompiledBinding[] = [];
  for (const [combo, value] of Object.entries(map)) {
    if (!value) continue;
    const binding = typeof value === 'function' ? { handler: value } : value;
    if (binding.enabled === false) continue;
    compiled.push({ hotkey: parseHotkey(combo), binding });
  }
  return compiled;
}

export function useHotkeys(map: HotkeyMap, options: UseHotkeysOptions = {}): void {
  const { enabled = true, allowInOverlays = false } = options;
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const apple = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const editable = isEditableTarget(event.target);
      const inOverlay = isInsideOverlay(event.target);
      for (const { hotkey, binding } of compile(mapRef.current)) {
        if (!matchesHotkey(event, hotkey, apple)) continue;
        const isCombo = hotkey.mod || hotkey.ctrl || hotkey.meta || hotkey.alt;
        if (editable && !(binding.allowInInputs ?? isCombo)) continue;
        if (inOverlay && !allowInOverlays) continue;
        if (binding.preventDefault !== false) event.preventDefault();
        binding.handler(event);
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, allowInOverlays]);
}

/**
 * ⌘↵ (Ctrl+Enter elsewhere) for a confirm dialog's main action, wherever focus is in the page. Taken
 * in the capture phase: a dialog that opens with focus on Cancel would otherwise get the Enter as a
 * press of Cancel before a bubbling listener runs.
 */
export function useModEnter(enabled: boolean, onModEnter: () => void): void {
  const handler = useRef(onModEnter);
  handler.current = onModEnter;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      handler.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
