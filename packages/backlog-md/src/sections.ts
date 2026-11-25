import { parseBacklogDate } from './dates';
import type { BacklogComment, Checklist, ChecklistItem, ParseWarning, TaskSections } from './types';

type SectionKey =
  | 'description'
  | 'acceptanceCriteria'
  | 'definitionOfDone'
  | 'implementationPlan'
  | 'implementationNotes'
  | 'comments'
  | 'finalSummary';

/** Heading text (lowercase) to section. Includes the older "(Optional)" and "Notes" headings. */
const HEADINGS: Record<string, SectionKey> = {
  description: 'description',
  'acceptance criteria': 'acceptanceCriteria',
  'acceptance criteria (optional)': 'acceptanceCriteria',
  'definition of done': 'definitionOfDone',
  'implementation plan': 'implementationPlan',
  'implementation plan (optional)': 'implementationPlan',
  'implementation notes': 'implementationNotes',
  'implementation notes (optional)': 'implementationNotes',
  notes: 'implementationNotes',
  'notes & comments (optional)': 'implementationNotes',
  comments: 'comments',
  'final summary': 'finalSummary',
};

const MARKER_FAMILY: Record<SectionKey, string> = {
  description: 'SECTION:DESCRIPTION',
  acceptanceCriteria: 'AC',
  definitionOfDone: 'DOD',
  implementationPlan: 'SECTION:PLAN',
  implementationNotes: 'SECTION:NOTES',
  comments: 'COMMENTS',
  finalSummary: 'SECTION:FINAL_SUMMARY',
};

const ANY_MARKER_LINE = /^<!-- (?:SECTION:[A-Z][A-Z0-9_]*|AC|DOD|COMMENTS|COMMENT):(?:BEGIN|END) -->[\t ]*$/;
const HEADING_LINE = /^##[\t ]+(.+?)[\t ]*$/;

/** True for every line inside a fenced code block, fences included. */
export function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      mask.push(true);
      if (opening?.[1]?.startsWith(fence.char) && opening[1].length >= fence.length && !opening[2]?.trim()) {
        fence = null;
      }
      continue;
    }
    if (opening?.[1] && !(opening[1].startsWith('`') && opening[2]?.includes('`'))) {
      fence = { char: opening[1].charAt(0), length: opening[1].length };
      mask.push(true);
      continue;
    }
    mask.push(false);
  }
  return mask;
}

function trimBlock(lines: string[]): string | null {
  const text = lines.join('\n').trim();
  return text.length > 0 ? text : null;
}

/** Drops whole-line Backlog.md markers outside code fences. */
function stripMarkers(text: string): string {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  return lines
    .filter((line, index) => mask[index] || !ANY_MARKER_LINE.test(line))
    .join('\n')
    .trim();
}

