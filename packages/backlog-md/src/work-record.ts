// M6: the work record of a Backlog.md task (acceptance criteria, definition of done, plan, notes,
// final summary) as a mirror fills it, and the description that is left. Until 0.9.0 the refresh
// rendered those sections into the description (renderDescription); the m6_work_record migration
// (packages/db/migrations/20261125110203_m6_work_record) moves them out of stored descriptions. The
// fill works on the same rendered text with the same rules, ported line for line from that SQL, so
// the first refresh after an upgrade changes nothing for a file that did not change. Keep the two
// in step.
import { renderDescription } from './render';
import type { BacklogTask, ZamuBlock, ZamuItemKind } from './types';

export type WorkRecordItemState = 'open' | 'checked' | 'waived';

/** One criterion or done item. Its number is its position in the list, counted from 1. */
export interface WorkRecordItem {
  text: string;
  state: WorkRecordItemState;
  /** Set while waived (from the file's Zamu block), null otherwise. */
  waivedReason: string | null;
}

export interface WorkRecord {
  /** What stays in the description; null when nothing does. */
  description: string | null;
  criteria: WorkRecordItem[];
  doneItems: WorkRecordItem[];
  plan: string | null;
  finalSummary: string | null;
  /** The Implementation notes section, kept read-only in the task's Backlog.md block. */
  implementationNotes: string | null;
}

/** The migration only rewrites descriptions with one of these headings (fences not considered). */
const SECTION_HEADING =
  /(^|\n)## (Acceptance criteria|Definition of done|Implementation plan|Implementation notes|Final summary)\r?(\n|$)/;
// Postgres regular expressions let `.` match any character; [\s\S] does the same here.
const FENCE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const ITEM = /^- \[([ xX])\] (?:#([0-9]+) )?([\s\S]+)$/;

type Section = 'description' | 'ac' | 'dod' | 'plan' | 'notes' | 'comments' | 'summary';

const HEADINGS: Record<string, Section> = {
  '## Acceptance criteria': 'ac',
  '## Definition of done': 'dod',
  '## Implementation plan': 'plan',
  '## Implementation notes': 'notes',
  '## Comments from Backlog.md': 'comments',
  '## Final summary': 'summary',
};

/** regexp_replace(text, '^\s+|\s+$', '', 'g'): ASCII whitespace, as Postgres' [[:space:]] in the C locale. */
function trimSql(text: string): string {
  return text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
}

/** btrim(text, E' \t'). */
function trimSpaceTab(text: string): string {
  return text.replace(/^[\t ]+|[\t ]+$/g, '');
}

function nullIfEmpty(text: string): string | null {
  return text === '' ? null : text;
}

/**
 * Splits a description rendered by renderDescription into the work record, exactly as the M6
 * migration's backfill does. A description without any of the five headings stays as it is.
 */
export function splitRenderedDescription(rendered: string | null): WorkRecord {
  const empty = { criteria: [], doneItems: [], plan: null, finalSummary: null, implementationNotes: null };
  if (rendered === null || !SECTION_HEADING.test(rendered)) {
    return { description: rendered === '' ? null : rendered, ...empty };
  }
  const lines = rendered.split(/\r?\n/);
  const parts: Record<Section, string[]> = {
    description: [],
    ac: [],
    dod: [],
    plan: [],
    notes: [],
    comments: [],
    summary: [],
  };
  const criteria: WorkRecordItem[] = [];
  const doneItems: WorkRecordItem[] = [];
  let fenceChar: string | null = null;
  let fenceLength = 0;
  let section: Section = 'description';

  for (const line of lines) {
    // Code fences, with the rules of the Backlog.md parser: a fence closes on the same character,
    // at least as long, with nothing after it; a backtick fence whose info string has a backtick is
    // not a fence.
    const opening = FENCE.exec(line);
    let inFence: boolean;
    if (fenceChar !== null) {
      inFence = true;
      const marker = opening?.[1] ?? '';
      if (
        opening &&
        marker.charAt(0) === fenceChar &&
        marker.length >= fenceLength &&
        trimSpaceTab(opening[2] ?? '') === ''
      ) {
        fenceChar = null;
      }
    } else if (opening && !(opening[1]?.charAt(0) === '`' && (opening[2] ?? '').includes('`'))) {
      fenceChar = opening[1]?.charAt(0) ?? null;
      fenceLength = opening[1]?.length ?? 0;
      inFence = true;
    } else {
      inFence = false;
    }

    if (!inFence) {
      const heading = HEADINGS[line];
      if (heading) {
        section = heading;
        continue;
      }
    }

    if ((section === 'ac' || section === 'dod') && !inFence) {
      const item = ITEM.exec(line);
      if (item) {
        const text = trimSql(item[3] ?? '');
        if (text !== '') {
          (section === 'ac' ? criteria : doneItems).push({
            text,
            state: item[1] === ' ' ? 'open' : 'checked',
            waivedReason: null,
          });
        }
        continue;
      }
    }
    parts[section].push(line);
  }

  const block = (section: Section) => trimSql(parts[section].join('\n'));
  const description: string[] = [];
  const add = (heading: string | null, text: string) => {
    if (text !== '') description.push(heading ? `${heading}\n\n${text}` : text);
  };
  add(null, block('description'));
  add('## Acceptance criteria', block('ac'));
  add('## Definition of done', block('dod'));
  add('## Comments from Backlog.md', block('comments'));

  return {
    description: nullIfEmpty(description.join('\n\n')),
    criteria,
    doneItems,
    plan: nullIfEmpty(block('plan')),
    finalSummary: nullIfEmpty(block('summary')),
    implementationNotes: nullIfEmpty(block('notes')),
  };
}

/**
 * Marks the items a Zamu block waives: the open item at the waiver's number when its text matches
 * (or the block has no text), else the first open item with that text. Checked items stay checked.
 */
export function applyWaivers(
  items: readonly WorkRecordItem[],
  kind: ZamuItemKind,
  block: ZamuBlock | null,
): WorkRecordItem[] {
  const result = items.map((item) => ({ ...item }));
  for (const waiver of block?.waived ?? []) {
    if (waiver.kind !== kind) continue;
    const open = (item: WorkRecordItem | undefined) => item?.state === 'open';
    const atNumber = result[waiver.number - 1];
    const target =
      open(atNumber) && (waiver.text === null || atNumber?.text === waiver.text)
        ? atNumber
        : waiver.text === null
          ? undefined
          : result.find((item) => open(item) && item.text === waiver.text);
    if (!target) continue;
    target.state = 'waived';
    target.waivedReason = waiver.reason;
  }
  return result;
}

/** The work record a mirror or an import fills from a parsed task file. */
export function taskWorkRecord(task: Pick<BacklogTask, 'sections' | 'zamu'>): WorkRecord {
  const record = splitRenderedDescription(renderDescription(task));
  return {
    ...record,
    criteria: applyWaivers(record.criteria, 'criterion', task.zamu),
    doneItems: applyWaivers(record.doneItems, 'done', task.zamu),
  };
}
