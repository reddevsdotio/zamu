// Views foundation (M5-08): display options, filters, selection and navigation memory shared by
// the list (M5-11), the board (M5-12), the task view (M5-13) and Home (M5-14); M6 adds the
// criteria and done-item counts those views show.

export { type UseViewCommandsOptions, useViewCommands } from './commands';
export {
  DisplayButton,
  type DisplayButtonProps,
  DisplayOptionsPanel,
  type DisplayOptionsPanelProps,
} from './DisplayOptions';
export {
  BOARD_STATUS_ORDER,
  type BoardSubtasks,
  DEFAULT_DISPLAY_OPTIONS,
  type DisplayOptions,
  type DisplayTask,
  defaultDisplayOptions,
  displayListInput,
  GROUP_BY_LABELS,
  GROUP_BYS,
  type GroupBy,
  type GroupContext,
  groupTasks,
  hideOldDone,
  LIST_STATUS_ORDER,
  type ListSubtasks,
  NO_VALUE_GROUP,
  normalizeDisplayOptions,
  ORDER_BY_LABELS,
  type OrderBy,
  PROPERTY_LABELS,
  showsProperty,
  TASK_PROPERTIES,
  type TaskGroup,
  type TaskGroupValue,
  type TaskProperty,
  type TaskViewName,
  type ViewLayout,
} from './display-options';
export {
  FieldFilterPopover,
  type FieldFilterPopoverProps,
  FilterButton,
  type FilterButtonProps,
  FilterChips,
  type FilterChipsProps,
  FilterMenu,
  type FilterMenuProps,
  FilterValuesPanel,
  type FilterValuesPanelProps,
} from './FilterMenu';
export {
  type BuildFilterFieldsInput,
  buildFilterFields,
  chipText,
  DUE_LABELS,
  type FilterFieldConfig,
  type FilterLabel,
  type FilterMember,
  fieldValues,
  type UseProjectFilterFieldsOptions,
  useProjectFilterFields,
  withFieldValues,
} from './filter-fields';
export {
  ASSIGNEE_NONE,
  activeFilterFields,
  type ClientFilterContext,
  type CycleFilterValue,
  clearedFilter,
  clientFilter,
  clientFilterFields,
  FILTER_FIELDS,
  FILTER_PARAMS,
  type FilterField,
  hasTaskFilter,
  isServerFilterComplete,
  matchesTaskFilter,
  parseTaskFilter,
  sameTaskFilter,
  type TaskFilter,
  type TaskFilterInput,
  type TaskFilterSearch,
  taskFilterSearch,
  toHomeInput,
  toListTasksInput,
  withoutField,
  withTaskFilter,
} from './filters';
export {
  forgetTaskNavigation,
  readTaskNavigation,
  rememberTaskNavigation,
  TASK_NAV_STORAGE_KEY,
  type TaskNavigation,
  type TaskNavigationList,
  taskNavigationFor,
  useTaskNavigation,
} from './navigation';
export { requestDisplayOptions, requestFilterMenu } from './requests';
export {
  type ClickModifiers,
  type CurrentTaskSelection,
  getCurrentTaskSelection,
  type TaskSelection,
  type TaskSelectionOptions,
  useCurrentTaskSelection,
  useTaskSelection,
} from './selection';
export {
  type DisplayOptionsUpdate,
  displayStorageKey,
  HOME_DISPLAY_SCOPE,
  type UseDisplayOptionsResult,
  useDisplayOptions,
} from './useDisplayOptions';
export { useUrlTaskFilter } from './useUrlTaskFilter';
export {
  checkedOf,
  NO_PROGRESS,
  progressOfItems,
  progressText,
  type WorkItemKind,
  workItemNoun,
} from './work-progress';
