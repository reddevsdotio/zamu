import { type ReactNode, useRef, useState } from 'react';
import { Button } from '../Button';
import { cn } from '../cn';
import { DialogSurface, Scrim } from '../Dialog';
import {
  GateBox,
  type GateBoxProps,
  GatePill,
  GateResultPanel,
  GateResultPopover,
  LockedWaveDialog,
  LockedWaveWarning,
  PlanDoneLine,
  PlanStopLine,
} from '../Gates';
import type { TaskStatus } from '../meta';
import { PlanLink } from '../PlanLink';
import { StatusGlyph } from '../StatusGlyph';
import {
  AddWaveRow,
  FoldedWavesHeader,
  MoveHint,
  NoWaveHeader,
  WaveHeader,
  type WaveHeaderProps,
  WaveLockMark,
  WaveStatusLine,
} from '../Waves';

/**
 * /__ui, M8: waves and gates on a milestone, once per theme, in the states of frames 103 to 126: gate
 * pills, wave headers (collapsed, open, current, locked, passed with an open task, hover with grip and
 * menu, renaming), folded waves, "Not in a wave", adding a wave, gate boxes (open with Pass disabled and its
 * reason, ready to pass, failed, passed, long note), recording a result, the stop and done lines, the plan
 * link, the wave status line of the milestone list, the move hint, the lock on task rows and the
 * locked-wave warning. Times are fixed strings, as a screen passes them once useNow() has a value.
 */
export function M8Gallery() {
  return (
    <section aria-label="M8 · Waves and gates kit" data-frame="m8" className="flex flex-col">
      <M8Frame theme="light" />
      <M8Frame theme="dark" />
    </section>
  );
}

const noop = () => {};

const W3_GATE =
  'All checks pass, and a walkthrough of the payout page, the admin panel and the statement in light and dark finds nothing broken.';

const FAILED_NOTE = (
  <>
    <p>
      Checks pass. The walkthrough found the retry button wrapping onto two lines on the payout page at
      1024px, in both themes.
    </p>
    <p>Logged as PAY-173 in this wave. Everything else looked right.</p>
  </>
);

const LONG_NOTE = (
  <>
    <p>
      Checks pass (3,412 tests). The walkthrough covered the request form, the list, the detail page and the
      four emails.
    </p>
    <p>
      Three problems. The partial-amount field accepts a refund larger than the payout when the currency has
      no minor unit (JPY, KRW). The list loses its filters when you come back from a detail page. The
      rejection email says “your payout” where it means “your refund”.
    </p>
    <p>
      Logged as PAY-231, PAY-232 and PAY-233 in this wave. Support tried the admin panel on staging and had no
      trouble.
    </p>
  </>
);

