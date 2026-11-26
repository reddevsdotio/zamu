import { useQuery } from '@tanstack/react-query';
import type { PullRequestLink, Task } from '@zamu/contracts';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { Button as AriaButton, Input as AriaInput, TextField as AriaTextField } from 'react-aria-components';
import { showFieldToast } from '~/features/task-fields/toast';
import { useApi } from '~/lib/workspace';
import {
  AlertGlyph,
  BranchLine,
  cn,
  inputBase,
  Kbd,
  PlusGlyph,
  PullRequestBox,
  PullRequestList,
  PullRequestRow,
  requestRef,
} from '~/ui';
import { useNow } from './clock';
import { describeError } from './errors';
import {
  type LinkRefusal,
  linkRefusal,
  moveNote,
  NOT_A_REQUEST_TEXT,
  parseRequestAddress,
  requestsSummary,
  useLinkPullRequest,
  useUnlinkPullRequest,
} from './pull-requests';

// The task's requests (frames 051 to 059, 063): between the description and the criteria, a box with one
// row per request (host, number, title, how it was linked, state), the work-branch line while a branch
// has no request yet, and "Link a pull request" (⇧P). The link field reads the pasted address as it is
// typed: a dry run shows the request dimmed with "Enter links it", or says why it can't link (not a
// request, another repository). Removing a link offers Undo, which links it again by hand. An archived
// task lists its requests and nothing else.

/** The danger border and halo, kept while the field has focus (frames 058, 059). */
const invalidInput = 'border-danger focus:border-danger focus:shadow-[0_0_0_3px_var(--danger-soft)]';

/** How long typing pauses before the preview asks the server. */
const PREVIEW_DELAY_MS = 250;

export interface PullRequestsSectionProps {
  task: Task;
  /** "Payments", for the other-repository refusal. */
  projectName: string;
  /** The field is open (⇧P or the add line). */
  isLinking: boolean;
  onLinkingChange: (open: boolean) => void;
  /** Archived: rows only, no remove and no link line. */
  readOnly?: boolean;
  /** The "Link a pull request" line, for focus. */
  addRef?: RefObject<HTMLButtonElement | null>;
  /** Who started the branch, where and when (from the history): "by claude-dev on laptop, Nov 3". */
  branchBy?: string | null;
}

export function PullRequestsSection({
  task,
  projectName,
  isLinking,
  onLinkingChange,
  readOnly = false,
  addRef,
  branchBy,
}: PullRequestsSectionProps) {
  const requests = task.pullRequests ?? [];
  const now = useNow();
  const unlink = useUnlinkPullRequest(task.key);
  const link = useLinkPullRequest(task.key);
  const branch = task.workBranch ?? null;
  const linking = isLinking && !readOnly;
  if (requests.length === 0 && !branch && !linking) return null;

  const remove = (request: PullRequestLink) => {
    const ref = requestRef(request.provider, request.number);
    unlink.mutate(request.number, {
      onSuccess: () =>
        showFieldToast({
          text: `Unlinked ${ref} from ${task.key}`,
          undo: () =>
            link.mutate(request.url, {
              onSuccess: () => showFieldToast({ text: `Linked ${ref} to ${task.key} again` }),
              onError: (error) =>
                showFieldToast({
                  text: `Couldn't link ${ref} again. ${describeError(error).message}`,
                  tone: 'error',
                }),
            }),
        }),
      onError: (error) =>
        showFieldToast({ text: `Couldn't unlink ${ref}. ${describeError(error).message}`, tone: 'error' }),
    });
  };

  const note = moveNote(task, requests);
  const summary = requestsSummary(requests, now);

  return (
    <section aria-labelledby="pull-requests-title" className="flex flex-col">
      <div className="mt-6 mb-1.5 flex min-w-0 items-center gap-2 text-sm text-fg-2">
        <h2 id="pull-requests-title" className="m-0 text-sm font-semibold">
          Pull requests
        </h2>
        {summary ? <span className="truncate text-fg-3">{summary}</span> : null}
      </div>
      <LinkArea
        task={task}
        projectName={projectName}
        isLinking={linking}
        onClose={() => onLinkingChange(false)}
      >
        {(field) => (
          <PullRequestBox>
            {requests.length ? (
              <PullRequestList>
                {requests.map((request) => (
                  <PullRequestRow
                    key={request.number}
                    provider={request.provider}
                    number={request.number}
                    title={request.title}
                    state={request.state}
                    how={request.how}
                    branch={request.headBranch}
                    url={request.url}
                    {...(readOnly ? {} : { onRemove: () => remove(request) })}
                  />
                ))}
              </PullRequestList>
            ) : branch ? (
              <BranchLine branch={branch} by={branchBy ?? null} />
            ) : null}
            {readOnly ? null : linking ? (
              field
            ) : (
              <AriaButton
                ref={addRef}
                onPress={() => onLinkingChange(true)}
                aria-keyshortcuts="Shift+P"
                className="flex h-8.5 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm text-fg-3 outline-none hover:bg-bg-grp hover:text-fg-2 focus-visible:focus-ring-inset"
              >
                <PlusGlyph className="size-2.25" />
                Link a pull request
                <span className="flex-1" />
                <Kbd aria-hidden>⇧P</Kbd>
              </AriaButton>
            )}
          </PullRequestBox>
        )}
      </LinkArea>
      {note && !readOnly ? <p className="m-0 mt-2 text-sm text-fg-3">{note}</p> : null}
    </section>
  );
}

