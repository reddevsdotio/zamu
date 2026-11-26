import { ORPCError } from '@orpc/client';
import type { Theme } from '@zamu/contracts';
import { describeError } from '~/features/tasks/errors';
import { useWorkspaceSlug } from '~/lib/workspace';
import { Toast } from '~/ui';
import { useSetTheme, useUserTheme } from './theme';

export interface ThemeChoiceState {
  /** The saved (or just chosen) theme; System until the account has loaded. */
  value: Theme;
  change: (theme: Theme) => void;
  /** Why the last change was undone, or null. */
  error: string | null;
  dismissError: () => void;
}

/** The theme switch's state for the account menu and the Appearance page. */
export function useThemeChoice(): ThemeChoiceState {
  const value = useUserTheme(useWorkspaceSlug()) ?? 'system';
  const save = useSetTheme();
  return {
    value,
    change: (theme) => {
      if (theme !== value) save.mutate(theme);
    },
    error: save.isError ? themeErrorMessage(save.error) : null,
    dismissError: () => save.reset(),
  };
}

/** Why a theme change failed, in a sentence. */
export function themeErrorMessage(error: unknown): string {
  // Only sessions may change the theme; the task screens' wording ("this project") does not fit here.
  if (error instanceof ORPCError && error.code === 'FORBIDDEN')
    return 'Only people signed in here can change it.';
  return describeError(error).message;
}

/** Bottom toast when a theme change from the account menu could not be saved. */
export function ThemeErrorToast({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <Toast
      timeout={8_000}
      onDismiss={onDismiss}
      action={{ label: 'Dismiss', onAction: onDismiss }}
      className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2"
    >
      Couldn't save your theme, so it was switched back. {error}
    </Toast>
  );
}
