import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countWord,
  GateBox,
  type GateBoxProps,
  GatePill,
  GateResultPanel,
  type GateResultPanelProps,
  gateNextStepText,
  LockedWaveDialog,
  listWaves,
  PlanDoneLine,
  PlanStopLine,
  passBlockedText,
  planDoneText,
} from './Gates';
import { isWebLink, PlanLink, planLinkText } from './PlanLink';
import {
  AddWaveRow,
  FoldedWavesHeader,
  MoveHint,
  NoWaveHeader,
  WaveHeader,
  type WaveHeaderProps,
  WaveLockMark,
  WaveStatusLine,
  waveStatusText,
} from './Waves';

// Kit pieces of M8: wave headers, gate pills and boxes, recording a result, the stop and done lines, the
// plan link, the wave status line of the milestone list, the move hint and the locked-wave warning. Times
// are preformatted strings: no test reads the real clock.

afterEach(() => {
  vi.restoreAllMocks();
});

const NOTE = 'Checks pass. The walkthrough found the retry button wrapping at 1024px, in both themes.';

describe('GatePill', () => {
  it('says each state in words, with a glyph for passed, failed and locked', () => {
    render(
      <div>
        <GatePill state="open" />
        <GatePill state="passed" />
        <GatePill state="failed" />
        <GatePill state="locked" lockedUntil="W3" />
        <GatePill state="locked" />
      </div>,
    );
    expect(screen.getByText('Gate open')).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Gate open').querySelector('[data-glyph]')).toBeNull();
    expect(screen.getByText('Gate passed').querySelector('[data-glyph="check"]')).not.toBeNull();
    expect(screen.getByText('Gate failed').querySelector('[data-glyph="alert"]')).not.toBeNull();
    expect(screen.getByText('Locked until W3 passes').querySelector('[data-glyph="lock"]')).not.toBeNull();
    expect(screen.getByText('Locked')).toHaveAttribute('data-state', 'locked');
  });

  it('takes other words for folded waves', () => {
    render(<GatePill state="passed" label="7 gates passed" />);
    expect(screen.getByText('7 gates passed')).toHaveAttribute('data-state', 'passed');
  });
});

function Header(props: Partial<WaveHeaderProps>) {
  const [expanded, setExpanded] = useState(props.expanded ?? false);
  return (
    <WaveHeader
      number={3}
      name="Screens"
      done={4}
      total={6}
      gate="open"
      current
      {...props}
      expanded={expanded}
      onExpandedChange={(next) => {
        setExpanded(next);
        props.onExpandedChange?.(next);
      }}
    />
  );
}

