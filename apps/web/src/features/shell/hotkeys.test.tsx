import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaletteForTests, usePaletteOpen } from '~/features/palette/registry';
import { createRefusalText } from '~/features/project-header/mirror';
import { SearchField, TextField, useHotkeys } from '~/ui';
import { GO_TO_WINDOW_MS, useGoToHotkeys, useShellHotkeys } from './hotkeys';
import { NewProjectProvider, useNewProject } from './new-project';
import { PageSearchProvider, usePageSearchRef } from './page-search';
import { QuickCreateProvider, useQuickCreate } from './quick-create';
import { ShortcutsProvider } from './shortcuts';
import { SidebarStateProvider, useSidebarState } from './sidebar-state';

function Probe({ projectKey, pickProject }: { projectKey?: string; pickProject?: boolean }) {
  useShellHotkeys(projectKey, pickProject ? { pickProject } : undefined);
  const quickCreate = useQuickCreate();
  const newProject = useNewProject();
  const sidebar = useSidebarState();
  const palette = usePaletteOpen();
  const searchRef = usePageSearchRef();
  return (
    <main>
      <output aria-label="quick create">
        {quickCreate.isOpen
          ? `open:${quickCreate.projectKey ?? 'none'}${quickCreate.pickProject ? ':pick' : ''}`
          : 'closed'}
      </output>
      <output aria-label="new project">{newProject.isOpen ? 'open' : 'closed'}</output>
      <output aria-label="sidebar">{sidebar.collapsed ? 'collapsed' : 'expanded'}</output>
      <output aria-label="palette">{palette ? palette.kind : 'closed'}</output>
      <SearchField aria-label="Search projects" inputRef={searchRef} />
      <TextField label="Notes" />
      <button type="button" onClick={quickCreate.close}>
        Close quick create
      </button>
    </main>
  );
}

function Unregistered() {
  useShellHotkeys(undefined);
  return (
    <main>
      <SearchField aria-label="Search tasks" />
    </main>
  );
}

function Providers({
  children,
  refuse,
}: {
  children: ReactNode;
  refuse?: (projectKey: string) => string | null;
}) {
  return (
    <QuickCreateProvider refuse={refuse}>
      <NewProjectProvider>
        <PageSearchProvider>
          <ShortcutsProvider>
            <SidebarStateProvider userId="u1">{children}</SidebarStateProvider>
          </ShortcutsProvider>
        </PageSearchProvider>
      </NewProjectProvider>
    </QuickCreateProvider>
  );
}

const MIRRORED_TEXT = createRefusalText('Payments');

/** The shell's providers with PAY mirrored from Backlog.md. */
function MirroredProviders({ children }: { children: ReactNode }) {
  return <Providers refuse={(key) => (key === 'PAY' ? MIRRORED_TEXT : null)}>{children}</Providers>;
}

beforeEach(() => {
  resetPaletteForTests();
  window.localStorage.clear();
});

describe('useShellHotkeys', () => {
  it('C opens quick create in the current project', async () => {
    const user = userEvent.setup();
    render(<Probe projectKey="PAY" />, { wrapper: Providers });
    await user.keyboard('c');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('open:PAY');
  });

  it('C outside a project leaves the project to the dialog', async () => {
    const user = userEvent.setup();
    render(<Probe />, { wrapper: Providers });
    await user.keyboard('c');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('open:none');
  });

  it('C on a page that asks for a choice opens with the project picker', async () => {
    const user = userEvent.setup();
    render(<Probe pickProject />, { wrapper: Providers });
    await user.keyboard('c');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('open:none:pick');
  });

  it('/ focuses the page search; P no longer opens New project (it is Priority in M5)', async () => {
    const user = userEvent.setup();
    render(<Probe />, { wrapper: Providers });
    await user.keyboard('p');
    expect(screen.getByLabelText('new project')).toHaveTextContent('closed');
    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveFocus();
  });

  it('⌘K (Ctrl+K off Apple) opens the palette, even from a text field', async () => {
    const user = userEvent.setup();
    render(<Probe />, { wrapper: Providers });
    await user.click(screen.getByLabelText('Notes'));
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByLabelText('palette')).toHaveTextContent('all');
  });

  it('[ by physical key toggles the sidebar and remembers it per person', async () => {
    render(<Probe />, { wrapper: Providers });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('expanded');
    // A German layout types ü on the key next to P: the physical key still counts.
    fireEvent.keyDown(document.body, { key: 'ü', code: 'BracketLeft' });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('collapsed');
    expect(window.localStorage.getItem('zamu.sidebar.collapsed:u1')).toBe('1');
    fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft' });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('expanded');
    expect(window.localStorage.getItem('zamu.sidebar.collapsed:u1')).toBeNull();
  });

  it('? opens the shortcut list', async () => {
    const user = userEvent.setup();
    render(<Probe />, { wrapper: Providers });
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Jump to a project');
    expect(dialog).toHaveTextContent('Collapse or expand the sidebar');
  });

  it('ignores C, [ and / while typing', async () => {
    const user = userEvent.setup();
    render(<Probe projectKey="PAY" />, { wrapper: Providers });
    await user.click(screen.getByLabelText('Notes'));
    await user.keyboard('c[[/');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('closed');
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('expanded');
    expect(screen.getByLabelText('Notes')).toHaveValue('c[/');
  });

  it('C in a project mirrored from Backlog.md shows the refusal instead of the dialog', async () => {
    const user = userEvent.setup();
    const text = MIRRORED_TEXT;
    const { unmount } = render(<Probe projectKey="PAY" />, { wrapper: MirroredProviders });
    await user.keyboard('c');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('closed');
    expect(screen.getByText(text).closest('[role="status"]')).toBeInTheDocument();
    expect(text).toBe(
      'Tasks in Payments come from Backlog.md. Add a file under backlog/tasks/, or run backlog task create, and push. It shows up here after the next refresh.',
    );
    unmount();
    // Other projects still open the dialog.
    render(<Probe projectKey="WEB" />, { wrapper: MirroredProviders });
    await user.keyboard('c');
    expect(screen.getByLabelText('quick create')).toHaveTextContent('open:WEB');
  });

  it('falls back to the first search field in <main>', async () => {
    const user = userEvent.setup();
    render(<Unregistered />, { wrapper: Providers });
    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus();
  });
});

