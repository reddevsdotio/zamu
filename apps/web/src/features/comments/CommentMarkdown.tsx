import type { UserRef } from '@zamu/contracts';
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useOptionalWorkspace } from '~/lib/workspace';
import { type WorkspaceUrlSlug, workspacePath } from '~/lib/workspace-paths';
import { cn } from '~/ui';
import { commentUrlTransform, mentionId } from './mentions';

// Comment bodies and the composer preview. react-markdown never renders raw HTML; links keep only
// http(s) and mention: targets. A mention link turns into a chip when its id is a known member (from the
// comment's own mention list or the workspace members); otherwise it reads as plain text. Links to this
// instance's pre-0.10 task and project URLs (/p/PAY/PAY-12) open them in the comment's workspace.

type KnownMember = Pick<UserRef, 'id' | 'name' | 'kind'>;

/** Comment prose (screens.css .cmt-b): text-md with prose leading, lists, code and links. */
export const commentProse = cn(
  'flex min-w-0 flex-col gap-2 text-md leading-prose break-words text-fg',
  '[&_p]:m-0 [&_p]:text-pretty',
  '[&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-4.5 [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-4.5',
  '[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-bg-lane [&_pre]:px-3 [&_pre]:py-2.5',
  '[&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-normal [&_pre]:whitespace-pre',
  '[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-bg-lane [&_:not(pre)>code]:px-1.25 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-sm',
  '[&_a:not([data-mention])]:text-accent-text [&_a:not([data-mention])]:underline',
);

const MembersContext = createContext<ReadonlyMap<string, KnownMember>>(new Map());

const noSubscription = () => () => {};

/** This page's origin; null on the server and while hydrating, so both render the same href first. */
function usePageOrigin(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,
  );
}

/** `href` under the workspace when it is a pre-0.10 project or task URL of this instance (`origin`). */
export function inWorkspaceHref(
  href: string,
  origin: string | null,
  workspace: WorkspaceUrlSlug | undefined,
): string {
  if (!origin || !workspace) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.origin !== origin || !url.pathname.startsWith('/p/')) return href;
  return `${origin}${workspacePath(workspace, url.pathname)}${url.search}${url.hash}`;
}

/** The renderers read members from context, so the components object keeps its identity. */
const components: Components = {
  a: function CommentLink({ node: _node, href, children }) {
    const members = useContext(MembersContext);
    const workspace = useOptionalWorkspace()?.slug;
    const origin = usePageOrigin();
    const id = mentionId(href);
    if (id) {
      const member = members.get(id);
      if (!member) return <>{children}</>;
      // Margin mention (frame 058): the name in the accent text colour, no chip.
      return (
        <span data-mention className="font-medium text-accent-text">
          @{member.name}
        </span>
      );
    }
    if (!href) return <>{children}</>;
    return (
      <a href={inWorkspaceHref(href, origin, workspace)} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  img: ({ node: _node, alt, src }) =>
    src ? <img src={src} alt={alt ?? ''} className="max-w-full" /> : (alt ?? null),
  input: ({ node: _node, ...props }) =>
    props.type === 'checkbox' ? <input type="checkbox" checked={props.checked} disabled readOnly /> : null,
};

export interface CommentMarkdownProps {
  source: string;
  /** Members the comment mentions, from the server. */
  mentions?: readonly KnownMember[];
  /** Workspace members, for previews and comments whose mention list is not loaded. */
  members?: readonly KnownMember[];
  className?: string;
}

export function CommentMarkdown({ source, mentions, members, className }: CommentMarkdownProps) {
  const known = useMemo(() => {
    const map = new Map<string, KnownMember>();
    for (const member of members ?? []) map.set(member.id, member);
    for (const member of mentions ?? []) map.set(member.id, member);
    return map;
  }, [members, mentions]);
  return (
    <MembersContext.Provider value={known}>
      <div className={cn(commentProse, className)}>
        <MarkdownOnly source={source} />
      </div>
    </MembersContext.Provider>
  );
}

/** The Markdown alone, for the composer preview (which wraps it in commentProse itself). */
export function CommentMarkdownContent({
  source,
  members,
}: {
  source: string;
  members?: readonly KnownMember[];
}) {
  const known = useMemo(() => new Map((members ?? []).map((member) => [member.id, member])), [members]);
  return (
    <MembersContext.Provider value={known}>
      <MarkdownOnly source={source} />
    </MembersContext.Provider>
  );
}

function MarkdownOnly({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={commentUrlTransform} components={components}>
      {source}
    </ReactMarkdown>
  );
}
