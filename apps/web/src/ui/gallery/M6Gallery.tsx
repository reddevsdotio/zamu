import { type ReactNode, useRef, useState } from 'react';
import { BoardCardContent, boardCardStyles } from '../Board';
import { Button } from '../Button';
import { Checklist, type ChecklistHandle, type ChecklistItem } from '../Checklist';
import { CodeBlock } from '../CodeBlock';
import { cn } from '../cn';
import { ProgressMark } from '../Markers';
import { Pill } from '../Pill';
import { TooltipChip } from '../Tooltip';
import { WaivePanel } from '../WaivePopover';
import { ClippedText, NoteItem, SourceTag, SummaryBlock } from '../WorkRecord';

/**
 * /__ui, M6: the work record pieces (criteria and done-item lists, the waive step, progress marks, the
 * summary, clipped blocks, work notes, source tags, the command box) once per theme, in the states of
 * frames 001, 003, 004, 009, 010, 013, 014, 015, 019, 021, 023 and 038. Hover and focus cells force the look
 * with the items' `look`; the "Try it" list at the end takes the real keys.
 */
export function M6Gallery() {
  return (
    <section aria-label="M6 · Work record kit" data-frame="m6" className="flex flex-col">
      <WorkRecordFrame theme="light" />
      <WorkRecordFrame theme="dark" />
    </section>
  );
}

const CRITERIA = [
  'A failed payout is retried up to 8 times, waiting from 1 minute to 6 hours with jitter',
  'Every attempt reuses the payout’s idempotency key, and a retry never pays twice',
  'After the 8th attempt the payout is marked failed and on-call is alerted once',
  'A payout that fails with account_closed skips the retries and alerts straight away',
  'The schedule holds under a load test of 10,000 failed payouts',
  'The on-call runbook describes the alert and how to retry by hand',
];
const WHY = 'load test replaced by a replay of last week’s traffic';

function criteria(
  states: readonly ChecklistItem['state'][],
  extra: Partial<Record<number, Partial<ChecklistItem>>> = {},
): ChecklistItem[] {
  return CRITERIA.map((text, index) => ({
    number: index + 1,
    text,
    state: states[index] ?? 'open',
    waivedReason: states[index] === 'waived' ? WHY : null,
    waivedBy: states[index] === 'waived' ? { name: 'Ana' } : null,
    ...extra[index + 1],
  }));
}

const REVIEW = criteria(['checked', 'checked', 'checked', 'checked', 'waived', 'open'], {
  6: { look: 'hover' },
});
const EDITING = criteria(['checked', 'checked', 'checked', 'open', 'open', 'open'], {
  4: { look: 'focus' },
  5: { look: 'hover' },
});
const DONE_ITEMS: ChecklistItem[] = [
  { number: 1, text: 'Tests and lint pass', state: 'checked' },
  { number: 2, text: 'Changelog has a line', state: 'checked' },
];
const MIRRORED: ChecklistItem[] = [
  { number: 1, text: 'Group names come from the shared inbox namespace', state: 'checked', locked: true },
  {
    number: 2,
    text: 'French, Dutch and German show translated group names',
    state: 'checked',
    locked: true,
    look: 'hover',
  },
  { number: 3, text: 'Spanish and Italian show translated group names', state: 'open', locked: true },
];
const FINISHING: ChecklistItem[] = [
  { id: 'criterion-6', number: 6, text: CRITERIA[5] ?? '', state: 'open', look: 'focus' },
  {
    id: 'done-2',
    number: 2,
    text: 'Changelog has a line',
    state: 'open',
    numbered: false,
    detail: 'Definition of done',
  },
];

const noop = () => {};
/** Handlers that do nothing, so the static cells draw their actions and add lines. */
const EDITS = {
  onToggle: noop,
  onWaive: noop,
  onUnwaive: noop,
  onEdit: noop,
  onMove: noop,
  onRemove: noop,
};
const STATIC = { ...EDITS, onAdd: noop };