function M8Frame({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      id={`m8-kit-${theme}`}
      data-frame={`m8-kit-${theme}`}
      className={cn(
        theme,
        'grid w-[1440px] grid-cols-2 gap-x-10 gap-y-8 border-t border-line bg-bg px-10 pt-8 pb-10 font-sans text-md text-fg',
      )}
    >
      <div className="col-span-2 flex items-baseline gap-4">
        <h2 className="m-0 font-serif text-2xl font-medium">Waves and gates</h2>
        <span className="text-fg-3">
          {theme === 'dark' ? 'Dark' : 'Light'} · M8 · gate pills and boxes, wave headers, recording a result,
          stop and done lines, plan link, wave status, move hint, locked-wave warning
        </span>
      </div>

      <Sec title="Gate pills · open, passed, failed, locked with what it waits for, folded (103, 108, 121)">
        <div className="flex flex-wrap items-center gap-3">
          <GatePill state="open" />
          <GatePill state="passed" />
          <GatePill state="failed" />
          <GatePill state="locked" lockedUntil="W3" />
          <GatePill state="locked" />
          <GatePill state="passed" label="7 gates passed" />
        </div>
      </Sec>

      <Sec title="Wave status in the milestone list · open, failed, all passed, no waves (118)">
        <div className="grid grid-cols-[180px_1fr] items-center gap-x-5 gap-y-2.5">
          {[
            [
              'Payouts v2',
              <WaveStatusLine
                key="a"
                waves={{ count: 5, current: 3, currentState: 'open', allPassed: false }}
              />,
            ],
            [
              'Refunds',
              <WaveStatusLine
                key="b"
                waves={{ count: 12, current: 8, currentState: 'failed', allPassed: false }}
              />,
            ],
            [
              'Statements redesign',
              <WaveStatusLine
                key="c"
                waves={{ count: 4, current: null, currentState: null, allPassed: true }}
                openTasks={1}
              />,
            ],
            ['Provider migration', <WaveStatusLine key="d" waves={null} />],
          ].map(([name, line]) => (
            <div key={name as string} className="contents">
              <span className="font-semibold">{name}</span>
              {line}
            </div>
          ))}
        </div>
      </Sec>

      <Sec title="Wave headers on a milestone · passed, current and open, locked until W3, locked (103)" full>
        <Panel>
          <LiveHeader number={1} name="Data and contracts" done={3} total={3} gate="passed" />
          <LiveHeader number={2} name="Core and API" done={5} total={5} gate="passed" />
          <LiveHeader
            number={3}
            name="Screens"
            done={4}
            total={6}
            inProgress={1}
            gate="open"
            current
            defaultExpanded
          />
          <WaveBody>
            <TaskRow k="PAY-168" status="done" title="Payout page: attempts and next run" />
            <TaskRow k="PAY-169" status="done" title="Admin panel: retry a payout by hand" />
            <TaskRow k="PAY-172" status="in_progress" title="Empty and error states for the retry list" />
            <TaskRow k="PAY-173" status="todo" title="Retry button wraps at 1024px" />
            <LiveGateBox />
          </WaveBody>
          <LiveHeader
            number={4}
            name="End-to-end tests"
            done={0}
            total={3}
            gate="open"
            locked
            lockedUntil={3}
          />
          <LiveHeader number={5} name="Release" done={0} total={2} gate="open" locked />
          <LiveNoWave tasks={2} />
          <LiveAddWave nextNumber={6} />
        </Panel>
      </Sec>

      <Sec
        title="Editing · hover with grip and menu, renaming, a locked wave open with locked tasks, adding (113)"
        full
      >
        <Panel>
          <WaveHeader
            number={3}
            name="Screens"
            done={4}
            total={6}
            gate="open"
            current
            expanded
            look="hover"
            gripProps={{}}
            onRenameStart={noop}
            onMoveUp={noop}
            onMoveDown={noop}
            onRemove={noop}
          />
          <WaveHeader
            number={4}
            name="End-to-end tests"
            done={0}
            total={3}
            gate="open"
            locked
            lockedUntil={3}
            expanded
            gripProps={{}}
            onRenameStart={noop}
            onRemove={noop}
          />
          <WaveBody>
            <div aria-hidden className="mx-4.5 ml-11.5 h-0.5 rounded-full bg-accent" />
            <TaskRow
              k="PAY-174"
              status="todo"
              title="End to end: a payout recovers on attempt 3"
              lockedUntil="W3"
            />
            <TaskRow
              k="PAY-175"
              status="todo"
              title="End to end: eight failures raise one alert"
              lockedUntil="W3"
            />
          </WaveBody>
          <WaveHeader
            number={5}
            name="Release and first week"
            done={0}
            total={2}
            gate="open"
            locked
            expanded={false}
            renaming
            onRename={noop}
            onRenameCancel={noop}
          />
          <AddWaveRow nextNumber={6} adding={false} onAddStart={noop} onAdd={noop} onCancel={noop} kbd="⇧N" />
        </Panel>
      </Sec>

      <Sec
        title="Passed wave with a task reopened after the pass; folded passed waves; Not in a wave open (109, 121)"
        full
      >
        <Panel>
          <FoldedWavesHeader from={1} to={7} tasks={41} expanded={false} />
          <WaveHeader
            number={8}
            name="Refund screens"
            done={29}
            total={30}
            gate="passed"
            openAfterPass={1}
            expanded={false}
          />
          <NoWaveHeader tasks={2} expanded />
          <WaveBody>
            <TaskRow
              k="PAY-158"
              status="in_progress"
              title="Payout fee shows twice on the monthly statement"
            />
            <TaskRow k="PAY-166" status="todo" title="Ask the provider for the new settlement file format" />
          </WaveBody>
        </Panel>
      </Sec>

      <Sec title="Gate box · open, Pass disabled with its reason (103)">
        <GateBox
          state="open"
          description={W3_GATE}
          openTasks={2}
          onPass={noop}
          onFail={noop}
          label="Gate of W3"
        />
      </Sec>

      <Sec title="Gate box · open, every task done (107)">
        <GateBox state="open" description={W3_GATE} onPass={noop} onFail={noop} label="Gate of W3" />
      </Sec>

      <Sec title="Gate box · failed, with note, author and Record again (108)">
        <GateBox
          state="failed"
          description={W3_GATE}
          result={{
            state: 'failed',
            by: 'claude-dev',
            onBehalfOf: 'Ana',
            when: '20 min ago',
            note: FAILED_NOTE,
          }}
          onRecordAgain={noop}
          label="Gate of W3"
        />
      </Sec>

      <Sec title="Gate box · passed, with note, read-only (109)">
        <GateBox
          state="passed"
          description="2.9.0 is tagged, the changelog is published and the first day shows no new payout errors."
          result={{
            state: 'passed',
            by: 'Ana Ruiz',
            when: 'yesterday',
            note: 'Tagged on Dec 10. 3,104 payouts on day one, 41 retried, 40 recovered, 1 closed account.',
          }}
          label="Gate of W5"
        />
      </Sec>

      <Sec title="Gate box · long note clipped, Show the whole note (121)">
        <GateBox
          state="failed"
          description="All checks pass, every refund screen is walked in light and dark at 1440 and 1024, and support has tried the admin panel on staging."
          result={{
            state: 'failed',
            by: 'claude-dev',
            onBehalfOf: 'Ana',
            when: '2 days ago',
            note: LONG_NOTE,
          }}
          noteLines={4}
          onRecordAgain={noop}
          label="Gate of W8"
        />
      </Sec>

      <Sec title="Gate box · no checks written yet; before the clock (no time)">
        <GateBox state="open" onPass={noop} onFail={noop} openTasks={1} label="Gate of W6" />
        <GateBox
          state="passed"
          description="Checks pass."
          result={{
            state: 'passed',
            by: 'claude-dev',
            onBehalfOf: 'Ana',
            when: null,
            note: 'All 12 tests pass.',
          }}
          label="Gate of W2"
        />
      </Sec>

      <Sec
        title="Recording a result · Passed with a note; Failed; Pass blocked; refused by the server (107)"
        full
      >
        <div className="grid grid-cols-2 gap-6">
          <PopSurface>
            <GateResultPanel
              title="Gate of W3 · Screens"
              nextWave="W4"
              defaultNote="All 6 tasks are done. Checks pass (2,611 tests). Walked the payout page, the admin panel and the statement in light and dark at 1440 and 1024."
              onRecord={noop}
              onCancel={noop}
            />
          </PopSurface>
          <PopSurface>
            <GateResultPanel
              title="Gate of W3 · Screens"
              nextWave="W4"
              defaultState="failed"
              defaultNote="The retry button wraps onto two lines at 1024px. Logged as PAY-173."
              onRecord={noop}
              onCancel={noop}
            />
          </PopSurface>
          <PopSurface>
            <GateResultPanel
              title="Gate of W3 · Screens"
              nextWave="W4"
              passBlockedReason="Pass unlocks when the 2 open tasks are done"
              onRecord={noop}
              onCancel={noop}
            />
          </PopSurface>
          <PopSurface>
            <GateResultPanel
              title="Gate of W5 · Release"
              nextWave={null}
              defaultNote="Tagged on Dec 10."
              error="2 tasks in W5 are still open: PAY-177, PAY-178."
              isPending
              onRecord={noop}
              onCancel={noop}
            />
          </PopSurface>
        </div>
      </Sec>

      <Sec title="Stop line and done line across the top of the page (108, 109)" full>
        <PlanStopLine wave="W3 · Screens" locked={['W4', 'W5']} onGoToGate={noop} />
        <PlanStopLine wave="W11 · Support training and docs" locked={['W12']} onGoToGate={noop} />
        <PlanDoneLine gates={5} openOutside={2} />
        <PlanDoneLine gates={4} openInWaves={1} />
      </Sec>

      <Sec title="Plan link · file path, web address, none (103, 121, 117)">
        <div className="flex flex-col items-start gap-3">
          <PlanLink value="plans/payouts-v2.html" />
          <PlanLink value="https://wiki.northwind.dev/plans/refunds" />
          <PlanLink value={null} onAdd={noop} />
          <PlanLink value="plans/payouts-v2.html" onEdit={noop} />
          <div className="w-72">
            <PlanLink value="docs/plans/2026/payouts-v2-retries-and-manual-intervention-final.html" />
          </div>
        </div>
      </Sec>

      <Sec title="Move hint and lock marks on task rows (113)">
        <div className="flex flex-col items-start gap-4">
          <MoveHint taskKey="PAY-173" to="W4" />
          <MoveHint taskKey="PAY-173" to={null} />
          <div className="flex items-center gap-4 text-sm text-fg-3">
            <WaveLockMark lockedUntil="W3" /> Locked until W3 passes
            <WaveLockMark /> Locked
          </div>
        </div>
      </Sec>

      <Sec title="Locked-wave warning · Cancel, Start anyway (114)" full>
        <LockedWarningFrame />
      </Sec>
    </div>
  );
}

