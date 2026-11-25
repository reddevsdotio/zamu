// Backlog.md mirror engine (M3-06): detection, preview, refresh (plan, then apply), mappings,
// hide and restore, detach, webhook acceptance and the refresh and poll jobs. M6: the work record
// fill, the switch to Zamu (check and confirm) and the export.
export {
  type ApplyInput,
  type ApplyResult,
  applyPlan,
  type BacklogSourceRow,
  releaseBacklogLabels,
} from './apply';
export { exportBacklog } from './export';
export { backlogDueDate, backlogLabelNames, leastUsedLabelColor } from './fields';
export { diffItems, sameItems } from './items';
export {
  FALLBACK_PRIORITY,
  FALLBACK_STATUS,
  MappingIndex,
  type MemberCandidate,
  mappingsView,
  matchAssigneeByName,
  matchPriorityByName,
  matchStatusByName,
  prefillMappings,
  type SeenValues,
} from './mappings';
export {
  type BacklogPlan,
  type ExistingState,
  type PlanFile,
  type PlanInput,
  planChangesContent,
  planRefresh,
} from './plan';
export { commitUrl, DEFAULT_FOLDERS, folderCounts, locateFolder, readFolder, repositoryRef } from './reader';
export {
  enqueueBacklogRefresh,
  enqueueBacklogRefreshes,
  nextPollAt,
  pollBacklogSources,
  REFRESH_THROTTLE_SECONDS,
  type RefreshContext,
  type RefreshOptions,
  type RefreshOutcome,
  type RefreshOutcomeKind,
  refreshBacklogSource,
} from './refresh';
export {
  type BacklogSettingsContext,
  backlogWebhookUrl,
  detachBacklog,
  detachSource,
  getBacklogWebhookInfo,
  refreshBacklogNow,
  reissueBacklogWebhookSecret,
  requestBacklogRefresh,
  setBacklogConnection,
  setBacklogFolder,
  updateBacklogMappings,
} from './settings';
export {
  type BacklogSetupContext,
  createProjectFromBacklog,
  detectBacklog,
  detectBacklogRepository,
  newWebhookCredentials,
  previewBacklog,
  startBacklog,
} from './setup';
export { backlogStatus, getBacklogSettingsStatus, getBacklogStatus } from './status';
export {
  type BacklogSwitchCheck,
  type BacklogSwitchFailure,
  type BacklogSwitchResult,
  checkBacklogSwitch,
  switchBacklogToZamu,
} from './switch';
export { acceptBacklogWebhook, type BacklogWebhookDecision, type WebhookContext } from './webhook';
