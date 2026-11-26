import type { QueryClient } from '@tanstack/react-query';
import {
  type AssigneeRef,
  OPEN_TASK_STATUSES,
  PRIORITY_LABELS,
  type Priority,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
} from '@zamu/contracts';
import { labelsQuery } from '~/features/labels/queries';
import type { Command, PaletteStep } from '~/features/palette/registry';
import { cyclesQuery, membersQuery, milestonesQuery, relatedOf, taskQuery } from '~/features/tasks/queries';
import type { WorkspaceApi } from '~/lib/orpc';
import { toAssigneeRef } from './AssigneePicker';
import type { FieldChange } from './apply';
import { formatDayWithWeekday, quickPicks } from './dates';
import { cycleLabel, cycleNote, toCycleRef, toMilestoneRef } from './planning';
import { PRIORITY_ORDER } from './StatusPicker';
import { firstName } from './shared';
import { type FieldTarget, projectKeysOf, type TaskFieldKey } from './targets';

// The field actions as command palette steps: S on a selection with no picker on screen opens the
// palette at "Set status"; ⌘K then "Change status" shows the same step.

/** Each field's command: title, key (as in useHotkeys) and extra search words. */
export const FIELD_COMMANDS: Record<
  TaskFieldKey,
  { title: string; step: string; placeholder: string; shortcut?: string; keywords: readonly string[] }
> = {
  status: {
    title: 'Change status',
    step: 'Set status',
    placeholder: 'Pick a status…',
    shortcut: 's',
    keywords: ['state', 'move'],
  },
  priority: {
    title: 'Set priority',
    step: 'Set priority',
    placeholder: 'Pick a priority…',
    shortcut: 'p',
    keywords: ['urgent', 'importance'],
  },
  assignee: {
    title: 'Assign',
    step: 'Assign',
    placeholder: 'Assign to…',
    shortcut: 'a',
    keywords: ['assignee', 'owner', 'person', 'agent'],
  },
  labels: {
    title: 'Add labels',
    step: 'Labels',
    placeholder: 'Pick a label…',
    shortcut: 'l',
    keywords: ['label', 'tag'],
  },
  dueDate: {
    title: 'Set due date',
    step: 'Set due date',
    placeholder: 'Pick a date…',
    shortcut: 'Shift+d',
    keywords: ['due', 'deadline', 'date'],
  },
  milestone: {
    title: 'Move to milestone',
    step: 'Move to milestone',
    placeholder: 'Pick a milestone…',
    shortcut: 'Shift+m',
    keywords: ['milestone'],
  },
  cycle: {
    title: 'Add to cycle',
    step: 'Add to cycle',
    placeholder: 'Pick a cycle…',
    shortcut: 'Shift+c',
    keywords: ['cycle', 'sprint'],
  },
  blockedBy: {
    title: 'Add blocker',
    step: 'Add blocker',
    placeholder: 'Pick the task it waits on…',
    shortcut: 'Shift+b',
    keywords: ['blocked', 'depends', 'waits'],
  },
  subtasks: {
    title: 'Add subtask',
    step: 'Add subtask',
    placeholder: 'Pick a task to nest…',
    shortcut: 'Shift+s',
    keywords: ['child', 'subtask'],
  },
  // No key (shortcuts.md has none): the palette and the Parent property row.
  parent: {
    title: 'Set parent…',
    step: 'Set parent',
    placeholder: 'Pick the parent task…',
    keywords: ['parent', 'subtask', 'nest', 'move under'],
  },
};

export interface StepContext {
  targets: readonly FieldTarget[];
  apply: FieldChange['apply'];
  queryClient: QueryClient;
  /** "PAY-142" or "3 selected". */
  context: string;
  today: string;
}

const done = () => undefined;

