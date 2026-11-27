import { type BacklogSourceStatus, parseRepositoryUrl } from '@zamu/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { buttonStyles, InlineCode, PROVIDER_LABELS, SourceStatusDot, StepMarker } from '~/ui';
import { DetailBox, Mono, Question, TextLink } from './parts';
import { readPhase, readTotal } from './phase';
import { formatDuration } from './time';

// Step 5 (frames 3o and 3p): the first read runs in the background; the screen polls the source's
// status and ends on the done state with the webhook card.

/** Ends a server message with a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const n = (value: number) => value.toLocaleString('en-US');
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

function Stage({
  state,
  number,
  children,
  aside,
}: {
  state: 'done' | 'current' | 'todo';
  number: number;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <li
      className={`grid h-8.5 grid-cols-[18px_minmax(0,1fr)_160px] items-center gap-2.5 border-b border-line-soft text-sm ${state === 'todo' ? 'text-fg-3' : ''}`}
    >
      {state === 'current' ? (
        <SourceStatusDot state="reading" label="In progress" className="justify-self-center" />
      ) : (
        <StepMarker state={state} number={number} size="sm" />
      )}
      {state === 'current' ? <b className="font-semibold">{children}</b> : <span>{children}</span>}
      <span className="text-right tabular-nums text-xs text-fg-2">{aside}</span>
    </li>
  );
}

export interface ReadStepProps {
  status: BacklogSourceStatus;
  projectName: string;
  settingsHref: string;
  /** Settings → Backlog.md with the webhook dialog open (?webhook=1). */
  webhookHref: string;
  /** Tasks and milestones from the preview, when it ran in this session. */
  expected: { tasks: number | null; milestones: number | null };
}

export function ReadStep({ status, projectName, settingsHref, webhookHref, expected }: ReadStepProps) {
  const phase = readPhase(status);
  const repository = status.repository
    ? (parseRepositoryUrl(status.repository)?.short ?? status.repository)
    : null;
  const folder = status.folder ?? 'backlog';

  if (phase === 'reading') {
    const listed = Boolean(status.headCommit);
    return (
      <>
        <Question>Reading Backlog.md…</Question>
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label="First read"
            aria-valuetext="Reading"
            className="relative h-1.5 overflow-hidden bg-line-soft"
          >
            <span className="absolute inset-y-0 left-0 w-2/5 bg-accent motion-safe:animate-pulse" />
          </div>
          <span className="text-sm text-fg-2">
            {expected.tasks ? `${plural(expected.tasks, 'task', 'tasks')} to read · ` : ''}
            about a minute for 1,000 files
          </span>
        </div>
        <ol className="m-0 list-none p-0">
          <Stage state={listed ? 'done' : 'current'} number={1} aside={null}>
            Listed files{status.defaultBranch ? ` on ${status.defaultBranch}` : ''}
            {status.headCommit ? ` at ${status.headCommit.slice(0, 7)}` : ''}
          </Stage>
          <Stage state={listed ? 'current' : 'todo'} number={2}>
            Reading and checking task files
          </Stage>
          <Stage state="todo" number={3}>
            {expected.milestones === null
              ? 'Creating milestones'
              : `Creating ${plural(expected.milestones, 'milestone', 'milestones')}`}
          </Stage>
          <Stage state="todo" number={4}>
            Creating tasks and the history entry
          </Stage>
        </ol>
        <p className="m-0 text-xs text-fg-2">
          You can leave this page. Tasks appear in {projectName} all at once when the read finishes; nothing
          shows half-done.
        </p>
      </>
    );
  }

  if (phase === 'failed' || phase === 'paused') {
    return (
      <>
        <Question>{phase === 'failed' ? 'The first read failed' : 'The mirror is paused'}</Question>
        <DetailBox tone="error">
          <b className="font-semibold">
            {phase === 'failed'
              ? `Nothing was written to ${projectName}.`
              : `${projectName} can't read ${repository ?? 'its repository'} right now.`}
          </b>{' '}
          {sentence(status.lastError ?? 'The server gave no reason')} Fix it, then use Refresh now in{' '}
          <TextLink href={settingsHref}>Settings → Backlog.md</TextLink>.
        </DetailBox>
      </>
    );
  }

  if (phase === 'detached') {
    return (
      <DetailBox tone="ok">
        <b className="font-semibold">{projectName} is owned by Zamu.</b> Its tasks are editable here; the
        history is in <TextLink href={settingsHref}>Settings → Backlog.md</TextLink>.
      </DetailBox>
    );
  }

  const total = readTotal(status);
  const duration =
    status.lastRead && status.createdAt
      ? formatDuration(new Date(status.lastRead.at).getTime() - new Date(status.createdAt).getTime())
      : null;
  const problemFiles = status.problems.counts.files;
  const isImport = status.mode === 'import';
  const provider = status.connection ? PROVIDER_LABELS[status.connection.provider] : 'your git host';

  return (
    <>
      <DetailBox tone="ok" className="p-4">
        <div className="flex flex-col gap-1">
          <b className="text-lg font-semibold">
            {isImport
              ? `${projectName} imported ${repository ?? 'the Backlog.md files'}`
              : `${projectName} now mirrors ${repository ?? 'the repository'}`}
          </b>
          <span className="text-fg-2">
            {plural(total, 'task', 'tasks')} and {plural(status.counts.milestones, 'milestone', 'milestones')}
            {status.lastRead ? `, read from commit ${status.lastRead.commit.slice(0, 7)}` : ''}
            {duration ? ` in ${duration}` : ''}.
            {problemFiles ? (
              <>
                {' '}
                {plural(problemFiles, 'file was', 'files were')} skipped or read with a warning; they're
                listed in <TextLink href={settingsHref}>Settings → Backlog.md</TextLink>.
              </>
            ) : null}
            {isImport ? ' The project is detached from the files: every task is editable here.' : null}
          </span>
        </div>
      </DetailBox>
      <div className="grid grid-cols-2 gap-2.5">
        {isImport ? null : (
          <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3.5">
            <b className="font-semibold">Refresh on every push</b>
            <span className="text-sm leading-normal text-fg-2">
              Add a webhook in {provider} so changes show up within seconds. Without it, the mirror checks
              every hour.
            </span>
            <span className="mt-1">
              <Link href={webhookHref} className={buttonStyles({ variant: 'secondary', size: 'sm' })}>
                Set up the webhook
              </Link>
            </span>
          </div>
        )}
        <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3.5">
          <b className="font-semibold">Tell your agents</b>
          <span className="text-sm leading-normal text-fg-2">
            {isImport ? (
              <>
                The tasks live here now. <InlineCode>zamu</InlineCode> reads, creates and updates them; edits
                to <Mono>{folder}/</Mono> no longer reach this project.
              </>
            ) : (
              <>
                They keep editing <InlineCode>{folder}/</InlineCode> as before. <InlineCode>zamu</InlineCode>{' '}
                can read the tasks and comment, and <InlineCode>zamu backlog refresh</InlineCode> pulls
                changes right away.
              </>
            )}
          </span>
        </div>
      </div>
    </>
  );
}
