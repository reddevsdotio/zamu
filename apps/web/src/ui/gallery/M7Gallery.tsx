import type { ReactNode } from 'react';
import { ArchivedBar, ArchivedTag } from '../Archived';
import { Button } from '../Button';
import { CheckAgainChip, CheckAgainReason } from '../CheckAgain';
import { cn } from '../cn';
import { PlusGlyph } from '../Glyphs';
import { Kbd } from '../Kbd';
import {
  BranchLine,
  FlagLine,
  mergedOpenText,
  PullRequestBox,
  PullRequestList,
  PullRequestRow,
  REQUEST_STATES,
  RequestMarker,
  RequestStatePill,
} from '../PullRequests';
import { HostSteps, WebhookStatusLine } from '../RepositoryWebhook';
import { StatusGlyph } from '../StatusGlyph';

/**
 * /__ui, M7: pull requests on a task, the work-branch line, the merged-with-open-criteria flag, check-again
 * chips, the archived bar and tag, the webhook status line and the per-host setup steps, once per theme, in
 * the states of frames 051 to 053, 057, 063, 070 to 074, 086, 087, 096, 097 and 101. Hover and focus cells
 * force the look with the rows' `look`. The day is fixed so the chips read the same on every visit.
 */
export function M7Gallery() {
  return (
    <section
      aria-label="M7 · Pull requests, archive, check again kit"
      data-frame="m7"
      className="flex flex-col"
    >
      <M7Frame theme="light" />
      <M7Frame theme="dark" />
    </section>
  );
}

/** The gallery's today: the chips count from it. */
const TODAY = '2026-11-26';
const URL = 'https://github.com/northwind/payments/pull';
const noop = () => {};