/** The palette step for a field: the choices, each applying to the targets. */
export async function fieldStep(
  api: WorkspaceApi,
  field: TaskFieldKey,
  ctx: StepContext,
): Promise<PaletteStep> {
  const { targets, apply, queryClient, context, today } = ctx;
  const meta = FIELD_COMMANDS[field];
  const command = (id: string, title: string, run: () => void, extra: Partial<Command> = {}): Command => ({
    id: `task.${field}.${id}`,
    title,
    section: 'task',
    context,
    run: () => {
      run();
      return done();
    },
    ...extra,
  });
  const step = (commands: Command[]): PaletteStep => ({
    title: meta.step,
    placeholder: meta.placeholder,
    commands,
  });
  const projectKey = projectKeysOf(targets)[0] ?? '';
  const single = targets.length === 1 ? targets[0] : undefined;

  switch (field) {
    case 'status':
      return step(
        TASK_STATUSES.map((status, index) =>
          command(status, TASK_STATUS_LABELS[status], () => void apply(targets, { status }), {
            shortcut: String(index + 1),
          }),
        ),
      );
    case 'priority':
      return step(
        PRIORITY_ORDER.map((priority: Priority, index) =>
          command(priority, PRIORITY_LABELS[priority], () => void apply(targets, { priority }), {
            shortcut: String(index),
          }),
        ),
      );
    case 'assignee': {
      const members = (await queryClient.ensureQueryData(membersQuery(api))).items;
      const assign = (assignee: AssigneeRef | null) => () => void apply(targets, { assignee });
      return step([
        command('none', 'No assignee', assign(null), { shortcut: '0', keywords: ['unassign', 'nobody'] }),
        ...members.map((member) =>
          command(
            member.id,
            member.responsible ? `${member.name} for ${firstName(member.responsible.name)}` : member.name,
            assign(toAssigneeRef(member)),
            { keywords: member.kind === 'agent' ? ['agent'] : [] },
          ),
        ),
      ]);
    }
    case 'labels': {
      const labels = (await queryClient.ensureQueryData(labelsQuery(api, projectKey))).items;
      const lower = (name: string) => name.toLocaleLowerCase();
      const onAll = (name: string) =>
        targets.every((target) => (target.labels ?? []).some((label) => lower(label.name) === lower(name)));
      return step(
        labels.map((label) =>
          onAll(label.name)
            ? command(
                `remove.${label.id}`,
                `Remove ${label.name}`,
                () => void apply(targets, { removeLabels: [label.name] }),
                {
                  keywords: [label.name],
                },
              )
            : command(
                `add.${label.id}`,
                `Add ${label.name}`,
                () => void apply(targets, { addLabels: [label] }),
                {
                  keywords: [label.name],
                },
              ),
        ),
      );
    }
    case 'dueDate':
      return step([
        ...quickPicks(today).map((pick) =>
          command(
            pick.id,
            `${pick.label} · ${formatDayWithWeekday(pick.date, today)}`,
            () => void apply(targets, { dueDate: pick.date }),
          ),
        ),
        command('clear', 'Clear due date', () => void apply(targets, { dueDate: null })),
      ]);
    case 'milestone': {
      const milestones = (await queryClient.ensureQueryData(milestonesQuery(api, projectKey))).items;
      return step([
        command('none', 'No milestone', () => void apply(targets, { milestone: null })),
        ...milestones
          .filter((milestone) => milestone.status !== 'completed')
          .map((milestone) =>
            command(
              milestone.id,
              milestone.name,
              () => void apply(targets, { milestone: toMilestoneRef(milestone) }),
            ),
          ),
      ]);
    }
    case 'cycle': {
      const cycles = (await queryClient.ensureQueryData(cyclesQuery(api, projectKey))).items;
      return step([
        command('none', 'No cycle', () => void apply(targets, { cycle: null })),
        ...cycles
          .filter((cycle) => cycle.state !== 'completed')
          .map((cycle) =>
            command(
              cycle.id,
              `${cycleLabel(cycle)} · ${cycle.state === 'current' ? `current, ${cycleNote(cycle)}` : cycleNote(cycle)}`,
              () => void apply(targets, { cycle: toCycleRef(cycle) }),
            ),
          ),
      ]);
    }
    case 'blockedBy': {
      if (!single) return step([]);
      const task = await queryClient.ensureQueryData(taskQuery(api, single.key));
      const current = new Set((task.blockedBy ?? []).flatMap((blocker) => (blocker ? [blocker.key] : [])));
      const page = await api.client.tasks.list({
        project: [projectKey],
        status: [...OPEN_TASK_STATUSES],
        limit: 100,
      });
      return step(
        page.items
          .filter((item) => item.key !== single.key && !current.has(item.key))
          .map((item) =>
            command(
              item.key,
              `${item.key} ${item.title}`,
              () => void apply([task], { addBlockers: [relatedOf(item)] }),
            ),
          ),
      );
    }
    case 'subtasks': {
      if (!single) return step([]);
      const page = await api.client.tasks.list({
        project: [projectKey],
        status: [...OPEN_TASK_STATUSES],
        topLevel: true,
        limit: 100,
      });
      return step(
        page.items
          .filter(
            (item) => item.key !== single.key && !item.parentKey && (item.subtaskProgress?.total ?? 0) === 0,
          )
          .map((item) =>
            command(
              item.key,
              `${item.key} ${item.title}`,
              () => void apply([item], { parent: relatedOf(single) }),
            ),
          ),
      );
    }
    case 'parent': {
      if (!single) return step([]);
      const task = await queryClient.ensureQueryData(taskQuery(api, single.key));
      if ((task.subtasks?.length ?? 0) > 0) {
        return step([
          command('depth', `${task.key} has subtasks`, () => undefined, {
            disabledReason: 'Subtasks go one level deep',
          }),
        ]);
      }
      const page = await api.client.tasks.list({
        project: [projectKey],
        status: [...OPEN_TASK_STATUSES],
        topLevel: true,
        limit: 100,
      });
      return step([
        ...(task.parent ? [command('none', 'No parent', () => void apply([task], { parent: null }))] : []),
        ...page.items
          .filter((item) => item.key !== task.key && !item.parentKey)
          .map((item) =>
            command(
              item.key,
              `${item.key} ${item.title}`,
              () => void apply([task], { parent: relatedOf(item) }),
              {
                checked: item.key === task.parent?.key,
              },
            ),
          ),
      ]);
    }
  }
}
