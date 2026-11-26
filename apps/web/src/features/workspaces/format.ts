// Pure helpers for the workspace screens: checking a typed slug before it is sent, the address a slug
// gives, and the sentences of the Delete confirm. Safe for the client bundle; tested on their own.
import {
  isReservedWorkspaceSlug,
  WORKSPACE_SLUG_MESSAGES,
  type WorkspaceContents,
  WorkspaceName,
  WorkspaceSlugInput,
} from '@zamu/contracts';

/** What a slug field shows while typing: lower case, and spaces or underscores as hyphens. */
export function normalizeSlugInput(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, '-');
}

/** The first thing wrong with a typed slug, in the words of the slug rule, or null when it may be sent. */
export function slugError(slug: string): string | null {
  const parsed = WorkspaceSlugInput.safeParse(slug);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? WORKSPACE_SLUG_MESSAGES.characters;
  if (isReservedWorkspaceSlug(parsed.data)) return WORKSPACE_SLUG_MESSAGES.reserved;
  return null;
}

/** The first thing wrong with a typed workspace name, or null. */
export function nameError(name: string): string | null {
  const parsed = WorkspaceName.safeParse(name);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter a name for the workspace.');
}

function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "a, b and c". */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The first sentence of the Delete confirm: "Deletes Acme with 3 projects, 120 tasks and 2 agents."
 * Counts of zero are left out; API keys are named only when some still work.
 */
export function deleteSentence(name: string, contents: WorkspaceContents): string {
  const parts = [
    contents.projects ? counted(contents.projects, 'project', 'projects') : null,
    contents.tasks ? counted(contents.tasks, 'task', 'tasks') : null,
    contents.agents ? counted(contents.agents, 'agent', 'agents') : null,
    contents.keys ? counted(contents.keys, 'API key', 'API keys') : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? `Deletes ${name} with ${listOf(parts)}.` : `Deletes ${name}. It has no projects yet.`;
}

/** The rest of the Delete confirm, after deleteSentence. */
export const DELETE_WORKSPACE_TEXT =
  "Members lose access, its agents and API keys stop working, and the address is freed. This can't be undone.";

/** The address hint of the slug fields. */
export function addressHint(slug: string): string {
  return slug ? `Pages of the workspace live under /w/${slug}.` : 'Pages of the workspace live under it.';
}