function WorkRecordFrame({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      id={`m6-kit-${theme}`}
      data-frame={`m6-kit-${theme}`}
      className={cn(
        theme,
        'grid w-[1440px] grid-cols-2 gap-x-10 gap-y-8 border-t border-line bg-bg px-10 pt-8 pb-10 font-sans text-md text-fg',
      )}
    >
      <div className="col-span-2 flex items-baseline gap-4">
        <h2 className="m-0 font-serif text-2xl font-medium">Work record</h2>
        <span className="text-fg-3">
          {theme === 'dark' ? 'Dark' : 'Light'} · M6 · criteria, done items, the waive step, progress,
          summary, notes and sources
        </span>
      </div>

      <Sec title="Criteria · checked, waived, open with hover (001)">
        <ListHeader
          title="Acceptance criteria"
          mark={<ProgressMark settled={5} waived={1} total={6} format="long" noun="criteria" />}
          end="1 waived · 1 open"
        />
        <Checklist
          aria-label="Acceptance criteria"
          noun="criterion"
          items={REVIEW}
          addLabel="Add a criterion"
          addKbd="⇧A"
          {...STATIC}
        />
      </Sec>

      <Sec title="Criteria · rewording, keyboard focus, hover, adding (009)">
        <ListHeader
          title="Acceptance criteria"
          mark={<ProgressMark settled={3} total={6} format="long" noun="criteria" />}
          end="3 open"
        />
        <Checklist
          aria-label="Acceptance criteria"
          noun="criterion"
          items={EDITING}
          defaultEditingId={2}
          defaultAddValue="The alert names the payout and the last provider error"
          addLabel="Add a criterion"
          addKbd="⇧A"
          {...STATIC}
        />
      </Sec>

      <Sec title="The waive step (010)">
        <div className="flex items-start gap-6">
          <div className="w-90 overflow-hidden rounded-lg bg-surface-pop shadow-pop">
            <WaivePanel title="Waive criterion 5" defaultReason={WHY} onWaive={noop} onCancel={noop} />
          </div>
          <div className="w-90 overflow-hidden rounded-lg bg-surface-pop shadow-pop">
            <MissingReason />
          </div>
        </div>
        <Cap>
          Enter waives, Esc cancels. An empty Enter keeps the step open and asks for a reason (right).
        </Cap>
      </Sec>

      <Sec title="Definition of done · no numbers, from the project defaults (001, 003)">
        <ListHeader
          title="Definition of done"
          mark={<ProgressMark settled={2} total={2} format="long" noun="done items" />}
          end="from the project defaults"
        />
        <Checklist
          aria-label="Definition of done"
          noun="done item"
          numbered={false}
          items={DONE_ITEMS}
          {...EDITS}
        />
        <ListHeader
          title="Definition of done"
          mark={<ProgressMark settled={0} total={2} format="long" noun="done items" />}
          end="from the project defaults"
        />
        <Checklist
          aria-label="Definition of done"
          noun="done item"
          numbered={false}
          items={DONE_ITEMS.map((item) => ({ ...item, state: 'open' }))}
          {...EDITS}
        />
      </Sec>

      <Sec title="Empty · the quiet add line (004)">
        <ListHeader title="Acceptance criteria" />
        <Checklist
          aria-label="Acceptance criteria"
          noun="criterion"
          items={[]}
          addLabel="Add a criterion"
          addHint="What must be true when this is done"
          addKbd="⇧A"
          {...STATIC}
        />
      </Sec>

      <Sec title="Read-only · mirrored, hover with the lock (021)">
        <ListHeader
          title="Acceptance criteria"
          mark={<ProgressMark settled={2} total={3} format="long" noun="criteria" />}
          end="from the file"
        />
        <div className="flex flex-col items-end gap-1.5">
          <TooltipChip>Set in Backlog.md. Edit the file to change it.</TooltipChip>
          <Checklist
            aria-label="Acceptance criteria"
            noun="criterion"
            items={MIRRORED}
            readOnly
            className="w-full"
          />
        </div>
        <ListHeader title="Definition of done" />
        <Cap className="px-0.5">None in the file</Cap>
      </Sec>

      <Sec title="Finishing with open items · Waive on every line, focus (019)">
        <Checklist
          aria-label="Open items"
          noun="criterion"
          actions="always"
          items={FINISHING}
          onToggle={noop}
          onWaive={noop}
          className="bg-bg"
        />
        <Cap>
          The finishing dialog lists only the open items. Done items carry their list as a second line and no
          number.
        </Cap>
      </Sec>

      <Sec title="Progress marks (001, 023)">
        <div className="grid grid-cols-[150px_repeat(3,minmax(0,1fr))] items-center gap-x-4 gap-y-3">
          <span />
          <Cap>Partial</Cap>
          <Cap>Complete</Cap>
          <Cap>None</Cap>
          <Cap>Rows and cards</Cap>
          <ProgressMark settled={4} total={6} noun="criteria" />
          <ProgressMark settled={5} total={5} noun="criteria" />
          <span className="flex items-center gap-2">
            <ProgressMark settled={0} total={0} noun="criteria" />
            <Cap>nothing drawn</Cap>
          </span>
          <Cap>Headers and sidebar</Cap>
          <ProgressMark
            settled={4}
            total={6}
            format="long"
            noun="criteria"
            className="text-md font-semibold text-fg"
          />
          <ProgressMark
            settled={2}
            total={2}
            format="long"
            noun="done items"
            className="text-md font-semibold text-fg"
          />
          <span />
          <Cap>Peek chips</Cap>
          <Pill className="h-6.5 px-2.5 text-sm">
            <ProgressMark
              settled={4}
              total={6}
              format="long"
              noun="criteria"
              showNoun
              className="text-sm text-fg"
            />
          </Pill>
          <Pill className="h-6.5 px-2.5 text-sm">
            <ProgressMark
              settled={2}
              total={2}
              format="long"
              noun="done items"
              showNoun
              className="text-sm text-fg"
            />
          </Pill>
          <span />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Cap>Board card: after subtasks, before the due date</Cap>
          <div className={cn(boardCardStyles(), 'w-58 cursor-default')}>
            <BoardCardContent
              taskKey="PAY-142"
              title="Retry failed payouts with exponential backoff"
              priority="high"
              labels={[{ name: 'payouts', color: 2 }]}
              subtasks={{ done: 3, total: 4 }}
              criteria={{ settled: 4, waived: 0, open: 2, total: 6 }}
              due={{ dueDate: '2099-11-07', status: 'in_progress', today: '2099-11-04' }}
            />
          </div>
        </div>
      </Sec>

      <Sec title="Final summary (001, 023)">
        <SummaryBlock author={{ name: 'claude-dev', kind: 'agent' }} onBehalfOf="Ana" time="2 h ago">
          <p className="m-0 mb-2">
            Failed payouts now retry on a backoff schedule from 1 minute to 6 hours, eight attempts at most,
            and on-call is alerted once after the last one. Every attempt reuses the payout’s idempotency key.
          </p>
          <p className="m-0 mb-2">
            Still open: the on-call runbook entry (criterion 6). Refunds are out of scope and tracked in
            PAY-160.
          </p>
        </SummaryBlock>
        <Cap>In the peek: no card, author and time at the right.</Cap>
        <SummaryBlock
          variant="plain"
          author={{ name: 'claude-dev', kind: 'agent' }}
          onBehalfOf="Ana"
          time="2 h ago"
        >
          Failed payouts now retry on a backoff schedule from 1 minute to 6 hours, eight attempts at most, and
          on-call is alerted once after the last one.
        </SummaryBlock>
      </Sec>

      <Sec title="Clipped blocks with the Show line (001, 048)">
        <ClippedText lines={2} showLabel="Show the description" kbd="D" contentClassName="leading-prose">
          <p className="m-0">
            Payouts that fail at the provider are dropped today. Retry them on a schedule so merchants are
            paid without support stepping in.
          </p>
          <ul className="m-0 list-disc pl-5">
            <li>Back off from 1 minute up to 6 hours, with jitter.</li>
            <li>Stop after 8 attempts and alert the on-call channel.</li>
          </ul>
        </ClippedText>
        <ClippedText
          lines={4}
          showLabel="Show all 8 steps"
          lessLabel="Show less"
          contentClassName="leading-prose"
        >
          <ol className="m-0 list-decimal pl-5.5">
            {[
              'Store the attempt count and the next run on the payout (PAY-143)',
              'Backoff schedule with jitter, applied after the cap (PAY-144)',
              'Reuse the idempotency key on every attempt (PAY-145)',
              'Skip the retries for account_closed',
              'Alert on-call after the 8th attempt (PAY-146)',
              'Replay last week’s failed payouts in the provider sandbox',
              'Write the runbook entry',
              'Changelog and docs',
            ].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </ClippedText>
        <ClippedText lines={2} showLabel="Show the description" kbd="D">
          Short text is not cut and gets no Show line.
        </ClippedText>
      </Sec>

      <Sec title="Work notes and sources (013, 014, 015)">
        <NoteItem
          author={{ name: 'claude-dev', kind: 'agent' }}
          onBehalfOf="Ana"
          time="Oct 30"
          source={{ machine: 'laptop', branch: 'feat/payout-retries' }}
        >
          Backoff schedule is in. Jitter was applied before the cap, so attempt 8 could wait 7h 12m. Fixed
          after review-bot’s comment.
        </NoteItem>
        <NoteItem
          author={{ name: 'claude-dev', kind: 'agent' }}
          onBehalfOf="Ana"
          time="Nov 4"
          source={{ machine: 'laptop', branch: 'feat/payout-retries' }}
          sourceVisibility="hover"
        >
          Sandbox replay of last week’s failed payouts: 212 of 219 recovered by attempt 4. The other 7 were
          closed accounts. (Source shows on hover.)
        </NoteItem>
        <NoteItem author={{ name: 'Ana Ruiz', kind: 'person' }} time="2 h ago">
          Written in the web app: no source.
        </NoteItem>
        <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
          <Cap>Machine and branch</Cap>
          <SourceTag machine="laptop" branch="feat/payout-retries" />
          <Cap>Machine only</Cap>
          <SourceTag machine="ci-runner-3" />
          <Cap>Long branch</Cap>
          <SourceTag
            machine="ana-mbp"
            branch="feat/payout-retries-with-a-very-long-branch-name-that-is-cut"
          />
          <Cap>Web app</Cap>
          <span className="flex items-center gap-2">
            <SourceTag />
            <Cap>nothing drawn</Cap>
          </span>
        </div>
      </Sec>

      <Sec title="Command box (038)">
        <CodeBlock variant="command" copyLabel="Copy the export command">
          zamu backlog export --project HBR
        </CodeBlock>
        <Cap>
          The copy is as fresh as the last time the command ran. Edits made to the exported files are not read
          back.
        </Cap>
      </Sec>

      <Sec title="Try it · the keys" full>
        <TryIt />
      </Sec>
    </div>
  );
}

function MissingReason() {
  const [key, setKey] = useState(0);
  return (
    <WaivePanel
      key={key}
      title="Waive “Changelog has a line”"
      onWaive={noop}
      onCancel={() => setKey(key + 1)}
    />
  );
}

/** A live list: every key from the shortcut list works on it, and the log says what the screen would send. */
function TryIt() {
  const [items, setItems] = useState<ChecklistItem[]>(() =>
    criteria(['checked', 'checked', 'open', 'open', 'waived', 'open']).map(
      ({ look: _look, ...item }) => item,
    ),
  );
  const [log, setLog] = useState<string[]>([]);
  const list = useRef<ChecklistHandle>(null);
  const say = (line: string) => setLog((lines) => [line, ...lines].slice(0, 6));
  const renumber = (next: ChecklistItem[]) => next.map((item, index) => ({ ...item, number: index + 1 }));
  const update = (number: number, patch: Partial<ChecklistItem>) =>
    setItems((current) => current.map((item) => (item.number === number ? { ...item, ...patch } : item)));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onPress={() => list.current?.focusFirstOpen()} kbd="⇧X">
            Focus the first open line
          </Button>
          <Button variant="secondary" size="sm" onPress={() => list.current?.startAdding()} kbd="⇧A">
            Add a criterion
          </Button>
        </div>
        <Checklist
          ref={list}
          aria-label="Acceptance criteria (try it)"
          noun="criterion"
          items={items}
          addLabel="Add a criterion"
          addKbd="⇧A"
          onToggle={(item) => {
            const next = item.state === 'checked' ? 'open' : 'checked';
            update(item.number, { state: next, waivedReason: null, waivedBy: null });
            say(`${next === 'checked' ? 'checked' : 'unchecked'} criterion ${item.number}`);
          }}
          onWaive={(item, reason) => {
            update(item.number, { state: 'waived', waivedReason: reason, waivedBy: { name: 'Ana' } });
            say(`waived criterion ${item.number}: ${reason}`);
          }}
          onUnwaive={(item) => {
            update(item.number, { state: 'open', waivedReason: null, waivedBy: null });
            say(`removed the waiver on criterion ${item.number}`);
          }}
          onEdit={(item, text) => {
            update(item.number, { text });
            say(`reworded criterion ${item.number}`);
          }}
          onMove={(item, direction) => {
            setItems((current) => {
              const next = [...current];
              const from = item.number - 1;
              const [moved] = next.splice(from, 1);
              if (moved) next.splice(from + direction, 0, moved);
              return renumber(next);
            });
            say(`moved criterion ${item.number} to ${item.number + direction}`);
          }}
          onRemove={(item) => {
            setItems((current) => renumber(current.filter((other) => other.number !== item.number)));
            say(`removed criterion ${item.number}`);
          }}
          onAdd={(text) => {
            setItems((current) => renumber([...current, { number: 0, text, state: 'open' }]));
            say('added a criterion');
          }}
        />
      </div>
      <div className="flex flex-col gap-2 text-sm text-fg-2">
        <Cap>
          ↑/↓ move · X or Space checks · W waives or removes a waiver · E rewords · Alt+↑/↓ reorder ·
          Backspace removes · Esc leaves. Keys do nothing while a text field has focus.
        </Cap>
        <ol aria-label="What the screen would send" className="m-0 flex list-none flex-col gap-1 p-0">
          {log.length === 0 ? <li className="text-fg-3">Nothing yet.</li> : null}
          {log.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a short log where the same line can repeat.
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ListHeader({ title, mark, end }: { title: string; mark?: ReactNode; end?: ReactNode }) {
  return (
    <div className="-mb-1.5 flex items-center gap-2 text-sm font-semibold text-fg-2">
      <span>{title}</span>
      {mark}
      <span className="flex-1" />
      {end ? <span className="font-normal text-fg-3">{end}</span> : null}
    </div>
  );
}

function Sec({ title, full, children }: { title: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', full && 'col-span-2')}>
      <div className="text-sm font-semibold text-fg-3">{title}</div>
      {children}
    </div>
  );
}

function Cap({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-xs text-fg-3', className)}>{children}</span>;
}
