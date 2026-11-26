import { useQuery } from '@tanstack/react-query';
import {
  CYCLE_CURRENT,
  CYCLE_NEXT,
  type CycleState,
  DUE_FILTERS,
  type DueFilter,
  FILTER_NONE,
  type MilestoneStatus,
  PRIORITIES,
  type Priority,
  TASK_STATUSES,
  type TaskStatus,
  type UserKind,
} from '@zamu/contracts';
import { useMemo } from 'react';
import { labelsQuery } from '~/features/labels/queries';
import { membersQuery, meQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import {
  Avatar,
  CycleGlyph,
  isMilestoneFilled,
  LabelDot,
  MilestoneGlyph,
  NoneGlyph,
  type PickerMenuItem,
  PRIORITY_LABELS,
  PriorityGlyph,
  STATUS_LABELS,
  StatusGlyph,
  UnassignedAvatar,
} from '~/ui';
import { ASSIGNEE_NONE, type CycleFilterValue, type FilterField, type TaskFilter } from './filters';

// What the filter menu and the chips offer for each field: the options, how a field's value reads
// as option ids, and the words of its chip. Built from the project's members, labels, milestones and
// cycles (useProjectFilterFields), or from whatever Home passes (buildFilterFields).

export interface FilterFieldConfig {
  field: FilterField;
  /** Menu row and chip name: "Labels", "Due date". */
  label: string;
  /** Section header of the submenu: "Labels in Harbor". */
  title?: string;
  /** Plural for the chip summary: "3 labels". */
  plural: string;
  /** Several values (checkboxes) or one (a check; picking again clears it). */
  multiple: boolean;
  /** Search placeholder of the submenu. */
  placeholder: string;
  /** The key that opens this picker on a task, shown in the submenu's search field ("L"). */
  kbd?: string;
  options: readonly PickerMenuItem[];
}

export interface FilterMember {
  id: string;
  name: string;
  kind: UserKind;
  responsible?: { name: string } | null;
}

export interface FilterLabel {
  /** Label id in a project; on Home, the name (Home merges labels by name). */
  id: string;
  name: string;
  color: number;
  /** Tasks carrying it, shown at the right ("31"). */
  usageCount?: number;
}

export interface FilterMilestone {
  id: string;
  name: string;
  status: MilestoneStatus;
}

export interface FilterCycle {
  number: number;
  name: string | null;
  state: CycleState;
}

export interface BuildFilterFieldsInput {
  /** Fields to offer, in menu order. Default: every field with data (milestone and cycle need lists). */
  fields?: readonly FilterField[];
  /** "Harbor": the label section header reads "Labels in Harbor". */
  scopeName?: string;
  viewerName?: string;
  members?: readonly FilterMember[];
  labels?: readonly FilterLabel[];
  /** Omit (or pass undefined) when the project doesn't use milestones: the field is left out. */
  milestones?: readonly FilterMilestone[];
  cycles?: readonly FilterCycle[];
}

const STATUS_ITEMS: PickerMenuItem[] = TASK_STATUSES.map((status) => ({
  id: status,
  label: STATUS_LABELS[status],
  lead: <StatusGlyph status={status} decorative />,
}));

const PRIORITY_ITEMS: PickerMenuItem[] = [...PRIORITIES].reverse().map((priority) => ({
  id: priority,
  label: priority === 'none' ? 'No priority' : PRIORITY_LABELS[priority],
  lead: <PriorityGlyph priority={priority} />,
}));

export const DUE_LABELS: Record<DueFilter, string> = {
  overdue: 'Overdue',
  soon: 'Due soon',
  set: 'Has a due date',
  none: 'No due date',
};

const DUE_ITEMS: PickerMenuItem[] = (['overdue', 'soon', 'set', 'none'] as const).map((due) => ({
  id: due,
  label: DUE_LABELS[due],
  ...(due === 'soon' ? { sub: 'today or in 2 days' } : {}),
}));

const BLOCKED_ITEMS: PickerMenuItem[] = [
  { id: 'true', label: 'Blocked', sub: 'waits on an open task' },
  { id: 'false', label: 'Not blocked' },
];

/** Builds the field configs from plain data. useProjectFilterFields wraps it for a project. */
export function buildFilterFields(input: BuildFilterFieldsInput): FilterFieldConfig[] {
  const {
    fields = ['status', 'priority', 'assignee', 'label', 'due', 'blocked', 'milestone', 'cycle'],
    scopeName,
    members = [],
    labels = [],
    milestones,
    cycles,
  } = input;
  const people = members.filter((member) => member.kind !== 'agent');
  const agents = members.filter((member) => member.kind === 'agent');
  const byField: Partial<Record<FilterField, FilterFieldConfig>> = {
    status: {
      field: 'status',
      label: 'Status',
      plural: 'statuses',
      multiple: true,
      placeholder: 'Status…',
      kbd: 'S',
      options: STATUS_ITEMS,
    },
    priority: {
      field: 'priority',
      label: 'Priority',
      plural: 'priorities',
      multiple: true,
      placeholder: 'Priority…',
      kbd: 'P',
      options: PRIORITY_ITEMS,
    },
    assignee: {
      field: 'assignee',
      label: 'Assignee',
      plural: 'assignees',
      multiple: true,
      placeholder: 'Assignee…',
      kbd: 'A',
      options: [
        {
          id: 'me',
          label: 'Me',
          ...(input.viewerName
            ? { lead: <Avatar name={input.viewerName} decorative />, sub: input.viewerName }
            : {}),
        },
        { id: ASSIGNEE_NONE, label: 'No assignee', lead: <UnassignedAvatar /> },
        { id: 'agents', label: 'Any agent' },
        ...[...people, ...agents].map(
          (member): PickerMenuItem => ({
            id: member.id,
            label: member.name,
            lead: <Avatar name={member.name} kind={member.kind} decorative />,
            ...(member.kind === 'agent' && member.responsible
              ? { sub: `for ${firstName(member.responsible.name)}` }
              : {}),
          }),
        ),
      ],
    },
    label: {
      field: 'label',
      label: 'Labels',
      title: scopeName ? `Labels in ${scopeName}` : 'Labels',
      plural: 'labels',
      multiple: true,
      placeholder: 'Labels…',
      kbd: 'L',
      options: [...labels]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((label) => ({
          id: label.id,
          label: label.name,
          lead: <LabelDot color={label.color} />,
          ...(label.usageCount !== undefined ? { meta: label.usageCount } : {}),
        })),
    },
    due: {
      field: 'due',
      label: 'Due date',
      plural: 'due dates',
      multiple: false,
      placeholder: 'Due date…',
      kbd: '⇧D',
      options: DUE_ITEMS,
    },
    blocked: {
      field: 'blocked',
      label: 'Blocked',
      plural: 'values',
      multiple: false,
      placeholder: 'Blocked…',
      options: BLOCKED_ITEMS,
    },
  };
  if (milestones) {
    byField.milestone = {
      field: 'milestone',
      label: 'Milestone',
      plural: 'milestones',
      multiple: true,
      placeholder: 'Milestone…',
      kbd: '⇧M',
      options: [
        { id: FILTER_NONE, label: 'No milestone', lead: <NoneGlyph /> },
        ...milestones.map((milestone) => ({
          id: milestone.id,
          label: milestone.name,
          lead: <MilestoneGlyph filled={isMilestoneFilled(milestone.status)} />,
        })),
      ],
    };
  }
  if (cycles) {
    byField.cycle = {
      field: 'cycle',
      label: 'Cycle',
      plural: 'cycles',
      multiple: true,
      placeholder: 'Cycle…',
      kbd: '⇧C',
      options: [
        { id: CYCLE_CURRENT, label: 'Current cycle', lead: <CycleGlyph state="progress" /> },
        { id: CYCLE_NEXT, label: 'Next cycle', lead: <CycleGlyph /> },
        { id: FILTER_NONE, label: 'No cycle', lead: <NoneGlyph shape="circle" /> },
        ...[...cycles]
          .sort((a, b) => b.number - a.number)
          .map((cycle) => ({
            id: String(cycle.number),
            label: `Cycle ${cycle.number}`,
            ...(cycle.name ? { sub: cycle.name } : {}),
            lead: (
              <CycleGlyph
                state={
                  cycle.state === 'completed' ? 'done' : cycle.state === 'current' ? 'progress' : 'empty'
                }
              />
            ),
          })),
      ],
    };
  }
  return fields.flatMap((field) => {
    const config = byField[field];
    return config ? [config] : [];
  });
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** A field's value as option ids (the submenu's checked items). */
export function fieldValues(filter: TaskFilter, field: FilterField): string[] {
  switch (field) {
    case 'due':
      return filter.due ? [filter.due] : [];
    case 'blocked':
      return filter.blocked === undefined ? [] : [String(filter.blocked)];
    case 'cycle':
      return (filter.cycle ?? []).map(String);
    default:
      return [...(filter[field] ?? [])];
  }
}

/** The filter with a field set from option ids; an empty list clears the field. */
export function withFieldValues(filter: TaskFilter, field: FilterField, ids: readonly string[]): TaskFilter {
  const { [field]: _old, ...rest } = filter;
  if (ids.length === 0) return rest;
  switch (field) {
    case 'status':
      return { ...rest, status: TASK_STATUSES.filter((status) => ids.includes(status)) as TaskStatus[] };
    case 'priority':
      return { ...rest, priority: PRIORITIES.filter((priority) => ids.includes(priority)) as Priority[] };
    case 'due': {
      const due = ids[ids.length - 1];
      return due && (DUE_FILTERS as readonly string[]).includes(due)
        ? { ...rest, due: due as DueFilter }
        : rest;
    }
    case 'blocked':
      return { ...rest, blocked: ids[ids.length - 1] === 'true' };
    case 'cycle':
      return {
        ...rest,
        cycle: ids.map(
          (id): CycleFilterValue => (/^[0-9]+$/.test(id) ? Number(id) : (id as CycleFilterValue)),
        ),
      };
    default:
      return { ...rest, [field]: [...ids] };
  }
}

/** Chip words: { op: 'is' | 'is any of', value: 'backend' | '3 labels' }. */
export function chipText(config: FilterFieldConfig, ids: readonly string[]): { op: string; value: string } {
  if (ids.length === 1) {
    const id = ids[0] as string;
    if (config.field === 'blocked') return { op: 'is', value: id === 'true' ? 'yes' : 'no' };
    const option = config.options.find((item) => item.id === id);
    return { op: 'is', value: option?.label ?? unknownValue(config.field) };
  }
  return { op: 'is any of', value: `${ids.length} ${config.plural}` };
}

function unknownValue(field: FilterField): string {
  switch (field) {
    case 'label':
      return 'Unknown label';
    case 'milestone':
      return 'Unknown milestone';
    case 'assignee':
      return 'Unknown member';
    default:
      return 'Unknown';
  }
}

export interface UseProjectFilterFieldsOptions {
  /** Project name for "Labels in Harbor". */
  projectName?: string;
  /** Project feature switches: without them, Milestone and Cycle are left out. */
  usesMilestones?: boolean;
  usesCycles?: boolean;
  /** Limit or reorder the fields. */
  fields?: readonly FilterField[];
}

/** Filter fields of a project's list or board, from its members, labels, milestones and cycles. */
export function useProjectFilterFields(
  projectKey: string,
  { projectName, usesMilestones = true, usesCycles = true, fields }: UseProjectFilterFieldsOptions = {},
): FilterFieldConfig[] {
  const api = useApi();
  const me = useQuery(meQuery(api)).data?.user;
  const members = useQuery(membersQuery(api)).data?.items;
  const labels = useQuery(labelsQuery(api, projectKey)).data?.items;
  const milestones = useQuery({
    ...api.orpc.milestones.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesMilestones,
  }).data?.items;
  const cycles = useQuery({
    ...api.orpc.cycles.list.queryOptions({ input: { project: projectKey } }),
    enabled: usesCycles,
  }).data?.items;
  return useMemo(
    () =>
      buildFilterFields({
        ...(fields ? { fields } : {}),
        ...(projectName ? { scopeName: projectName } : {}),
        ...(me ? { viewerName: me.name } : {}),
        members: (members ?? []).filter((member) => member.id !== me?.id),
        labels: labels ?? [],
        ...(usesMilestones ? { milestones: milestones ?? [] } : {}),
        ...(usesCycles ? { cycles: cycles ?? [] } : {}),
      }),
    [fields, projectName, me, members, labels, milestones, cycles, usesMilestones, usesCycles],
  );
}
