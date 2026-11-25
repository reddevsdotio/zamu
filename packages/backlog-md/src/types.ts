/** Why a file could not be read. The message is short and names the line when there is one. */
export type ParseErrorCode =
  | 'missing_frontmatter'
  | 'invalid_yaml'
  | 'invalid_frontmatter'
  | 'missing_id'
  | 'invalid_id'
  | 'invalid_dependencies'
  | 'invalid_config';

export interface ParseError {
  code: ParseErrorCode;
  /** Human text, for example "dependencies must be a flat list (line 9)". */
  message: string;
  /** 1-based line in the file, when known. */
  line?: number;
}

/** Something the parser read around: the file still parses. */
export type ParseWarningCode =
  | 'unreadable_date'
  | 'invalid_due_date'
  | 'missing_title'
  | 'missing_status'
  | 'id_mismatch'
  | 'ignored_value'
  | 'malformed_markers'
  | 'unreadable_raw_config'
  | 'unreadable_legacy_milestones'
  | 'invalid_zamu_block';

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  /** Frontmatter key or section the warning is about. */
  field?: string;
  line?: number;
}

/** Errors are values: parse functions never throw on file content. */
export type ParseResult<T> =
  | { ok: true; value: T; warnings: ParseWarning[] }
  | { ok: false; error: ParseError };

export interface BacklogConfig {
  projectName: string | null;
  /** Uppercase task prefix, default TASK. */
  taskPrefix: string;
  /** Configured statuses in order. Defaults to To Do, In Progress, Done. */
  statuses: string[];
  defaultStatus: string | null;
  /** Configured priorities, or null when the config leaves them at Backlog.md's high, medium, low. */
  priorities: string[] | null;
  labels: string[];
  /** The legacy `milestones:` list. Only meaningful when the folder has no milestone files. */
  legacyMilestones: string[];
  zeroPaddedIds: number | null;
  backlogDirectory: string | null;
  /** Every key as YAML read it, or an empty object when the file is not valid YAML as a whole. */
  raw: Record<string, unknown>;
}

export interface RootConfig {
  /** backlog_directory, normalised (no leading slash, no "..", no trailing slash), or null. */
  backlogDirectory: string | null;
  /**
   * project_name in the root file. When set, Backlog.md treats backlog.config.yml as the project's
   * full config (instead of <folder>/config.yml), so feed the same text to parseConfig.
   */
  projectName: string | null;
}

export type BacklogFileKind =
  | 'config'
  | 'task'
  | 'draft'
  | 'archived'
  | 'milestone'
  | 'archived_milestone'
  | 'ignored';

export interface BacklogId {
  /** Canonical form: uppercase prefix, no zero padding. BACK-786.1 */
  id: string;
  /** Uppercase prefix. BACK */
  prefix: string;
  /** Top-level number. 786 */
  number: number;
  /** Dotted subtask part without the leading dot, or null. "1" for BACK-786.1, "1.2" for BACK-786.1.2 */
  suffix: string | null;
}

export interface ChecklistItem {
  /** The #n written in the file, or the 1-based position when the file has none. */
  index: number;
  checked: boolean;
  text: string;
}

export interface Checklist {
  items: ChecklistItem[];
  /** Section body as written, without HTML markers. Keeps prose around the items. */
  text: string;
}

export interface BacklogComment {
  index: number;
  author: string | null;
  /** The created value as written. */
  createdRaw: string | null;
  /** Parsed created value (UTC when the value has no zone), or null. */
  created: Date | null;
  body: string;
}

export interface TaskSections {
  description: string | null;
  acceptanceCriteria: Checklist | null;
  definitionOfDone: Checklist | null;
  implementationPlan: string | null;
  implementationNotes: string | null;
  comments: BacklogComment[];
  finalSummary: string | null;
  /**
   * Content outside every known section: text after a marked block under headings Backlog.md does
   * not know, or text before the first heading when the file also has a Description section.
   */
  extra: string | null;
}

export interface BacklogTask {
  /** Path as given to parseTask. */
  path: string;
  id: BacklogId;
  title: string;
  /** Status as written; when missing, the config's default status (with a warning), else null. */
  status: string | null;
  /** Every assignee as written (trimmed), "@" kept. */
  assignees: string[];
  reporter: string | null;
  createdDate: Date | null;
  updatedDate: Date | null;
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  labels: string[];
  milestone: string | null;
  /** Canonical IDs where they parse, else the value as written. */
  dependencies: string[];
  parentId: string | null;
  subtasks: string[];
  /** Lowercase, spaces collapsed, as Backlog.md normalises it. */
  priority: string | null;
  type: string | null;
  project: string | null;
  references: string[];
  documentation: string[];
  modifiedFiles: string[];
  ordinal: number | null;
  onStatusChange: string | null;
  /** Frontmatter keys this parser does not read, as YAML read them. */
  unknown: Record<string, unknown>;
  sections: TaskSections;
  /** M6: the Zamu block at the end of the file (taken out of the sections), or null when none. */
  zamu: ZamuBlock | null;
}

export interface BacklogMilestone {
  path: string | null;
  /** m-3 for milestone files (lowercase, no zero padding); the name for legacy config milestones. */
  id: string;
  /** Number from m-N, null for legacy config milestones. */
  number: number | null;
  title: string;
  description: string | null;
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  /** True for legacy `milestones:` entries in config.yml. */
  legacy: boolean;
  unknown: Record<string, unknown>;
}

/** Which list a waiver belongs to: acceptance criteria or definition of done. */
export type ZamuItemKind = 'criterion' | 'done';

/**
 * A waived item: its number and text when it was written, and why it was waived. The file keeps the
 * item itself unchecked, so plain Backlog.md readers see it as not done.
 */
export interface ZamuWaiver {
  kind: ZamuItemKind;
  number: number;
  /** The item's text when the block was written; null when the block leaves it out. */
  text: string | null;
  reason: string;
}

export interface ZamuBlock {
  waived: ZamuWaiver[];
  /** Keys this reader does not know (later releases add some), kept as YAML read them. */
  other: Record<string, unknown>;
}
