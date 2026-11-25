// M6: writes Backlog.md files: a task file (front matter, then the sections with Backlog.md's
// markers, then the Zamu block) and a milestone file, with the file names Backlog.md gives them.
// The layout follows what Backlog.md 1.57 writes itself (`backlog task create`, `backlog milestone
// add`), so its CLI and this package's reader both read the files. Pure: no I/O, no clock.
import { dump } from 'js-yaml';
import type { ZamuBlock, ZamuWaiver } from './types';
import type { WorkRecordItem } from './work-record';
import { isEmptyZamuBlock, renderZamuBlock } from './zamu-block';

/** The Backlog.md release whose file layout the writer follows. */
export const BACKLOG_FILE_FORMAT = 'backlog.md 1.57';

/** Front matter keys the writer sets itself; `other` keys with these names are left out. */
const WRITTEN_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'status',
  'assignee',
  'reporter',
  'created_date',
  'updated_date',
  'labels',
  'milestone',
  'dependencies',
  'references',
  'documentation',
  'modified_files',
  'parent_task_id',
  'subtasks',
  'priority',
  'due_date',
  'type',
  'ordinal',
]);

export interface TaskFileInput {
  /** Backlog.md id: PAY-12, PAY-12.1. */
  id: string;
  title: string;
  /** Status name as Backlog.md shows it ("To Do", "In Progress", "Done"). */
  status: string;
  /** Assignee values as written in the file ("@claude"). */
  assignees: string[];
  reporter?: string | null;
  createdDate: Date;
  updatedDate?: Date | null;
  labels: string[];
  /** Milestone id (m-3). */
  milestone?: string | null;
  /** Backlog.md ids of the tasks this one depends on. */
  dependencies: string[];
  parentId?: string | null;
  /** Lowercase name (high, medium, low); null for none. */
  priority?: string | null;
  /** YYYY-MM-DD. */
  dueDate?: string | null;
  type?: string | null;
  references?: string[];
  documentation?: string[];
  modifiedFiles?: string[];
  ordinal?: number | null;
  /** Other front matter keys, as YAML values (keys the writer sets itself are skipped). */
  other?: Record<string, unknown>;
  description: string | null;
  criteria: WorkRecordItem[];
  doneItems: WorkRecordItem[];
  plan: string | null;
  implementationNotes: string | null;
  finalSummary: string | null;
  /** Zamu-only data besides the waivers, which come from the items. */
  zamuOther?: Record<string, unknown>;
}

