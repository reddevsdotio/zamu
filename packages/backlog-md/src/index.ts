// Backlog.md folder parser and writer. Pure: callers pass file contents and get typed records or
// error values; the writer returns file contents.
export {
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  DEFAULT_TASK_PREFIX,
  defaultConfig,
  parseConfig,
  parseRootConfig,
} from './config';
export { parseBacklogDate, parseDueDate } from './dates';
export { type FolderFile, type ParsedFile, type ParsedFolder, parseBacklogFolder } from './folder';
export { canonicalTaskRef, type MilestoneId, parseBacklogId, parseMilestoneId } from './ids';
export {
  legacyConfigMilestones,
  type MilestoneCandidate,
  matchMilestone,
  parseMilestone,
} from './milestone';
export { type ClassifyOptions, classifyPath } from './paths';
export { renderDescription } from './render';
export { parseSections } from './sections';
export { parseTask } from './task';
export type * from './types';
export {
  applyWaivers,
  splitRenderedDescription,
  taskWorkRecord,
  type WorkRecord,
  type WorkRecordItem,
  type WorkRecordItemState,
} from './work-record';
export {
  BACKLOG_FILE_FORMAT,
  backlogTimestamp,
  formatImplementationNotes,
  type MilestoneFileInput,
  milestoneFileName,
  type NoteEntry,
  type TaskFileInput,
  taskFileName,
  titleSlug,
  writeMilestoneFile,
  writeTaskFile,
} from './write';
export {
  emptyZamuBlock,
  extractZamuBlock,
  isEmptyZamuBlock,
  parseZamuBlock,
  renderZamuBlock,
  ZAMU_BLOCK_END,
  ZAMU_BLOCK_START,
} from './zamu-block';
