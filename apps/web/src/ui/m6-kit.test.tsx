import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardCardContent } from './Board';
import { Checklist, type ChecklistHandle, type ChecklistItem, type ChecklistProps } from './Checklist';
import { CodeBlock } from './CodeBlock';
import { Dialog, Modal } from './Dialog';
import { ProgressMark } from './Markers';
import { useHotkeys } from './useHotkeys';
import { WaivePanel } from './WaivePopover';
import { ClippedText, NoteItem, SourceTag, SummaryBlock } from './WorkRecord';

// Kit pieces of the M6 work record: the checklist's states and keys, the waive step, progress marks, the
// summary, clipped blocks, notes, source tags and the command box.

const ITEMS: ChecklistItem[] = [
  { number: 1, text: 'Retries back off up to 6 hours', state: 'checked', waivedReason: null, waivedBy: null },
  { number: 2, text: 'A retry never pays twice', state: 'open', waivedReason: null, waivedBy: null },
  {
    number: 3,
    text: 'The schedule holds under load',
    state: 'waived',
    waivedReason: 'replay of last week’s traffic',
    waivedBy: { name: 'Ana' },
  },
  { number: 4, text: 'The runbook covers the alert', state: 'open', waivedReason: null, waivedBy: null },
];

function renumber(items: ChecklistItem[]) {
  return items.map((item, index) => ({ ...item, number: index + 1 }));
}

/** A list that applies its own callbacks, as a screen with optimistic updates would. */
function LiveList(props: Partial<ChecklistProps> & { spy?: (event: string, ...args: unknown[]) => void }) {
  const { spy = () => {}, ...rest } = props;
  const [items, setItems] = useState<ChecklistItem[]>(ITEMS);
  const patch = (number: number, change: Partial<ChecklistItem>) =>
    setItems((current) => current.map((item) => (item.number === number ? { ...item, ...change } : item)));
  return (
    <Checklist
      aria-label="Acceptance criteria"
      noun="criterion"
      items={items}
      addLabel="Add a criterion"
      onToggle={(item) => {
        spy('toggle', item.number);
        patch(item.number, {
          state: item.state === 'checked' ? 'open' : 'checked',
          waivedReason: null,
          waivedBy: null,
        });
      }}
      onWaive={(item, reason) => {
        spy('waive', item.number, reason);
        patch(item.number, { state: 'waived', waivedReason: reason, waivedBy: { name: 'Ana' } });
      }}
      onUnwaive={(item) => {
        spy('unwaive', item.number);
        patch(item.number, { state: 'open', waivedReason: null, waivedBy: null });
      }}
      onEdit={(item, text) => {
        spy('edit', item.number, text);
        patch(item.number, { text });
      }}
      onMove={(item, direction) => {
        spy('move', item.number, direction);
        setItems((current) => {
          const next = [...current];
          const [moved] = next.splice(item.number - 1, 1);
          if (moved) next.splice(item.number - 1 + direction, 0, moved);
          return renumber(next);
        });
      }}
      onRemove={(item) => {
        spy('remove', item.number);
        setItems((current) => renumber(current.filter((other) => other.number !== item.number)));
      }}
      onAdd={(text) => {
        spy('add', text);
        setItems((current) => renumber([...current, { number: 0, text, state: 'open' }]));
      }}
      {...rest}
    />
  );
}

const line = (name: string) => screen.getByRole('checkbox', { name });

/** A screen with single-key shortcuts of its own (X selects, E edits the title) around the list. */
function ScreenWithShortcuts({ onKey }: { onKey: () => void }) {
  useHotkeys({ x: onKey, e: onKey });
  return (
    <>
      <input aria-label="Elsewhere" />
      <LiveList />
    </>
  );
}