/** A Backlog.md timestamp as the CLI writes it: ISO, UTC, whole seconds. */
export function backlogTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Characters left out of file names (Windows and shells refuse or mangle them). */
const UNSAFE_NAME = /[<>:"/\\|?*#%&{}$!'@+=`^~[\]\p{Cc}]/gu;
const MAX_SLUG_LENGTH = 80;

/** The title part of a Backlog.md file name: words joined by dashes, unsafe characters left out. */
export function titleSlug(title: string): string {
  const slug = title
    .replace(UNSAFE_NAME, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const cut = [...slug]
    .slice(0, MAX_SLUG_LENGTH)
    .join('')
    .replace(/[-.]+$/, '');
  return cut || 'untitled';
}

/** "pay-12 - Retry-failed-webhooks.md", as Backlog.md names task files. */
export function taskFileName(id: string, title: string): string {
  return `${id.toLowerCase()} - ${titleSlug(title)}.md`;
}

/** "m-3 - webhooks-v2.md", as Backlog.md names milestone files. */
export function milestoneFileName(id: string, title: string): string {
  return `${id.toLowerCase()} - ${titleSlug(title).toLowerCase()}.md`;
}

function frontmatter(data: Record<string, unknown>): string {
  return `---\n${dump(data, { lineWidth: -1, noRefs: true })}---\n`;
}

function checklist(items: readonly WorkRecordItem[]): string {
  // A waived item stays unchecked: Backlog.md has no waiver, and it is not done. The Zamu block
  // carries the reason.
  return items
    .map((item, index) => `- [${item.state === 'checked' ? 'x' : ' '}] #${index + 1} ${item.text}`)
    .join('\n');
}

function marked(heading: string, marker: string, text: string, blankAfterHeading: boolean): string {
  return `## ${heading}\n${blankAfterHeading ? '\n' : ''}<!-- ${marker}:BEGIN -->\n${text}\n<!-- ${marker}:END -->`;
}

function waiversOf(input: Pick<TaskFileInput, 'criteria' | 'doneItems'>): ZamuWaiver[] {
  const waivers: ZamuWaiver[] = [];
  const add = (items: readonly WorkRecordItem[], kind: ZamuWaiver['kind']) =>
    items.forEach((item, index) => {
      if (item.state === 'waived') {
        waivers.push({ kind, number: index + 1, text: item.text, reason: item.waivedReason ?? '' });
      }
    });
  add(input.criteria, 'criterion');
  add(input.doneItems, 'done');
  return waivers;
}

/**
 * A task file Backlog.md reads: front matter in the CLI's key order, then Description, Acceptance
 * Criteria, Definition of Done, Implementation Plan, Implementation Notes and Final Summary with
 * their markers (empty sections left out), then the Zamu block when there is anything for it.
 */
export function writeTaskFile(input: TaskFileInput): string {
  const data: Record<string, unknown> = {
    id: input.id,
    title: input.title,
    status: input.status,
    assignee: input.assignees,
  };
  if (input.reporter) data.reporter = input.reporter;
  data.created_date = backlogTimestamp(input.createdDate);
  if (input.updatedDate) data.updated_date = backlogTimestamp(input.updatedDate);
  data.labels = input.labels;
  if (input.milestone) data.milestone = input.milestone;
  data.dependencies = input.dependencies;
  if (input.references?.length) data.references = input.references;
  if (input.documentation?.length) data.documentation = input.documentation;
  if (input.modifiedFiles?.length) data.modified_files = input.modifiedFiles;
  if (input.parentId) data.parent_task_id = input.parentId;
  if (input.priority) data.priority = input.priority;
  if (input.dueDate) data.due_date = input.dueDate;
  if (input.type) data.type = input.type;
  if (input.ordinal !== null && input.ordinal !== undefined && Number.isFinite(input.ordinal)) {
    data.ordinal = input.ordinal;
  }
  for (const [key, value] of Object.entries(input.other ?? {})) {
    if (!WRITTEN_KEYS.has(key) && value !== undefined) data[key] = value;
  }

  const sections: string[] = [];
  const text = (value: string | null) => value?.trim() ?? '';
  const description = text(input.description);
  if (description) sections.push(marked('Description', 'SECTION:DESCRIPTION', description, true));
  if (input.criteria.length > 0) {
    sections.push(marked('Acceptance Criteria', 'AC', checklist(input.criteria), false));
  }
  if (input.doneItems.length > 0) {
    sections.push(marked('Definition of Done', 'DOD', checklist(input.doneItems), false));
  }
  const plan = text(input.plan);
  if (plan) sections.push(marked('Implementation Plan', 'SECTION:PLAN', plan, true));
  const notes = text(input.implementationNotes);
  if (notes) sections.push(marked('Implementation Notes', 'SECTION:NOTES', notes, true));
  const summary = text(input.finalSummary);
  if (summary) sections.push(marked('Final Summary', 'SECTION:FINAL_SUMMARY', summary, true));
  const block: ZamuBlock = { waived: waiversOf(input), other: input.zamuOther ?? {} };
  if (!isEmptyZamuBlock(block)) sections.push(renderZamuBlock(block));

  const head = frontmatter(data);
  return sections.length > 0 ? `${head}\n${sections.join('\n\n')}\n` : head;
}

export interface MilestoneFileInput {
  /** m-3. */
  id: string;
  title: string;
  description: string | null;
  /** YYYY-MM-DD. */
  dueDate?: string | null;
}

/** A milestone file as `backlog milestone add` writes it, with the description under its heading. */
export function writeMilestoneFile(input: MilestoneFileInput): string {
  const data: Record<string, unknown> = { id: input.id, title: input.title };
  if (input.dueDate) data.due_date = input.dueDate;
  const description = input.description?.trim();
  return `${frontmatter(data)}\n## Description\n\n${description || `Milestone: ${input.title}`}\n`;
}

/** One work note for the Implementation notes section. */
export interface NoteEntry {
  /** Display name of who wrote it. */
  author: string;
  /** The agent's responsible human, when an agent wrote it. */
  onBehalfOf?: string | null;
  at: Date;
  body: string;
}

/** "2026-11-20 14:05 UTC". */
function noteTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The Implementation notes section: text the file already had (a switched mirror's notes), then each
 * note in order under a line with its author and time, separated by blank lines.
 */
export function formatImplementationNotes(
  notes: readonly NoteEntry[],
  existing?: string | null,
): string | null {
  const parts: string[] = [];
  const kept = existing?.trim();
  if (kept) parts.push(kept);
  for (const note of notes) {
    const body = note.body.trim();
    if (!body) continue;
    const who = note.onBehalfOf ? `${note.author} (for ${note.onBehalfOf})` : note.author;
    parts.push(`**${who}** · ${noteTime(note.at)}\n\n${body}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