describe('WaveHeader', () => {
  it('names the wave in a disclosure button and shows progress and the gate', () => {
    render(<Header controls="w3-body" />);
    const toggle = screen.getByRole('button', { name: 'W3 · Screens' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'w3-body');
    expect(screen.getByRole('progressbar', { name: 'W3 progress' })).toHaveAttribute(
      'aria-valuetext',
      '4 of 6 done',
    );
    expect(screen.getByText('4 of 6')).toBeInTheDocument();
    expect(screen.getByText('Gate open')).toBeInTheDocument();
  });

  it('marks the current wave with the accent number', () => {
    const { rerender } = render(<Header />);
    expect(screen.getByText('W3')).toHaveAttribute('data-current', 'true');
    expect(screen.getByText('W3').className).toContain('bg-accent');
    rerender(<Header current={false} />);
    expect(screen.getByText('W3').className).not.toContain('bg-accent');
  });

  it('opens and closes by press, and with the right and left arrows', async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    render(<Header onExpandedChange={onExpandedChange} />);
    const toggle = screen.getByRole('button', { name: 'W3 · Screens' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowLeft}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowRight}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(onExpandedChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('asks for the gate result on G while the header has focus, not on ⌘G', async () => {
    const user = userEvent.setup();
    const onGateKey = vi.fn();
    render(<Header onGateKey={onGateKey} />);
    screen.getByRole('button', { name: 'W3 · Screens' }).focus();
    await user.keyboard('{Meta>}g{/Meta}');
    expect(onGateKey).not.toHaveBeenCalled();
    await user.keyboard('g');
    expect(onGateKey).toHaveBeenCalledTimes(1);
  });

  it('says what a locked wave waits for, with a lock and quiet words', () => {
    render(
      <Header number={4} name="End-to-end tests" current={false} locked lockedUntil={3} done={0} total={3} />,
    );
    const pill = screen.getByText('Locked until W3 passes');
    expect(pill).toHaveAttribute('data-state', 'locked');
    expect(screen.queryByText('Gate open')).toBeNull();
    expect(screen.getByText('End-to-end tests').className).toContain('text-fg-3');
    expect(screen.getByText('W4').className).toContain('text-fg-3');
  });

  it('says "Locked" on the waves after the first locked one', () => {
    render(<Header number={5} name="Release" current={false} locked lockedUntil={null} />);
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('shows open tasks next to a passed gate', () => {
    const { rerender } = render(
      <Header gate="passed" current={false} done={5} total={6} openAfterPass={1} />,
    );
    expect(screen.getByText('1 task open')).toBeInTheDocument();
    expect(screen.getByText('Gate passed')).toBeInTheDocument();
    rerender(<Header gate="passed" current={false} openAfterPass={2} />);
    expect(screen.getByText('2 tasks open')).toBeInTheDocument();
  });

  it('offers rename, move and remove in its menu', async () => {
    const user = userEvent.setup();
    const onRenameStart = vi.fn();
    const onMoveUp = vi.fn();
    const onRemove = vi.fn();
    render(<Header onRenameStart={onRenameStart} onMoveUp={onMoveUp} onRemove={onRemove} gripProps={{}} />);
    const more = screen.getByRole('button', { name: 'Actions for W3' });
    // Hidden until the row is hovered or focused.
    expect(more.className).toContain('opacity-0');
    expect(more.className).toContain('group-hover/wave:opacity-100');
    expect(document.querySelector('[data-part="grip"]')).not.toBeNull();
    await user.click(more);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Rename', 'Move up', 'Remove wave']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove wave' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    await user.click(more);
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(onRenameStart).toHaveBeenCalledTimes(1);
  });

  it('has no menu or grip where the viewer cannot change waves', () => {
    render(<Header />);
    expect(screen.queryByRole('button', { name: 'Actions for W3' })).toBeNull();
    expect(document.querySelector('[data-part="grip"]')).toBeNull();
  });

  it('renames in place: Enter saves the trimmed name, Esc cancels, an empty name is refused', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onRenameCancel = vi.fn();
    render(<Header renaming onRename={onRename} onRenameCancel={onRenameCancel} />);
    const field = screen.getByRole('textbox', { name: 'Name of W3' });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Screens');
    await user.clear(field);
    await user.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await user.type(field, '  Screens and copy  {Enter}');
    expect(onRename).toHaveBeenCalledWith('Screens and copy');
    await user.keyboard('{Escape}');
    expect(onRenameCancel).toHaveBeenCalledTimes(1);
    // The button keeps the number only while the name is a field.
    expect(screen.getByRole('button', { name: 'W3' })).toBeInTheDocument();
  });
});

describe('FoldedWavesHeader and NoWaveHeader', () => {
  it('folds a run of passed waves into one line', async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    render(
      <FoldedWavesHeader from={1} to={7} tasks={41} expanded={false} onExpandedChange={onExpandedChange} />,
    );
    expect(screen.getByText('W1–7')).toBeInTheDocument();
    expect(screen.getByText('7 waves, all passed')).toBeInTheDocument();
    expect(screen.getByText('41 tasks')).toBeInTheDocument();
    expect(screen.getByText('7 gates passed')).toHaveAttribute('data-state', 'passed');
    await user.click(screen.getByRole('button', { name: 'W1 to W7, 7 waves, all passed' }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('says the tasks in no wave have no gate', () => {
    render(<NoWaveHeader tasks={2} expanded />);
    expect(screen.getByRole('button', { name: 'Not in a wave' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    expect(screen.getByText('No gate. These never hold a wave up.')).toBeInTheDocument();
  });
});

describe('AddWaveRow', () => {
  it('opens a field with the next number; Enter adds, Esc cancels', async () => {
    const user = userEvent.setup();
    const onAddStart = vi.fn();
    const onAdd = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <AddWaveRow nextNumber={6} adding={false} onAddStart={onAddStart} onAdd={onAdd} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole('button', { name: 'Add a wave' }));
    expect(onAddStart).toHaveBeenCalledTimes(1);
    rerender(<AddWaveRow nextNumber={6} adding onAddStart={onAddStart} onAdd={onAdd} onCancel={onCancel} />);
    expect(screen.getByText('W6')).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Name of W6' });
    expect(field).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onAdd).not.toHaveBeenCalled();
    await user.type(field, 'Follow-up after the first week{Enter}');
    expect(onAdd).toHaveBeenCalledWith('Follow-up after the first week');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

function Box(props: Partial<GateBoxProps>) {
  return (
    <GateBox
      state="open"
      label="Gate of W3 · Screens"
      description="All checks pass, and a walkthrough of the payout page finds nothing broken."
      {...props}
    />
  );
}

describe('GateBox', () => {
  it('shows the checks with Fail and Pass while the gate is open', async () => {
    const user = userEvent.setup();
    const onPass = vi.fn();
    const onFail = vi.fn();
    render(<Box onPass={onPass} onFail={onFail} />);
    const box = screen.getByRole('group', { name: 'Gate of W3 · Screens' });
    expect(box).toHaveAttribute('data-state', 'open');
    expect(box).toHaveTextContent('All checks pass');
    await user.click(within(box).getByRole('button', { name: /^Pass/ }));
    await user.click(within(box).getByRole('button', { name: 'Fail' }));
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('disables Pass and says why while tasks are open; Fail still works', async () => {
    const user = userEvent.setup();
    const onPass = vi.fn();
    const onFail = vi.fn();
    render(<Box onPass={onPass} onFail={onFail} openTasks={2} />);
    const pass = screen.getByRole('button', { name: /^Pass/ });
    expect(pass).toBeDisabled();
    expect(pass).toHaveAccessibleDescription('Pass unlocks when the 2 open tasks are done');
    expect(screen.getByText('Pass unlocks when the 2 open tasks are done')).toBeVisible();
    await user.click(pass);
    expect(onPass).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fail' }));
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('words the reason for one open task', () => {
    expect(passBlockedText(1)).toBe('Pass unlocks when the open task is done');
    render(<Box onPass={() => {}} openTasks={1} />);
    expect(screen.getByRole('button', { name: /^Pass/ })).toHaveAccessibleDescription(
      'Pass unlocks when the open task is done',
    );
  });

  it('shows a failed result with the word, who, for whom, when, the note and Record again', async () => {
    const user = userEvent.setup();
    const onRecordAgain = vi.fn();
    render(
      <Box
        state="failed"
        result={{ state: 'failed', by: 'claude-dev', onBehalfOf: 'Ana', when: '20 min ago', note: NOTE }}
        onPass={() => {}}
        onRecordAgain={onRecordAgain}
      />,
    );
    const box = screen.getByRole('group', { name: 'Gate of W3 · Screens' });
    expect(box).toHaveAttribute('data-state', 'failed');
    expect(box.className).toContain('inset_3px_0_0_var(--danger)');
    expect(within(box).getByText('Failed')).toBeInTheDocument();
    expect(box).toHaveTextContent('Failed · claude-dev for Ana, 20 min ago');
    expect(box).toHaveTextContent(NOTE);
    // A gate with a result has no Pass or Fail, only Record again.
    expect(within(box).queryByRole('button', { name: /^Pass/ })).toBeNull();
    await user.click(within(box).getByRole('button', { name: /Record again/ }));
    expect(onRecordAgain).toHaveBeenCalledTimes(1);
  });

  it('shows a passed result with its note and no button when read-only', () => {
    render(
      <Box
        state="passed"
        result={{ state: 'passed', by: 'Ana Ruiz', when: 'yesterday', note: 'Tagged on Dec 10.' }}
      />,
    );
    const box = screen.getByRole('group', { name: 'Gate of W3 · Screens' });
    expect(box).toHaveTextContent('Passed · Ana Ruiz, yesterday');
    expect(box).toHaveTextContent('Tagged on Dec 10.');
    expect(within(box).queryByRole('button')).toBeNull();
  });

  it('leaves the time out until the screen has one', () => {
    render(<Box state="passed" result={{ state: 'passed', by: 'Ana Ruiz', when: null, note: 'Done.' }} />);
    expect(screen.getByRole('group')).toHaveTextContent('Passed · Ana Ruiz');
    expect(screen.getByRole('group')).not.toHaveTextContent('Ana Ruiz,');
  });

  it('clips a long note with "Show the whole note"', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 80);
    const user = userEvent.setup();
    render(
      <Box
        state="failed"
        result={{ state: 'failed', by: 'claude-dev', onBehalfOf: 'Ana', when: '2 days ago', note: NOTE }}
      />,
    );
    const show = await screen.findByRole('button', { name: 'Show the whole note' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await user.click(show);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says when no checks are written yet', () => {
    render(<Box description={null} />);
    expect(screen.getByText('No checks written for this gate yet.')).toBeInTheDocument();
  });

  it('asks for a result on G inside the box', async () => {
    const user = userEvent.setup();
    const onGateKey = vi.fn();
    render(<Box onFail={() => {}} onGateKey={onGateKey} />);
    screen.getByRole('button', { name: 'Fail' }).focus();
    await user.keyboard('g');
    expect(onGateKey).toHaveBeenCalledTimes(1);
  });
});

function Panel(props: Partial<GateResultPanelProps>) {
  return (
    <GateResultPanel
      title="Gate of W3 · Screens"
      nextWave="W4"
      onRecord={() => {}}
      onCancel={() => {}}
      autoFocus
      {...props}
    />
  );
}

describe('GateResultPanel', () => {
  it('starts on Passed and says what happens next', () => {
    render(<Panel />);
    expect(screen.getByRole('radio', { name: 'Passed' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAccessibleDescription(
      'The note stays with the gate. W4 unlocks as soon as this passes.',
    );
  });

  it('refuses an empty note and says why', async () => {
    const user = userEvent.setup();
    const onRecord = vi.fn();
    render(<Panel onRecord={onRecord} />);
    await user.keyboard('   {Meta>}{Enter}{/Meta}');
    expect(onRecord).not.toHaveBeenCalled();
    const note = screen.getByRole('textbox', { name: 'Note' });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription(
      'Write what was checked: the note is the evidence for the result.',
    );
  });

  it('records with ⌘↵ and with the Record button', async () => {
    const user = userEvent.setup();
    const onRecord = vi.fn();
    render(<Panel onRecord={onRecord} />);
    await user.keyboard('All 6 tasks are done. ');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onRecord).toHaveBeenLastCalledWith('passed', 'All 6 tasks are done.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onRecord).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('radio', { name: 'Failed' }));
    await user.click(screen.getByRole('button', { name: 'Record' }));
    expect(onRecord).toHaveBeenLastCalledWith('failed', 'All 6 tasks are done.');
  });

  it('changes the next-step line with the result', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(screen.getByRole('radio', { name: 'Failed' }));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAccessibleDescription(
      gateNextStepText('failed', 'W4'),
    );
    expect(gateNextStepText('failed', 'W4')).toContain('W4 stays locked');
    expect(gateNextStepText('passed', null)).toBe(
      'The note stays with the gate. This is the last gate of the milestone.',
    );
  });

  it('cancels on Esc', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Panel onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('can only fail while Pass is blocked, and says why', () => {
    render(<Panel passBlockedReason="Pass unlocks when the 2 open tasks are done" />);
    expect(screen.getByRole('radio', { name: 'Passed' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Failed' })).toBeChecked();
    expect(screen.getByText('Pass unlocks when the 2 open tasks are done')).toBeInTheDocument();
  });

  it('shows the server’s refusal and the pending state', () => {
    render(<Panel isPending error="2 tasks in W3 are still open: PAY-172, PAY-173." />);
    expect(screen.getByRole('alert')).toHaveTextContent('PAY-172, PAY-173');
    expect(screen.getByRole('button', { name: 'Record' })).toHaveAttribute('data-pending', 'true');
  });
});

describe('PlanStopLine and PlanDoneLine', () => {
  it('says which gate failed and what stays locked, with a way to the gate', async () => {
    const user = userEvent.setup();
    const onGoToGate = vi.fn();
    render(<PlanStopLine wave="W3 · Screens" locked={['W4', 'W5']} onGoToGate={onGoToGate} />);
    const line = screen.getByRole('note');
    expect(line).toHaveTextContent(
      'The gate of W3 · Screens failed. The plan stops here: W4 and W5 stay locked until it passes.',
    );
    expect(line.querySelector('[data-glyph="alert"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Go to the gate' }));
    expect(onGoToGate).toHaveBeenCalledTimes(1);
  });

  it('words one locked wave and none', () => {
    const { rerender } = render(<PlanStopLine wave="W4 · End-to-end tests" locked={['W5']} />);
    expect(screen.getByRole('note')).toHaveTextContent('W5 stays locked until it passes.');
    rerender(<PlanStopLine wave="W5 · Release" />);
    expect(screen.getByRole('note')).toHaveTextContent('The plan stops here until it passes.');
    expect(listWaves(['W4', 'W5', 'W6'])).toBe('W4, W5 and W6');
  });

  it('says every gate passed and what is still open', () => {
    render(<PlanDoneLine gates={5} openOutside={2} />);
    const line = screen.getByRole('note');
    expect(line).toHaveTextContent('All five gates passed. Two tasks outside the waves are still open.');
    expect(line.querySelector('[data-glyph="check"]')).not.toBeNull();
    expect(planDoneText({ gates: 1 })).toBe('The gate passed.');
    expect(planDoneText({ gates: 12, openInWaves: 1 })).toBe(
      'All 12 gates passed. One task in the waves is open again.',
    );
    expect(countWord(3, true)).toBe('Three');
  });
});

describe('PlanLink', () => {
  it('shows a file path in the code font and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<PlanLink value="plans/payouts-v2.html" />);
    expect(screen.getByText('plans/payouts-v2.html').tagName).toBe('CODE');
    expect(screen.queryByRole('link')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy the plan link' }));
    expect(writeText).toHaveBeenCalledWith('plans/payouts-v2.html');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copied the plan link' })).toBeInTheDocument();
  });

  it('opens a web address in a new tab and copies it whole', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<PlanLink value="https://wiki.northwind.dev/plans/refunds" />);
    const link = screen.getByRole('link', { name: /wiki\.northwind\.dev\/plans\/refunds/ });
    expect(link).toHaveAttribute('href', 'https://wiki.northwind.dev/plans/refunds');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveAccessibleName('wiki.northwind.dev/plans/refunds, opens in a new tab');
    await user.click(screen.getByRole('button', { name: 'Copy the plan link' }));
    expect(writeText).toHaveBeenCalledWith('https://wiki.northwind.dev/plans/refunds');
  });

  it('offers to add a link when there is none, and nothing when the viewer cannot', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { rerender, container } = render(<PlanLink value={null} onAdd={onAdd} />);
    await user.click(screen.getByRole('button', { name: 'Add a link to the plan' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    rerender(<PlanLink value={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tells web addresses from paths', () => {
    expect(isWebLink('https://wiki.northwind.dev/x')).toBe(true);
    expect(isWebLink('HTTP://wiki.northwind.dev')).toBe(true);
    expect(isWebLink('plans/payouts-v2.html')).toBe(false);
    expect(isWebLink('ftp://files.northwind.dev/plan')).toBe(false);
    expect(planLinkText('https://wiki.northwind.dev/plans/refunds/')).toBe(
      'wiki.northwind.dev/plans/refunds',
    );
  });
});

describe('WaveStatusLine', () => {
  it('words each state of the milestone list, with a mark or a tick where it matters', () => {
    render(
      <div>
        <WaveStatusLine waves={{ count: 5, current: 3, currentState: 'open', allPassed: false }} />
        <WaveStatusLine waves={{ count: 12, current: 8, currentState: 'failed', allPassed: false }} />
        <WaveStatusLine
          waves={{ count: 4, current: null, currentState: null, allPassed: true }}
          openTasks={1}
        />
        <WaveStatusLine waves={null} />
      </div>,
    );
    expect(screen.getByText('Wave 3 of 5 · gate open')).toBeInTheDocument();
    const failed = screen.getByText('Gate failed in wave 8 of 12').parentElement;
    expect(failed).toHaveAttribute('data-state', 'failed');
    expect(failed?.querySelector('[data-glyph="alert"]')).not.toBeNull();
    const passed = screen.getByText('All 4 gates passed · 1 task open').parentElement;
    expect(passed).toHaveAttribute('data-state', 'passed');
    expect(passed?.querySelector('[data-glyph="check"]')).not.toBeNull();
    expect(screen.getByText('No waves')).toBeInTheDocument();
  });

  it('words one wave and no open tasks', () => {
    expect(waveStatusText({ count: 1, current: null, currentState: null, allPassed: true })).toBe(
      'The gate passed',
    );
    expect(waveStatusText({ count: 4, current: null, currentState: null, allPassed: true }, 3)).toBe(
      'All 4 gates passed · 3 tasks open',
    );
    expect(waveStatusText({ count: 0, current: null, currentState: null, allPassed: false })).toBe(
      'No waves',
    );
  });
});

describe('MoveHint and WaveLockMark', () => {
  it('announces where the task goes', () => {
    const { rerender } = render(<MoveHint taskKey="PAY-173" to="W4" />);
    expect(screen.getByRole('status')).toHaveTextContent('Moving PAY-173 to W4');
    expect(screen.getByRole('status')).toHaveTextContent('Esc cancels');
    rerender(<MoveHint taskKey="PAY-173" to={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Moving PAY-173 out of the waves');
  });

  it('names the lock on a task in a locked wave', () => {
    render(
      <div>
        <WaveLockMark lockedUntil="W3" />
        <WaveLockMark />
      </div>,
    );
    expect(screen.getByRole('img', { name: 'Locked until W3 passes' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Locked' })).toBeInTheDocument();
  });
});

function Warning({
  onStart = () => {},
  onCancel = () => {},
}: {
  onStart?: () => void;
  onCancel?: () => void;
}) {
  return (
    <LockedWaveDialog
      isOpen
      wave="W4"
      waitsFor="W3 · Screens"
      taskKey="PAY-174"
      onStart={onStart}
      onCancel={onCancel}
    />
  );
}

describe('LockedWaveDialog', () => {
  it('says what starting early means, with Cancel focused', () => {
    render(<Warning />);
    const dialog = screen.getByRole('alertdialog', { name: 'W4 is still locked' });
    expect(dialog).toHaveTextContent(
      'The gate of W3 · Screens hasn’t passed yet. Starting PAY-174 now works ahead of the plan, and its result may have to be redone.',
    );
    expect(dialog).toHaveTextContent('Agents can’t start tasks in a locked wave.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('starts anyway with the button and with ⌘↵', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<Warning onStart={onStart} />);
    const start = screen.getByRole('button', { name: /Start anyway/ });
    expect(start).toHaveTextContent('⌘↵');
    await user.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('cancels with the button and with Esc', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Warning onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
  });
});
