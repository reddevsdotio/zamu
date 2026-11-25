// The work record of a task (M6): acceptance criteria, done items, plan, final summary, the finishing
// step, and the pure rules behind them. The task view imports from here.

export { FinishDialog, type FinishDialogProps } from './FinishDialog';
export { FinishingHost, keyList, manyFinishingText } from './FinishingHost';
export {
  applyItemOps,
  applyWorkPatch,
  FINISHING,
  firstName,
  type ItemOps,
  isFromDefaults,
  needsFinishing,
  type OpenItem,
  openItemsOf,
  PLAN_CLIP_LINES,
  planLabel,
  planSize,
  progressNote,
  progressOf,
  toWorkInput,
  type WorkPatch,
} from './ops';
export { metaAuthor, PlanSection, type PlanSectionProps } from './PlanSection';
export { applyOptimisticWork, useWorkRecordUpdate, type WorkUpdateVariables } from './queries';
export { FileNotes, TaskSummary } from './SummaryAndNotes';
export {
  itemName,
  SECTION_TITLE,
  SectionHead,
  useItemActions,
  WorkItemSection,
  type WorkItemSectionProps,
} from './WorkItemSection';
