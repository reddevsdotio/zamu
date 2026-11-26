import type { ReactNode } from 'react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { GIT_PROVIDERS, type GitProviderKind, PROVIDER_LABELS } from './Connection';
import { cn } from './cn';
import { AlertGlyph } from './Glyphs';
import { Skeleton } from './Skeleton';
import { SourceStatusDot } from './SourceStatus';

/*
 * The webhook part of a project's Repository settings (m7.css .hook-st, .steps): a line that says whether
 * pull-request events arrive, and the setup steps per host behind GitHub, GitLab and Forgejo tabs. Zamu
 * never creates the webhook itself, so the steps tell an admin where to paste the URL and the secret.
 */

export const WEBHOOK_STATUSES = ['loading', 'never', 'ok', 'bad_signature', 'bad_payload'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

/** Host names in the setup steps and the status line; Gitea and Forgejo share the `gitea` adapter. */
const HOST_NAMES: Record<GitProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Forgejo' };

export interface WebhookStatusLineProps {
  status: WebhookStatus;
  /** When the last event came: "4 minutes ago". Pass it once useNow() has a value. */
  when?: ReactNode;
  /** After the first sentence: "#482 opened." */
  detail?: ReactNode;
  /** The repository's host, named in the failed-signature line. */
  provider?: GitProviderKind;
  /** Trailing action, such as a "Setup steps" link. */
  action?: ReactNode;
  className?: string;
}

/**
 * Whether pull-request events arrive (frames 070 to 072, 074): no event yet, the last event and when, a
 * failed signature check, an event Zamu could not read, or loading.
 */
export function WebhookStatusLine({
  status,
  when,
  detail,
  provider,
  action,
  className,
}: WebhookStatusLineProps) {
  const bad = status === 'bad_signature' || status === 'bad_payload';
  const box = cn(
    'flex items-center gap-2 rounded-md px-3 py-2.5 text-sm',
    bad ? 'bg-danger-soft text-danger' : 'bg-bg-lane text-fg-2',
    className,
  );
  if (status === 'loading') {
    return (
      <div data-status="loading" aria-busy="true" className={box}>
        <Skeleton round height={8} />
        <Skeleton width="30%" />
        <span className="sr-only">Loading the webhook status</span>
      </div>
    );
  }
  const host = provider ? HOST_NAMES[provider] : 'the host';
  let lead: ReactNode;
  let rest: ReactNode = detail;
  if (status === 'never') {
    lead = 'No event received yet.';
    rest = detail ?? 'Until the webhook is set up, Zamu checks the repository once an hour.';
  } else if (status === 'ok') {
    lead = when ? <>Last event {when}.</> : 'Events arrive.';
  } else if (status === 'bad_signature') {
    lead = 'The last event failed its signature check.';
    rest = detail ?? `The secret on ${host} doesn’t match this one. Paste it again, or issue a new one.`;
  } else {
    lead = 'Zamu couldn’t read the last event.';
    rest = detail ?? `Check that the webhook on ${host} sends pull-request events as application/json.`;
  }
  return (
    <div role="status" data-status={status} className={cn(box, bad && 'items-start')}>
      {bad ? (
        <AlertGlyph className="mt-0.25" />
      ) : (
        <SourceStatusDot state={status === 'ok' ? 'healthy' : 'warnings'} decorative className="mx-0.5" />
      )}
      <p className="m-0 min-w-0 flex-1">
        <b className={cn('font-semibold', bad ? 'text-danger' : 'text-fg')}>{lead}</b>
        {rest ? <> {rest}</> : null}
      </p>
      {action}
    </div>
  );
}

// ── Host steps ──────────────────────────────────────────────────────────────────────────────────────────

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-fg">{children}</b>;

/** Where to add the webhook on each host, three steps each. */
export const HOST_WEBHOOK_STEPS: Record<GitProviderKind, readonly ReactNode[]> = {
  github: [
    <>
      Open the repository on GitHub, then <B>Settings › Webhooks › Add webhook</B>.
    </>,
    <>
      Paste the payload URL and the secret, and choose content type <B>application/json</B>.
    </>,
    <>
      Under “Let me select individual events”, tick <B>Pull requests</B> only. Save.
    </>,
  ],
  gitlab: [
    <>
      Open the project on GitLab, then <B>Settings › Webhooks › Add new webhook</B>.
    </>,
    <>
      Paste the payload URL into <B>URL</B> and the secret into <B>Secret token</B>.
    </>,
    <>
      Under <B>Trigger</B>, tick <B>Merge request events</B> only. Save.
    </>,
  ],
  gitea: [
    <>
      Open the repository on Forgejo or Gitea, then <B>Settings › Webhooks › Add webhook</B>, and pick the
      host’s own type.
    </>,
    <>
      Paste the payload URL as the <B>Target URL</B> and the secret, and keep content type{' '}
      <B>application/json</B>.
    </>,
    <>
      Under <B>Trigger on</B>, choose <B>Custom events</B> and tick <B>Pull request</B> only. Save.
    </>,
  ],
};

export interface HostStepsProps {
  /** The host whose steps show. Uncontrolled with `defaultHost` (GitHub when both are unset). */
  host?: GitProviderKind;
  defaultHost?: GitProviderKind;
  onHostChange?: (host: GitProviderKind) => void;
  /** Replaces the steps of a host. */
  steps?: Partial<Record<GitProviderKind, readonly ReactNode[]>>;
  'aria-label'?: string;
  className?: string;
}

/** The segmented control's segment (SegmentedControl), as a tab. */
const tabClass = ({ isSelected }: { isSelected: boolean }) =>
  cn(
    'inline-flex h-6.5 cursor-pointer items-center rounded-[calc(var(--radius-md)-2px)] px-2.75 text-sm font-medium whitespace-nowrap outline-none select-none',
    'focus-visible:shadow-[var(--focus-ring)]',
    isSelected ? 'bg-surface-pop text-fg shadow-card' : 'text-fg-2 hover:text-fg',
  );

/** Setup steps per host behind GitHub, GitLab and Forgejo tabs drawn as a segmented control (frame 070). */
export function HostSteps({
  host,
  defaultHost = 'github',
  onHostChange,
  steps,
  className,
  ...props
}: HostStepsProps) {
  return (
    <Tabs
      selectedKey={host}
      defaultSelectedKey={host ? undefined : defaultHost}
      onSelectionChange={(key) => onHostChange?.(String(key) as GitProviderKind)}
      className={cn('flex flex-col gap-3', className)}
    >
      <TabList
        aria-label={props['aria-label'] ?? 'Webhook setup by host'}
        className="inline-flex shrink-0 gap-0.5 self-start rounded-md border border-line-soft bg-bg-grp p-0.5"
      >
        {GIT_PROVIDERS.map((id) => (
          <Tab key={id} id={id} className={tabClass} aria-label={PROVIDER_LABELS[id]}>
            {HOST_NAMES[id]}
          </Tab>
        ))}
      </TabList>
      {GIT_PROVIDERS.map((id) => (
        <TabPanel key={id} id={id} className="outline-none focus-visible:focus-ring">
          <ol className="m-0 flex list-decimal flex-col pl-5 text-sm leading-prose text-fg-2">
            {(steps?.[id] ?? HOST_WEBHOOK_STEPS[id]).map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed per host and never reorder.
              <li key={index}>{step}</li>
            ))}
          </ol>
        </TabPanel>
      ))}
    </Tabs>
  );
}