describe('Checklist states', () => {
  it('names each line by its text and announces checked, open and waived with the reason', () => {
    render(<Checklist aria-label="Acceptance criteria" noun="criterion" items={ITEMS} />);
    expect(screen.getByRole('group', { name: 'Acceptance criteria' })).toBeInTheDocument();
    expect(line('Retries back off up to 6 hours')).toHaveAttribute('aria-checked', 'true');
    expect(line('A retry never pays twice')).toHaveAttribute('aria-checked', 'false');
    const waived = line('The schedule holds under load');
    expect(waived).toHaveAttribute('aria-checked', 'false');
    expect(waived).toHaveAccessibleDescription('criterion 3 Waived by Ana: replay of last week’s traffic');
    expect(screen.getByText('The schedule holds under load')).toHaveClass('line-through');
  });

  it('writes "Waived: reason" for a waiver from a file, without a name', () => {
    render(
      <Checklist
        aria-label="Acceptance criteria"
        items={[{ number: 1, text: 'One', state: 'waived', waivedReason: 'not needed', waivedBy: null }]}
        numbered={false}
      />,
    );
    expect(line('One')).toHaveAccessibleDescription('Waived: not needed');
  });

  it('draws numbers only for numbered lists, and a detail line when given', () => {
    const { rerender } = render(<Checklist aria-label="Criteria" items={ITEMS.slice(0, 1)} />);
    expect(document.querySelector('[data-part="number"]')).toHaveTextContent('1');
    rerender(
      <Checklist
        aria-label="Done items"
        numbered={false}
        items={[{ number: 1, text: 'Changelog has a line', state: 'open', detail: 'Definition of done' }]}
      />,
    );
    expect(document.querySelector('[data-part="number"]')).toBeNull();
    expect(line('Changelog has a line')).toHaveAccessibleDescription('Definition of done');
  });

  it('keeps one line in the tab order', () => {
    render(<LiveList />);
    const tabbable = screen.getAllByRole('checkbox').filter((box) => box.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });

  it('shows Waive, Unwaive and remove with labels, and only the handlers it was given', () => {
    render(<LiveList />);
    expect(screen.getByRole('button', { name: 'Waive criterion 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unwaive criterion 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove criterion 4' })).toBeInTheDocument();
    render(<Checklist aria-label="Plain" items={ITEMS} onToggle={() => {}} />);
    const plain = screen.getByRole('group', { name: 'Plain' });
    expect(within(plain).queryByRole('button', { name: /Waive|Remove/ })).toBeNull();
  });

  it('renders the empty add line with its hint, and nothing else', () => {
    render(
      <Checklist
        aria-label="Acceptance criteria"
        items={[]}
        onAdd={() => {}}
        addLabel="Add a criterion"
        addHint="What must be true when this is done"
        addKbd="⇧A"
      />,
    );
    expect(screen.getByRole('button', { name: /Add a criterion/ })).toHaveTextContent(
      'What must be true when this is done',
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('Checklist read-only', () => {
  it('marks locked lines read-only, ignores the keys and shows the reason on focus', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Checklist
        aria-label="Acceptance criteria"
        items={ITEMS}
        readOnly
        onToggle={onToggle}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Waive|Remove/ })).toBeNull();
    const first = line('Retries back off up to 6 hours');
    expect(first).toHaveAttribute('aria-readonly', 'true');
    await user.tab();
    expect(first).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Set in Backlog.md. Edit the file to change it.',
    );
    await user.keyboard('x');
    await user.click(first);
    expect(onToggle).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}');
    expect(line('A retry never pays twice')).toHaveFocus();
  });
});