describe('sidebar state', () => {
  const setWidth = (narrow: boolean) => {
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: narrow,
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
  };
  afterEach(() => {
    // jsdom has no matchMedia; the state then reads as wide.
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('starts from the saved choice', () => {
    window.localStorage.setItem('zamu.sidebar.collapsed:u1', '1');
    render(<Probe />, { wrapper: Providers });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('collapsed');
  });

  it('is collapsed below 1100px; [ opens it there without changing the saved choice', () => {
    setWidth(true);
    render(<Probe />, { wrapper: Providers });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('collapsed');
    act(() => {
      fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft' });
    });
    expect(screen.getByLabelText('sidebar')).toHaveTextContent('expanded');
    expect(window.localStorage.getItem('zamu.sidebar.collapsed:u1')).toBeNull();
  });
});

function GoTo({
  onHome,
  onM,
  onMilestones = () => {},
}: {
  onHome: () => void;
  onM: () => void;
  onMilestones?: () => void;
}) {
  useGoToHotkeys({ h: onHome, m: onMilestones });
  // A page shortcut on the same letter (M focuses the comment composer on task screens).
  useHotkeys({ m: onM });
  return (
    <main>
      <TextField label="Notes" />
    </main>
  );
}

describe('useGoToHotkeys', () => {
  afterEach(() => vi.useRealTimers());

  it('G then M goes to Milestones, and the page does not also get M', async () => {
    const user = userEvent.setup();
    const onMilestones = vi.fn();
    const onM = vi.fn();
    render(<GoTo onHome={() => {}} onM={onM} onMilestones={onMilestones} />);
    await user.keyboard('gm');
    expect(onMilestones).toHaveBeenCalledTimes(1);
    expect(onM).not.toHaveBeenCalled();
    // M alone is the page's.
    await user.keyboard('m');
    expect(onMilestones).toHaveBeenCalledTimes(1);
    expect(onM).toHaveBeenCalledTimes(1);
  });

  it('G then H goes Home; G then D does nothing any more', async () => {
    const user = userEvent.setup();
    const onHome = vi.fn();
    render(<GoTo onHome={onHome} onM={() => {}} />);
    await user.keyboard('gd');
    expect(onHome).not.toHaveBeenCalled();
    await user.keyboard('gh');
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it('ignores the sequence while typing and after the window passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const user = userEvent.setup();
    const onHome = vi.fn();
    render(<GoTo onHome={onHome} onM={() => {}} />);
    await user.click(screen.getByLabelText('Notes'));
    await user.keyboard('gh');
    expect(onHome).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Notes')).toHaveValue('gh');
    await user.click(document.body);
    await user.keyboard('g');
    vi.setSystemTime(Date.now() + GO_TO_WINDOW_MS + 1);
    await user.keyboard('h');
    expect(onHome).not.toHaveBeenCalled();
    // Another key between G and H cancels it.
    await user.keyboard('gxh');
    expect(onHome).not.toHaveBeenCalled();
  });

  it('leaves G to a wave header or gate with focus (M8), and keeps the chord elsewhere', async () => {
    const user = userEvent.setup();
    const onHome = vi.fn();
    render(
      <>
        <GoTo onHome={onHome} onM={() => {}} />
        <div data-gate-key>
          <button type="button">W3 · Screens</button>
        </div>
      </>,
    );
    screen.getByRole('button', { name: 'W3 · Screens' }).focus();
    await user.keyboard('gh');
    expect(onHome).not.toHaveBeenCalled();
    await user.click(document.body);
    await user.keyboard('gh');
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
