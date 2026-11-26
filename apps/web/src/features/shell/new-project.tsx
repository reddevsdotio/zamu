import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

// Open state of the creation dialogs. The shell renders them once and opens them from the sidebar's
// "+" menu, the workspace menu and the palette; other screens can open them too. New workspace lives
// here as well: it opens from the same menu and palette.
interface NewProjectState {
  /** New project (native tasks). */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** New from Backlog.md (a project that mirrors a repository's backlog/ folder). */
  isFromBacklogOpen: boolean;
  openFromBacklog: () => void;
  closeFromBacklog: () => void;
  /** New workspace (the switcher and the palette). */
  isWorkspaceOpen: boolean;
  openWorkspace: () => void;
  closeWorkspace: () => void;
}

const NewProjectContext = createContext<NewProjectState | null>(null);

export function NewProjectProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [isFromBacklogOpen, setFromBacklogOpen] = useState(false);
  const [isWorkspaceOpen, setWorkspaceOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const openFromBacklog = useCallback(() => setFromBacklogOpen(true), []);
  const closeFromBacklog = useCallback(() => setFromBacklogOpen(false), []);
  const openWorkspace = useCallback(() => setWorkspaceOpen(true), []);
  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);
  const value = useMemo(
    () => ({
      isOpen,
      open,
      close,
      isFromBacklogOpen,
      openFromBacklog,
      closeFromBacklog,
      isWorkspaceOpen,
      openWorkspace,
      closeWorkspace,
    }),
    [
      isOpen,
      open,
      close,
      isFromBacklogOpen,
      openFromBacklog,
      closeFromBacklog,
      isWorkspaceOpen,
      openWorkspace,
      closeWorkspace,
    ],
  );
  return <NewProjectContext.Provider value={value}>{children}</NewProjectContext.Provider>;
}

export function useNewProject(): NewProjectState {
  const value = useContext(NewProjectContext);
  if (!value) throw new Error('useNewProject must be used inside NewProjectProvider');
  return value;
}

/** New project state, or null outside a NewProjectProvider (screens rendered without the shell). */
export function useOptionalNewProject(): NewProjectState | null {
  return useContext(NewProjectContext);
}
