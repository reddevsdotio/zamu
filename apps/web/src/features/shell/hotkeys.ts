import { useEffect, useRef } from 'react';
import { openPalette } from '~/features/palette/registry';
import { isEditableTarget, useHotkeys } from '~/ui';
import { useFocusPageSearch } from './page-search';
import { type QuickCreateOptions, useQuickCreate } from './quick-create';
import { useOptionalShortcuts } from './shortcuts';
import { useOptionalSidebarState } from './sidebar-state';

/**
 * Shortcuts the shell owns on every signed-in page (shortcuts.md, Global): ⌘K the palette, C quick
 * create (in the current project, if any), / page search, [ (by physical key) the sidebar, ? the
 * shortcut list. Plain keys are ignored while typing and inside dialogs and menus. `quickCreateOptions`
 * apply to C, for example `pickProject` on Home. P is no longer New project (it is Priority since M5).
 */
export function useShellHotkeys(
  currentProjectKey: string | undefined,
  quickCreateOptions?: QuickCreateOptions,
): void {
  const quickCreate = useQuickCreate();
  const focusSearch = useFocusPageSearch();
  const sidebar = useOptionalSidebarState();
  const shortcuts = useOptionalShortcuts();
  useHotkeys({
    'Mod+k': () => openPalette(),
    c: () => quickCreate.open(currentProjectKey, quickCreateOptions),
    '/': () => focusSearch(),
    'code:BracketLeft': sidebar ? () => sidebar.toggle() : undefined,
    '?': shortcuts ? () => shortcuts.open() : undefined,
  });
}

/** How long after G the second key still counts. */
export const GO_TO_WINDOW_MS = 1_000;

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/** Where G records a gate (M8): a wave header or a gate box marks itself with data-gate-key. */
const GATE_KEY_SELECTOR = '[data-gate-key]';

/**
 * Two-key "go to" shortcuts: G then a letter, for example G then H for Home. The second key is taken in
 * the capture phase, so page shortcuts on the same letter (M focuses the comment composer) do not also
 * fire. Ignored while typing, inside dialogs and menus, and with modifier keys. G does not start a
 * chord while a wave header or a gate has focus: there it records the gate result.
 */
export function useGoToHotkeys(targets: Readonly<Record<string, (() => void) | undefined>>): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  useEffect(() => {
    let armedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        armedAt = 0;
        return;
      }
      const target = event.target;
      if (isEditableTarget(target) || (target instanceof Element && target.closest(OVERLAY_SELECTOR))) {
        armedAt = 0;
        return;
      }
      const key = event.key.toLowerCase();
      if (armedAt && Date.now() - armedAt <= GO_TO_WINDOW_MS) {
        armedAt = 0;
        const go = event.shiftKey ? undefined : targetsRef.current[key];
        if (!go) return;
        event.preventDefault();
        event.stopPropagation();
        go();
        return;
      }
      // M8: G on a wave header or a gate records the gate result instead (milestone page).
      const onGate = target instanceof Element && target.closest(GATE_KEY_SELECTOR) != null;
      armedAt = key === 'g' && !event.shiftKey && !event.defaultPrevented && !onGate ? Date.now() : 0;
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