function M7Frame({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      id={`m7-kit-${theme}`}
      data-frame={`m7-kit-${theme}`}
      className={cn(
        theme,
        'grid w-[1440px] grid-cols-2 gap-x-10 gap-y-8 border-t border-line bg-bg px-10 pt-8 pb-10 font-sans text-md text-fg',
      )}
    >
      <div className="col-span-2 flex items-baseline gap-4">
        <h2 className="m-0 font-serif text-2xl font-medium">Pull requests, archive, check again</h2>
        <span className="text-fg-3">
          {theme === 'dark' ? 'Dark' : 'Light'} · M7 · request rows and pills, branch and flag lines,
          check-again chips, archived bar and tag, webhook status and setup steps
        </span>
      </div>

      <Sec title="State pills · always a word (052)">
        <div className="flex items-center gap-2">
          {REQUEST_STATES.map((state) => (
            <RequestStatePill key={state} state={state} />
          ))}
        </div>
      </Sec>

      <Sec title="Request markers on rows and cards · open, merged, draft, branch only (101)">
        <div className="flex flex-wrap items-center gap-5">
          <RequestMarker request={{ provider: 'github', number: 482, state: 'open' }} />
          <RequestMarker request={{ provider: 'github', number: 479, state: 'merged' }} />
          <RequestMarker request={{ provider: 'gitlab', number: 12, state: 'draft' }} />
          <RequestMarker />
        </div>
      </Sec>

      <Sec title="Pull requests · every state, how each was linked, hover with remove on #471 (052)">
        <ListHeader title="Pull requests" end="2 still open" />
        <PullRequestBox>
          <PullRequestList>
            <PullRequestRow
              provider="github"
              number={479}
              title="Payout retries: schema and worker"
              state="merged"
              how="description"
              url={`${URL}/479`}
              onRemove={noop}
            />
            <PullRequestRow
              provider="github"
              number={482}
              title="Retry failed payouts with backoff"
              state="open"
              how="branch"
              branch="feat/payout-retries"
              url={`${URL}/482`}
              onRemove={noop}
            />
            <PullRequestRow
              provider="github"
              number={485}
              title="Runbook entry for payout retries"
              state="draft"
              how="hand"
              url={`${URL}/485`}
              onRemove={noop}
            />
            <PullRequestRow
              provider="github"
              number={471}
              title="Spike: retry through the provider’s own queue"
              state="closed"
              how="hand"
              url={`${URL}/471`}
              onRemove={noop}
              look="hover"
            />
          </PullRequestList>
          <AddLine />
        </PullRequestBox>
      </Sec>

      <Sec title="One open request; keyboard focus; a GitLab merge request; read-only (051)">
        <PullRequestBox>
          <PullRequestList>
            <PullRequestRow
              provider="github"
              number={482}
              title="Retry failed payouts with backoff"
              state="open"
              how="branch"
              branch="feat/payout-retries"
              url={`${URL}/482`}
              onRemove={noop}
              look="focus"
            />
            <PullRequestRow
              provider="gitlab"
              number={12}
              title="Statement export in the merchant’s locale with a very long title that has to be cut"
              state="open"
              how="branch"
              branch="feat/statement-export-with-locale-and-currency"
              url="https://gitlab.example.com/northwind/payments/-/merge_requests/12"
            />
            <PullRequestRow
              provider="gitea"
              number={7}
              title="Rotate the provider API key"
              state="merged"
              how="description"
            />
          </PullRequestList>
        </PullRequestBox>
      </Sec>

      <Sec title="Linking by hand · the dimmed preview under the field (057)">
        <PullRequestBox>
          <PullRequestList>
            <PullRequestRow
              provider="github"
              number={482}
              title="Retry failed payouts with backoff"
              state="open"
              how="branch"
              branch="feat/payout-retries"
              url={`${URL}/482`}
              onRemove={noop}
            />
          </PullRequestList>
          <div className="flex min-h-9.5 items-center gap-2.5 pr-2.5 pl-3 text-fg-3">
            <PlusGlyph />
            <span className="flex h-7 flex-1 items-center rounded-sm border border-accent px-2.5 text-fg">
              {`${URL}/485`}
            </span>
            <Kbd>↵</Kbd>
          </div>
          <PullRequestRow
            provider="github"
            number={485}
            title="Runbook entry for payout retries"
            state="draft"
            hint="Enter links it"
            preview
          />
        </PullRequestBox>
      </Sec>

      <Sec title="Branch line · work started, no request yet (053)">
        <PullRequestBox>
          <BranchLine branch="feat/payout-alert" by="by claude-dev on laptop, Nov 3" />
          <AddLine />
        </PullRequestBox>
        <PullRequestBox>
          <BranchLine
            branch="feat/a-branch-name-that-goes-on-for-quite-a-while-before-it-ends"
            by="by Tomás Ferrer, Oct 30"
          />
        </PullRequestBox>
      </Sec>

      <Sec title="Flag line · merged with open criteria, with open items (063)">
        <div className="flex w-72 flex-col gap-3">
          <FlagLine>{mergedOpenText({ openCriteria: 2, openDoneItems: 0 })}</FlagLine>
          <FlagLine>{mergedOpenText({ openCriteria: 2, openDoneItems: 1 })}</FlagLine>
          <FlagLine>{mergedOpenText({ openCriteria: 1, openDoneItems: 0 })}</FlagLine>
        </div>
      </Sec>

      <Sec title="Check-again chips · waiting, today, days later; compact; before the clock (096, 097, 101)">
        <div className="grid grid-cols-[150px_1fr] items-center gap-x-5 gap-y-2.5">
          <Cap>Waiting</Cap>
          <CheckAgainChip on="2026-12-03" today={TODAY} />
          <Cap>Waiting, compact</Cap>
          <CheckAgainChip on="2026-12-03" today={TODAY} compact />
          <Cap>Next year</Cap>
          <CheckAgainChip on="2027-01-08" today={TODAY} />
          <Cap>The day has come</Cap>
          <CheckAgainChip on={TODAY} today={TODAY} />
          <Cap>Yesterday</Cap>
          <CheckAgainChip on="2026-11-25" today={TODAY} compact />
          <Cap>3 days ago</Cap>
          <CheckAgainChip on="2026-11-23" today={TODAY} />
          <Cap>No day yet (hydrating)</Cap>
          <CheckAgainChip on="2026-12-03" today={null} />
        </div>
      </Sec>

      <Sec title="Check again in the sidebar · chip and reason (096, 097)">
        <div className="grid w-80 grid-cols-[100px_1fr] gap-x-3 gap-y-4 text-sm">
          <span className="text-fg-2">Check again</span>
          <span className="flex flex-col items-start gap-1">
            <CheckAgainChip on="2026-12-03" today={TODAY} />
            <CheckAgainReason>The bank issues the new certificate on Dec 1</CheckAgainReason>
          </span>
          <span className="text-fg-2">Check again</span>
          <span className="flex flex-col items-start gap-1">
            <CheckAgainChip on={TODAY} today={TODAY} />
            <CheckAgainReason>The bank issues the new certificate on Dec 1</CheckAgainReason>
          </span>
        </div>
      </Sec>

      <Sec title="Archived bar · with Restore, restoring, mirrored without Restore (087)" full>
        <ArchivedBar on="Nov 12" cause="14 days after it was done" onRestore={noop} />
        <ArchivedBar on="Nov 12" cause="by Ana Ruiz" onRestore={noop} isRestoring />
        <ArchivedBar
          on="Nov 12"
          note="Backlog.md moved its file to archive/tasks/; move the file back to restore it."
        />
      </Sec>

      <Sec title="Archived tag on search results · archived results come last (086)">
        <div className="flex flex-col rounded-lg bg-surface-pop p-2 shadow-pop">
          <SearchResult keyText="PAY-150" title="Payout report export" status="done" />
          <SearchResult keyText="PAY-118" title="Payout CSV export for accountants" status="done" archived />
          <SearchResult keyText="PAY-97" title="Payout export to the old ledger" status="canceled" archived />
        </div>
      </Sec>

      <Sec title="Webhook status · no event, healthy, failed signature, unreadable, loading (070 to 074)">
        <WebhookStatusLine status="never" />
        <WebhookStatusLine
          status="ok"
          when="4 minutes ago"
          detail="#482 opened."
          action={
            <Button variant="ghost" size="sm" className="text-accent-text">
              Setup steps
            </Button>
          }
        />
        <WebhookStatusLine status="bad_signature" provider="github" />
        <WebhookStatusLine status="bad_payload" provider="gitlab" />
        <WebhookStatusLine status="loading" />
      </Sec>

      <Sec title="Setup steps per host · GitHub, GitLab, Forgejo (070)" full>
        <div className="grid grid-cols-3 gap-8">
          <HostSteps />
          <HostSteps defaultHost="gitlab" />
          <HostSteps defaultHost="gitea" />
        </div>
        <Cap>Without a webhook Zamu still finds requests, by checking once an hour.</Cap>
      </Sec>
    </div>
  );
}

function AddLine() {
  return (
    <div className="flex min-h-9 items-center gap-2.5 pr-2.5 pl-3 text-sm text-fg-2">
      <PlusGlyph className="text-fg-3" />
      <span className="flex-1">Link a pull request</span>
      <Kbd>⇧P</Kbd>
    </div>
  );
}

function SearchResult({
  keyText,
  title,
  status,
  archived = false,
}: {
  keyText: string;
  title: string;
  status: 'done' | 'canceled';
  archived?: boolean;
}) {
  return (
    <div className="flex h-10 items-center gap-2.5 rounded-md px-2.5">
      <StatusGlyph status={status} />
      <span className="w-14 text-xs text-fg-3 tabular-nums">{keyText}</span>
      <span className={cn('min-w-0 flex-1 truncate', archived ? 'text-fg-3' : 'text-fg')}>{title}</span>
      {archived ? <ArchivedTag /> : null}
      <span className="text-sm text-fg-3">Payments</span>
    </div>
  );
}

function ListHeader({ title, end }: { title: string; end?: ReactNode }) {
  return (
    <div className="-mb-1.5 flex items-center gap-2 text-sm font-semibold text-fg-2">
      <span>{title}</span>
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