describe('Checklist keys', () => {
  it('moves with the arrows and checks with X and Space', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.tab();
    expect(line('Retries back off up to 6 hours')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(line('A retry never pays twice')).toHaveFocus();
    await user.keyboard('x');
    expect(spy).toHaveBeenLastCalledWith('toggle', 2);
    expect(line('A retry never pays twice')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard(' ');
    expect(line('A retry never pays twice')).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{End}');
    expect(line('The runbook covers the alert')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(line('Retries back off up to 6 hours')).toHaveFocus();
  });

  it('waives with W through the reason step, and W on a waived line removes the waiver', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(line('A retry never pays twice'));
    spy.mockClear();
    await user.keyboard('w');
    const dialog = await screen.findByRole('dialog', { name: 'Waive criterion 2' });
    const field = within(dialog).getByRole('textbox', { name: 'Waive criterion 2' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(spy).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Give a reason')).toBeInTheDocument();
    await user.keyboard('Covered by the replay{Enter}');
    expect(spy).toHaveBeenCalledWith('waive', 2, 'Covered by the replay');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(line('A retry never pays twice')).toHaveFocus());
    expect(line('A retry never pays twice')).toHaveAccessibleDescription(
      'criterion 2 Waived by Ana: Covered by the replay',
    );
    await user.keyboard('w');
    expect(spy).toHaveBeenLastCalledWith('unwaive', 2);
  });

  it('cancels the waive step with Esc and returns to the line', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(line('The runbook covers the alert'));
    spy.mockClear();
    await user.keyboard('w');
    await screen.findByRole('dialog');
    await user.keyboard('Not now{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    await waitFor(() => expect(line('The runbook covers the alert')).toHaveFocus());
  });

  it('focuses the reason field when the waive step opens inside a modal dialog', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(
      <Modal isOpen>
        <Dialog aria-label="Finishing">
          <LiveList spy={spy} actions="always" />
        </Dialog>
      </Modal>,
    );
    await user.click(line('A retry never pays twice'));
    await user.keyboard('w');
    const popover = await screen.findByRole('dialog', { name: 'Waive criterion 2' });
    const field = within(popover).getByRole('textbox', { name: 'Waive criterion 2' });
    await waitFor(() => expect(field).toHaveFocus());
    // Still there once the dialog's own focus handling has run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(field).toHaveFocus();
    await user.keyboard('Covered by the replay{Enter}');
    expect(spy).toHaveBeenCalledWith('waive', 2, 'Covered by the replay');
    await waitFor(() => expect(line('A retry never pays twice')).toHaveFocus());
  });

  it('rewords with E: Enter saves, Esc puts the old words back', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(line('Retries back off up to 6 hours'));
    spy.mockClear();
    await user.keyboard('e');
    const field = screen.getByRole('textbox', { name: 'Reword criterion 1' });
    expect(field).toHaveFocus();
    // Keys inside the field are text, not shortcuts.
    await user.clear(field);
    await user.keyboard('Wait at most 6 hours, with jitter x{Enter}');
    expect(spy).toHaveBeenCalledWith('edit', 1, 'Wait at most 6 hours, with jitter x');
    expect(spy).not.toHaveBeenCalledWith('toggle', 1);
    await waitFor(() => expect(line('Wait at most 6 hours, with jitter x')).toHaveFocus());
    await user.keyboard('e');
    await user.keyboard(' and more{Escape}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(line('Wait at most 6 hours, with jitter x')).toHaveFocus();
  });

  it('rewords when the words are clicked, checks when the box is clicked', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(screen.getByText('A retry never pays twice'));
    expect(screen.getByRole('textbox', { name: 'Reword criterion 2' })).toHaveFocus();
    await user.keyboard('{Escape}');
    const box = line('A retry never pays twice').querySelector('[aria-hidden]');
    if (!box) throw new Error('no box');
    await user.click(box);
    expect(spy).toHaveBeenCalledWith('toggle', 2);
  });

  it('reorders with Alt+arrows and keeps focus on the moved line', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    spy.mockClear();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(spy).toHaveBeenCalledWith('move', 2, 1);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[2]).toHaveAccessibleName('A retry never pays twice');
    await waitFor(() => expect(boxes[2]).toHaveFocus());
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(screen.getAllByRole('checkbox')[1]).toHaveAccessibleName('A retry never pays twice');
    // Not past the ends.
    await user.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    spy.mockClear();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes with Backspace and moves focus to the next line', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(line('A retry never pays twice'));
    await user.keyboard('{Backspace}');
    expect(spy).toHaveBeenCalledWith('remove', 2);
    expect(screen.queryByRole('checkbox', { name: 'A retry never pays twice' })).toBeNull();
    await waitFor(() => expect(line('The schedule holds under load')).toHaveFocus());
  });

  it('leaves with Esc', async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    render(<LiveList onLeave={onLeave} />);
    await user.click(line('A retry never pays twice'));
    await user.keyboard('{Escape}');
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('marks its keys handled so the screen shortcuts stay quiet, and lets them through elsewhere', async () => {
    const user = userEvent.setup();
    const screenKey = vi.fn();
    render(<ScreenWithShortcuts onKey={screenKey} />);
    await user.click(line('A retry never pays twice'));
    await user.keyboard('xe{Escape}');
    expect(screenKey).not.toHaveBeenCalled();
    await user.click(document.body);
    await user.keyboard('x');
    expect(screenKey).toHaveBeenCalledOnce();
  });

  it('adds lines from the add field and keeps it open; Esc closes it', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<LiveList spy={spy} />);
    await user.click(screen.getByRole('button', { name: /Add a criterion/ }));
    const field = screen.getByRole('textbox', { name: 'Add a criterion' });
    expect(field).toHaveFocus();
    await user.keyboard('First new line{Enter}');
    expect(spy).toHaveBeenCalledWith('add', 'First new line');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    await user.keyboard('  {Enter}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox', { name: 'Add a criterion' })).toBeNull();
    expect(line('First new line')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add a criterion/ }));
    await user.keyboard('Dropped{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Add a criterion' })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('opens the add field and focuses the first open line through its handle', async () => {
    const handle = createRef<ChecklistHandle>();
    render(<LiveList ref={handle} />);
    handle.current?.focusFirstOpen();
    expect(line('A retry never pays twice')).toHaveFocus();
    handle.current?.startAdding();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add a criterion' })).toHaveFocus());
  });

  it('shows Waive on every line in the finishing mode, without remove or grip', () => {
    render(
      <Checklist
        aria-label="Open items"
        actions="always"
        items={ITEMS.slice(1, 2)}
        noun="criterion"
        onWaive={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Waive criterion 2' })).not.toHaveClass('opacity-0');
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(document.querySelector('[data-glyph="grip"]')).toBeNull();
  });
});

