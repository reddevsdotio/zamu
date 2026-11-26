import { useQuery } from '@tanstack/react-query';
import type { ListTasksInput, TaskListItem } from '@zamu/contracts';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { useProjectSummary } from '~/features/project-header';
import { taskListQuery } from '~/features/tasks/queries';
import {
  type DisplayOptions,
  displayListInput,
  type FilterField,
  GROUP_BYS,
  type GroupBy,
  hasTaskFilter,
  type TaskFilter,
  toListTasksInput,
  useDisplayOptions,
  useProjectFilterFields,
  useUrlTaskFilter,
} from '~/features/views';
import { useApi } from '~/lib/workspace';

// Tasks of a milestone or cycle page, with the M5 filter in the URL (status, assignee, label …) and
// the person's list Display options of the project. Done and canceled tasks stay out of the rows
// until someone asks for them ("done tasks hidden" in the page head) or filters on those statuses.

type ListInput = z.input<typeof ListTasksInput>;

export type PlanningScope = { milestone: string } | { cycle: number };

const CLOSED = new Set(['done', 'canceled']);

/** The filter fields of a planning page: everything but the page's own field and the off features. */
export function planningFilterFields(
  hide: 'milestone' | 'cycle',
  uses: { milestones: boolean; cycles: boolean },
): FilterField[] {
  const fields: FilterField[] = ['status', 'priority', 'assignee', 'label', 'due', 'blocked'];
  if (hide !== 'milestone' && uses.milestones) fields.push('milestone');
  if (hide !== 'cycle' && uses.cycles) fields.push('cycle');
  return fields;
}

/** The groupings the Display popover offers on a planning page. */
export function planningGroupChoices(hide: 'milestone' | 'cycle'): GroupBy[] {
  return GROUP_BYS.filter((choice) => choice !== hide);
}

/** tasks.list input of a planning page: the page's scope wins over the same field in the filter. */
export function planningListInput(
  projectKey: string,
  scope: PlanningScope,
  filter: TaskFilter,
  display?: DisplayOptions,
): ListInput {
  const filtered = toListTasksInput(filter);
  return {
    project: projectKey,
    ...filtered,
    ...(display ? displayListInput(display) : {}),
    ...('milestone' in scope ? { milestone: scope.milestone } : { cycle: String(scope.cycle) }),
  } as ListInput;
}

/** Leaves out Done and Canceled unless `show`, or unless the filter asks for those statuses. */
export function withoutClosed(
  tasks: readonly TaskListItem[],
  filter: TaskFilter,
  show: boolean,
): { shown: TaskListItem[]; hidden: number } {
  const asked = filter.status?.some((status) => CLOSED.has(status)) ?? false;
  if (show || asked) return { shown: [...tasks], hidden: 0 };
  const shown = tasks.filter((task) => !CLOSED.has(task.status));
  return { shown, hidden: tasks.length - shown.length };
}

export function usePlanningTasks(projectKey: string, scope: PlanningScope, enabled = true) {
  const api = useApi();
  const project = useProjectSummary(projectKey);
  const hide = 'milestone' in scope ? 'milestone' : 'cycle';
  const [filter, setFilter] = useUrlTaskFilter();
  const fields = useProjectFilterFields(projectKey, {
    ...(project ? { projectName: project.name } : {}),
    usesMilestones: project?.usesMilestones ?? true,
    usesCycles: project?.usesCycles ?? true,
    fields: planningFilterFields(hide, {
      milestones: project?.usesMilestones ?? true,
      cycles: project?.usesCycles ?? true,
    }),
  });
  const [display] = useDisplayOptions(projectKey, 'list');
  const [showClosed, setShowClosed] = useState(false);

  const tasks = useQuery({
    ...taskListQuery(api, planningListInput(projectKey, scope, filter, display)),
    enabled,
  });
  /** Every task of the page, for the counts and the end dialog. */
  const all = useQuery({
    ...taskListQuery(api, planningListInput(projectKey, scope, {})),
    enabled,
  });

  const { shown, hidden } = useMemo(
    () => withoutClosed(tasks.data?.items ?? [], filter, showClosed),
    [tasks.data, filter, showClosed],
  );

  return {
    project,
    hide,
    filter,
    setFilter,
    filtered: hasTaskFilter(filter),
    fields,
    display,
    tasks,
    all,
    shown,
    hiddenClosed: hidden,
    showClosed,
    setShowClosed,
  } as const;
}