// ── Live pieces: the headers open and close, Pass opens the result step ─────────────────────────────────

function LiveHeader({
  defaultExpanded = false,
  ...props
}: Omit<WaveHeaderProps, 'expanded' | 'onExpandedChange'> & { defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return <WaveHeader {...props} expanded={expanded} onExpandedChange={setExpanded} />;
}

function LiveNoWave({ tasks }: { tasks: number }) {
  const [expanded, setExpanded] = useState(false);
  return <NoWaveHeader tasks={tasks} expanded={expanded} onExpandedChange={setExpanded} />;
}

function LiveAddWave({ nextNumber }: { nextNumber: number }) {
  const [adding, setAdding] = useState(false);
  return (
    <AddWaveRow
      nextNumber={nextNumber}
      adding={adding}
      onAddStart={() => setAdding(true)}
      onAdd={() => setAdding(false)}
      onCancel={() => setAdding(false)}
    />
  );
}

function LiveGateBox(props: Partial<GateBoxProps>) {
  const pass = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={pass} className="mt-1.5 mr-4.5 mb-3 ml-11.5">
      <GateBox
        state="open"
        label="Gate of W3"
        description={W3_GATE}
        openTasks={2}
        onPass={() => setOpen(true)}
        onFail={() => setOpen(true)}
        onGateKey={() => setOpen(true)}
        {...props}
      />
      <GateResultPopover
        triggerRef={pass}
        isOpen={open}
        title="Gate of W3 · Screens"
        nextWave="W4"
        passBlockedReason="Pass unlocks when the 2 open tasks are done"
        onRecord={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

function LockedWarningFrame() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative grid h-60 w-170 place-items-center overflow-hidden rounded-lg bg-bg-lane">
        <Scrim />
        <div className="relative z-31">
          <DialogSurface width={500}>
            <LockedWaveWarning
              isStatic
              wave="W4"
              waitsFor="W3 · Screens"
              taskKey="PAY-174"
              onCancel={noop}
              onStart={noop}
            />
          </DialogSurface>
        </div>
      </div>
      <Button variant="secondary" size="sm" className="self-start" onPress={() => setOpen(true)}>
        Open the warning
      </Button>
      <LockedWaveDialog
        isOpen={open}
        wave="W4"
        waitsFor="W3 · Screens"
        taskKey="PAY-174"
        onCancel={() => setOpen(false)}
        onStart={() => setOpen(false)}
      />
    </div>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────────────

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-line-soft bg-bg">{children}</div>
  );
}

function WaveBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col border-b border-line-soft pt-1 pb-0.5">{children}</div>;
}

function TaskRow({
  k,
  status,
  title,
  lockedUntil,
}: {
  k: string;
  status: TaskStatus;
  title: string;
  lockedUntil?: string;
}) {
  return (
    <div className="flex h-8.5 items-center gap-2.5 pr-4.5 pl-11.5">
      <span className="w-15 text-xs text-fg-3 tabular-nums">{k}</span>
      <StatusGlyph status={status} />
      <span className={cn('min-w-0 flex-1 truncate font-medium', lockedUntil ? 'text-fg-2' : 'text-fg')}>
        {title}
      </span>
      {lockedUntil ? <WaveLockMark lockedUntil={lockedUntil} /> : null}
    </div>
  );
}

function PopSurface({ children }: { children: ReactNode }) {
  return <div className="w-95 overflow-hidden rounded-lg bg-surface-pop shadow-pop">{children}</div>;
}

function Sec({ title, full, children }: { title: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', full && 'col-span-2')}>
      <div className="text-sm font-semibold text-fg-3">{title}</div>
      {children}
    </div>
  );
}
