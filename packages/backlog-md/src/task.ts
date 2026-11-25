import { defaultConfig } from './config';
import { parseBacklogDate, parseDueDate } from './dates';
import { FieldReader, readFrontmatter } from './frontmatter';
import { baseName, canonicalTaskRef, idFromFileName, parseBacklogId, titleFromFileName } from './ids';
import { parseSections } from './sections';
import type { BacklogConfig, BacklogTask, ParseResult } from './types';
import { atLine } from './yaml';
import { extractZamuBlock } from './zamu-block';

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'status',
  'assignee',
  'reporter',
  'created_date',
  'updated_date',
  'due_date',
  'labels',
  'milestone',
  'dependencies',
  'references',
  'documentation',
  'modified_files',
  'parent_task_id',
  'subtasks',
  'priority',
  'type',
  'project',
  'ordinal',
  'onStatusChange',
]);

function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads a task, draft or archived task file. `path` is used for the file-name fallbacks (ID and
 * title) and is echoed in the result. Drafts are recognised by their DRAFT- prefix; bare numeric
 * references inside a file take the prefix of the file's own ID.
 */
export function parseTask(
  path: string,
  text: string,
  config: BacklogConfig = defaultConfig(),
): ParseResult<BacklogTask> {
  const read = readFrontmatter(text);
  if (!read.ok) return read;
  const fields = new FieldReader(read.file);
  const fileName = baseName(path);
  const fileId = idFromFileName(fileName);
  const fileParsed = fileId ? parseBacklogId(fileId) : null;
  const defaultPrefix = fileParsed?.prefix ?? config.taskPrefix;

  const rawId = fields.text('id');
  let id = fileParsed;
  if (rawId !== null) {
    const parsed = parseBacklogId(rawId, defaultPrefix);
    if (!parsed) {
      const line = fields.line('id');
      return {
        ok: false,
        error: {
          code: 'invalid_id',
          message: `id "${rawId}" is not a task ID like ${defaultPrefix}-12 or ${defaultPrefix}-12.1${atLine(line)}`,
          ...(line !== undefined && { line }),
        },
      };
    }
    if (fileParsed && fileParsed.id !== parsed.id) {
      fields.warn(
        'id_mismatch',
        'id',
        `id ${parsed.id} differs from the file name's ${fileParsed.id}; the id wins`,
      );
    }
    id = parsed;
  }
  if (!id) {
    return {
      ok: false,
      error: {
        code: 'missing_id',
        message: 'no id in the frontmatter and none in the file name (line 2)',
        line: 2,
      },
    };
  }

  const dependencies = fields.raw('dependencies');
  if (
    (Array.isArray(dependencies) && dependencies.some(isStructured)) ||
    (!Array.isArray(dependencies) && isStructured(dependencies))
  ) {
    const line = fields.line('dependencies');
    return {
      ok: false,
      error: {
        code: 'invalid_dependencies',
        message: `dependencies must be a flat list${atLine(line)}`,
        ...(line !== undefined && { line }),
      },
    };
  }

  let title = fields.text('title');
  if (title === null) {
    title = titleFromFileName(fileName) ?? id.id;
    fields.warn('missing_title', 'title', `title is missing; using "${title}"`);
  }

  let status = fields.text('status');
  if (status === null) {
    status = config.defaultStatus ?? config.statuses[0] ?? null;
    fields.warn('missing_status', 'status', `status is missing; using ${status ? `"${status}"` : 'none'}`);
  }

  const date = (key: string): Date | null => {
    const value = fields.text(key);
    if (value === null) return null;
    const parsed = parseBacklogDate(value);
    if (!parsed) fields.warn('unreadable_date', key, `${key} "${value}" is not a date Backlog.md writes`);
    return parsed;
  };

  const due = (): string | null => {
    const value = fields.text('due_date');
    const parsed = parseDueDate(value);
    if (parsed === null) {
      fields.warn('invalid_due_date', 'due_date', `due_date "${value}" is not a YYYY-MM-DD date`);
    }
    return parsed ?? null;
  };

  const refs = (key: string) => fields.list(key).map((value) => canonicalTaskRef(value, id.prefix));
  const priority = fields.text('priority')?.toLowerCase().replace(/\s+/g, ' ') ?? null;
  const parent = fields.text('parent_task_id');

  // M6: the Zamu block is data, not a section: it never reaches the description.
  const { body, block } = extractZamuBlock(read.file.body, fields.warnings);
  const task: BacklogTask = {
    path,
    id,
    title,
    status,
    assignees: fields.list('assignee'),
    reporter: fields.text('reporter'),
    createdDate: date('created_date'),
    updatedDate: date('updated_date'),
    dueDate: due(),
    labels: fields.list('labels'),
    milestone: fields.text('milestone'),
    dependencies: refs('dependencies'),
    parentId: parent === null ? null : canonicalTaskRef(parent, id.prefix),
    subtasks: refs('subtasks'),
    priority,
    type: fields.text('type'),
    project: fields.text('project'),
    references: fields.list('references'),
    documentation: fields.list('documentation'),
    modifiedFiles: fields.list('modified_files'),
    ordinal: fields.number('ordinal'),
    onStatusChange: fields.text('onStatusChange'),
    unknown: fields.unknown(KNOWN_KEYS),
    sections: parseSections(body, fields.warnings),
    zamu: block,
  };
  return { ok: true, value: task, warnings: fields.warnings };
}