/**
 * The link field and what it says under the box. Renders `children` with the field (and its preview
 * row) for the box to place, then the refusal under the box.
 */
function LinkArea({
  task,
  projectName,
  isLinking,
  onClose,
  children,
}: {
  task: Task;
  projectName: string;
  isLinking: boolean;
  onClose: () => void;
  children: (field: ReactNode) => ReactNode;
}) {
  const api = useApi();
  const link = useLinkPullRequest(task.key);
  const [text, setText] = useState('');
  const [settled, setSettled] = useState('');
  const [submitted, setSubmitted] = useState<LinkRefusal | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLinking) {
      setText('');
      setSettled('');
      setSubmitted(null);
      link.reset();
    }
  }, [isLinking, link.reset]);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const address = parseRequestAddress(settled);
  const preview = useQuery({
    ...api.orpc.pullRequests.link.queryOptions({
      input: { key: task.key, url: address?.url ?? '', dryRun: true },
    }),
    enabled: isLinking && address != null,
    retry: false,
    staleTime: 60_000,
  });

  const typedAddress = parseRequestAddress(text);
  const refusal: LinkRefusal | null =
    submitted ??
    (settled && settled === text.trim()
      ? !address
        ? { kind: 'not-a-request' }
        : preview.isError
          ? linkRefusal(preview.error, address, projectName)
          : null
      : null);
  const shown = !refusal && address && settled === text.trim() ? preview.data : undefined;

  const submit = () => {
    const current = parseRequestAddress(text);
    if (!current) {
      setSubmitted({ kind: 'not-a-request' });
      return;
    }
    link.mutate(current.url, {
      onSuccess: (linked) => {
        showFieldToast({ text: `Linked ${requestRef(linked.provider, linked.number)} to ${task.key}` });
        onClose();
      },
      onError: (error) => setSubmitted(linkRefusal(error, current, projectName)),
    });
  };

  const invalid = refusal != null;
  const field = (
    <div data-part="link-field">
      <div className="flex min-h-9.5 items-center gap-2.5 pr-2.5 pl-3">
        <PlusGlyph className="size-2.25 shrink-0 text-fg-3" />
        <AriaTextField
          aria-label="Pull request address"
          value={text}
          onChange={(next) => {
            setText(next);
            setSubmitted(null);
          }}
          isInvalid={invalid}
          className="min-w-0 flex-1"
        >
          <AriaInput
            ref={inputRef}
            autoFocus
            placeholder="Paste a pull or merge request address"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
            className={cn(inputBase, 'h-7.5 px-2.5', invalid && invalidInput)}
          />
        </AriaTextField>
        <Kbd aria-hidden>↵</Kbd>
      </div>
      {shown ? (
        <PullRequestRow
          preview
          provider={shown.provider}
          number={shown.number}
          title={shown.title}
          state={shown.state}
          hint={link.isPending ? 'Linking…' : 'Enter links it'}
          className="border-t border-line-soft"
        />
      ) : typedAddress && !refusal && (preview.isFetching || settled !== text.trim()) ? (
        <p className="m-0 flex min-h-9.5 items-center border-t border-line-soft px-3 text-xs text-fg-3">
          Reading {requestRef(typedAddress.provider, typedAddress.number)}…
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      {children(isLinking ? field : null)}
      {isLinking && refusal ? <Refusal refusal={refusal} /> : null}
    </>
  );
}

function Refusal({ refusal }: { refusal: LinkRefusal }) {
  if (refusal.kind === 'other-repository') {
    return (
      <p
        role="alert"
        className="m-0 mt-2 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
      >
        <AlertGlyph className="mt-0.5 shrink-0" />
        <span>{refusal.text}</span>
      </p>
    );
  }
  return (
    <p role="alert" className="m-0 mt-2 text-sm text-danger">
      {refusal.kind === 'not-a-request' ? NOT_A_REQUEST_TEXT : refusal.text}
    </p>
  );
}