describe('WaivePanel', () => {
  it('waives on Enter with the trimmed reason and cancels on Esc', async () => {
    const user = userEvent.setup();
    const onWaive = vi.fn();
    const onCancel = vi.fn();
    render(<WaivePanel title="Waive criterion 5" onWaive={onWaive} onCancel={onCancel} autoFocus />);
    const field = screen.getByRole('textbox', { name: 'Waive criterion 5' });
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription('The reason stays on the task and in its history.');
    await user.keyboard('{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Give a reason');
    await user.keyboard('  Load test replaced  {Enter}');
    expect(onWaive).toHaveBeenCalledWith('Load test replaced');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('ProgressMark', () => {
  it('counts checked items and fills the box once every item is checked or waived', () => {
    const { rerender } = render(<ProgressMark settled={5} waived={1} total={6} noun="criteria" />);
    const partial = screen.getByRole('img');
    expect(partial).toHaveAccessibleName('4 of 6 criteria checked, 1 waived');
    expect(partial).toHaveTextContent('4/6');
    expect(partial).not.toHaveAttribute('data-complete');
    rerender(
      <ProgressMark settled={6} waived={1} open={0} total={6} noun="criteria" format="long" showNoun />,
    );
    const complete = screen.getByRole('img');
    expect(complete).toHaveAccessibleName('All 6 criteria checked or waived');
    expect(complete).toHaveTextContent('5 of 6 criteria');
    expect(complete).toHaveAttribute('data-complete', 'true');
    expect(complete.querySelector('[data-glyph="check"]')).not.toBeNull();
  });

  it('renders nothing without items', () => {
    const { container } = render(<ProgressMark settled={0} total={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sits on a board card after subtasks and before the due date', () => {
    const { rerender } = render(
      <BoardCardContent
        taskKey="PAY-142"
        title="Retry failed payouts"
        subtasks={{ done: 3, total: 4 }}
        criteria={{ settled: 4, waived: 0, open: 2, total: 6 }}
        due={{ dueDate: '2099-11-07', status: 'in_progress', today: '2099-11-01' }}
        extra={<span>Updated 2h</span>}
      />,
    );
    const subtasks = screen.getByRole('img', { name: '3 of 4 subtasks done' });
    const mark = screen.getByRole('img', { name: '4 of 6 criteria checked' });
    const due = document.querySelector('[data-due]') as HTMLElement;
    const extra = screen.getByText('Updated 2h');
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(subtasks, mark)).toBe(true);
    expect(follows(mark, due)).toBe(true);
    expect(follows(due, extra)).toBe(true);
    rerender(
      <BoardCardContent
        taskKey="PAY-142"
        title="Retry failed payouts"
        criteria={{ settled: 0, waived: 0, open: 0, total: 0 }}
      />,
    );
    expect(screen.queryByRole('img', { name: /criteri/ })).toBeNull();
  });
});

describe('SummaryBlock, NoteItem and SourceTag', () => {
  it('heads the summary with its author and time', () => {
    render(
      <SummaryBlock author={{ name: 'claude-dev', kind: 'agent' }} onBehalfOf="Ana" time="2 h ago">
        <p>Failed payouts now retry.</p>
      </SummaryBlock>,
    );
    const region = screen.getByRole('region', { name: 'Summary' });
    expect(region).toHaveTextContent('claude-dev for Ana');
    expect(region).toHaveTextContent('2 h ago');
    expect(region).toHaveTextContent('Failed payouts now retry.');
  });

  it('tags a note and shows where it came from', () => {
    render(
      <NoteItem
        author={{ name: 'claude-dev', kind: 'agent' }}
        onBehalfOf="Ana"
        time="Nov 4"
        source={{ machine: 'laptop', branch: 'feat/payout-retries' }}
      >
        Sandbox replay done.
      </NoteItem>,
    );
    const note = screen.getByRole('article', { name: 'Note by claude-dev for Ana' });
    expect(within(note).getByText('Note')).toBeInTheDocument();
    expect(note.querySelector('[data-source]')).toHaveTextContent('from laptop·, branch feat/payout-retries');
    expect(note).toHaveTextContent('Sandbox replay done.');
  });

  it('draws no source for web changes', () => {
    const { container } = render(<SourceTag machine={null} branch={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ClippedText', () => {
  const heights = { scrollHeight: 0, clientHeight: 0 };
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function stubHeights(scroll: number, client: number) {
    heights.scrollHeight = scroll;
    heights.clientHeight = client;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => heights.scrollHeight);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => heights.clientHeight);
  }

  it('cuts long content and opens it from the Show line', async () => {
    stubHeights(200, 43);
    const user = userEvent.setup();
    render(
      <ClippedText lines={2} showLabel="Show the description" kbd="D">
        <p>Long description</p>
      </ClippedText>,
    );
    const show = await screen.findByRole('button', { name: /Show the description/ });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    const box = document.getElementById(show.getAttribute('aria-controls') ?? '');
    expect(box).toHaveAttribute('data-clipped', 'true');
    expect(box?.style.maxHeight).toBe('2lh');
    await user.click(show);
    expect(screen.queryByRole('button', { name: /Show the description/ })).toBeNull();
    expect(box).not.toHaveAttribute('data-clipped');
  });

  it('shows no line when the content fits', async () => {
    stubHeights(40, 43);
    render(
      <ClippedText lines={2} showLabel="Show the description">
        Short
      </ClippedText>,
    );
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});

describe('CodeBlock command', () => {
  it('shows one line of code with Copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <CodeBlock variant="command" copyLabel="Copy the export command">
        zamu backlog export --project HBR
      </CodeBlock>,
    );
    expect(screen.getByText('zamu backlog export --project HBR').tagName).toBe('CODE');
    await user.click(screen.getByRole('button', { name: 'Copy the export command' }));
    expect(writeText).toHaveBeenCalledWith('zamu backlog export --project HBR');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