function parseChecklist(body: string): Checklist {
  const lines = body.split('\n');
  const mask = fenceMask(lines);
  const items: ChecklistItem[] = [];
  lines.forEach((line, index) => {
    if (mask[index]) return;
    const match = line.match(/^- \[([ xX])\] (?:#(\d+) )?(.+)$/);
    if (!match) return;
    items.push({
      index: match[2] ? Number(match[2]) : items.length + 1,
      checked: match[1] !== ' ',
      text: (match[3] ?? '').trim(),
    });
  });
  return { items, text: stripMarkers(body) };
}

function commentMetadata(lines: string[]): { author: string | null; createdRaw: string | null } {
  let author: string | null = null;
  let createdRaw: string | null = null;
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1].toLowerCase();
    const value = (match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (key === 'author' && value) author = value;
    if (key === 'created' && value) createdRaw = value;
  }
  return { author, createdRaw };
}

function comment(index: number, metadata: string[], body: string): BacklogComment {
  const { author, createdRaw } = commentMetadata(metadata);
  return { index, author, createdRaw, created: parseBacklogDate(createdRaw), body };
}

/** The current format: metadata lines, then the body between two `---` lines. */
function parseDelimitedComments(body: string): BacklogComment[] {
  const lines = body.split('\n');
  const comments: BacklogComment[] = [];
  let index = 0;
  const isDelimiter = (line: string | undefined) => line?.trim() === '---';
  while (index < lines.length) {
    while (index < lines.length && lines[index]?.trim() === '') index += 1;
    if (index >= lines.length) break;
    const metadata: string[] = [];
    while (index < lines.length && !isDelimiter(lines[index])) metadata.push(lines[index++] ?? '');
    if (index >= lines.length) break;
    index += 1;
    const bodyLines: string[] = [];
    while (index < lines.length && !isDelimiter(lines[index])) bodyLines.push(lines[index++] ?? '');
    if (index >= lines.length) break;
    index += 1;
    const text = bodyLines.join('\n').trim();
    if (text) comments.push(comment(comments.length + 1, metadata, text));
  }
  return comments;
}

/** The older format: one <!-- COMMENT:BEGIN --> block per comment, metadata then a blank line. */
function parseCommentBlocks(body: string): BacklogComment[] {
  const comments: BacklogComment[] = [];
  for (const match of body.matchAll(/<!-- COMMENT:BEGIN -->[\t ]*\n([\s\S]*?)<!-- COMMENT:END -->/g)) {
    const block = (match[1] ?? '').trim();
    if (!block) continue;
    const separator = block.search(/\n\s*\n/);
    const metadata = separator >= 0 ? block.slice(0, separator).split('\n') : [];
    const text = separator >= 0 ? block.slice(separator).trim() : block;
    if (text) comments.push(comment(comments.length + 1, metadata, text));
  }
  return comments;
}

function parseComments(body: string, marked: boolean): BacklogComment[] {
  if (/^<!-- COMMENT:BEGIN -->/m.test(body)) return parseCommentBlocks(body);
  const delimited = parseDelimitedComments(body);
  if (delimited.length > 0 || marked) return delimited;
  // A plain "## Comments" heading with free text: keep it as one comment rather than lose it.
  const text = stripMarkers(body);
  return text ? [comment(1, [], text)] : [];
}

interface RawSection {
  body: string;
  marked: boolean;
}

/**
 * Splits a task body into its sections. Handles both styles Backlog.md has written: `## Title`
 * followed by BEGIN/END markers, and plain `## Title` headings that run until the next known heading.
 * Headings and markers inside code fences are content.
 */
export function parseSections(body: string, warnings: ParseWarning[] = []): TaskSections {
  const lines = body.split('\n');
  const mask = fenceMask(lines);
  const knownHeading = (index: number): SectionKey | undefined => {
    if (mask[index]) return undefined;
    const title = lines[index]?.match(HEADING_LINE)?.[1];
    return title ? HEADINGS[title.toLowerCase()] : undefined;
  };

  const found = new Map<SectionKey, RawSection>();
  const preamble: string[] = [];
  const extra: string[] = [];
  let seenSection = false;
  // A repeated section: a marked one wins over plain ones (as in Backlog.md); same kinds are joined.
  const add = (key: SectionKey, sectionLines: string[], marked: boolean) => {
    const text = sectionLines.join('\n');
    const existing = found.get(key);
    if (!existing || (marked && !existing.marked)) found.set(key, { body: text, marked });
    else if (marked === existing.marked)
      found.set(key, { body: `${existing.body.trim()}\n\n${text.trim()}`, marked });
  };

  let index = 0;
  while (index < lines.length) {
    const key = knownHeading(index);
    if (!key) {
      (seenSection ? extra : preamble).push(lines[index] ?? '');
      index += 1;
      continue;
    }
    seenSection = true;

    let beginIndex = index + 1;
    while (beginIndex < lines.length && lines[beginIndex]?.trim() === '') beginIndex += 1;
    const family = MARKER_FAMILY[key];
    const begin = `<!-- ${family}:BEGIN -->`;
    const end = `<!-- ${family}:END -->`;
    if (lines[beginIndex]?.trimEnd() === begin) {
      let depth = 1;
      let endIndex = beginIndex + 1;
      for (; endIndex < lines.length; endIndex += 1) {
        const candidate = lines[endIndex]?.trimEnd();
        if (candidate === begin) depth += 1;
        else if (candidate === end) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        add(key, lines.slice(beginIndex + 1, endIndex), true);
        index = endIndex + 1;
        continue;
      }
      warnings.push({
        code: 'malformed_markers',
        message: `${begin} has no matching ${end} (line ${beginIndex + 1} of the body); read as a plain section`,
        field: key,
      });
    }

    let next = index + 1;
    while (next < lines.length && !knownHeading(next)) next += 1;
    add(key, lines.slice(index + 1, next), false);
    index = next;
  }

  const text = (key: SectionKey) => {
    const section = found.get(key);
    if (!section) return null;
    const stripped = stripMarkers(section.body);
    return stripped.length > 0 ? stripped : null;
  };
  const checklist = (key: SectionKey) => {
    const section = found.get(key);
    if (!section) return null;
    const parsed = parseChecklist(section.body);
    return parsed.items.length > 0 || parsed.text.length > 0 ? parsed : null;
  };

  let description = text('description');
  const preambleText = trimBlock(preamble);
  const extraParts: string[] = [];
  if (preambleText) {
    if (description === null) description = stripMarkers(preambleText) || null;
    else extraParts.push(preambleText);
  }
  const extraText = trimBlock(extra);
  if (extraText) extraParts.push(extraText);
  const extraJoined = stripMarkers(extraParts.join('\n\n'));
  const commentsSection = found.get('comments');

  return {
    description,
    acceptanceCriteria: checklist('acceptanceCriteria'),
    definitionOfDone: checklist('definitionOfDone'),
    implementationPlan: text('implementationPlan'),
    implementationNotes: text('implementationNotes'),
    comments: commentsSection ? parseComments(commentsSection.body, commentsSection.marked) : [],
    finalSummary: text('finalSummary'),
    extra: extraJoined.length > 0 ? extraJoined : null,
  };
}

/** The Description section of a milestone file, or of any Markdown body. */
export function parseDescription(body: string): string | null {
  return parseSections(body).description;
}
