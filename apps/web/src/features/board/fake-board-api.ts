import { ORPCError } from '@orpc/client';
import {
  type Member,
  type MilestoneRef,
  type ProjectWithCounts,
  type StatusCounts,
  TASK_CHANGED,
  TASK_STATUSES,
  type Task,
  type TaskListItem,
  type TaskListPage,
  type TaskStatus,
  type WorkItem,
  type WorkItemProgress,
} from '@zamu/contracts';

// In-memory /api/v1 client for the board's component tests: board order (rank) or a `sort`, one status
// per request (or all), topLevel and parent, cursor pagination, moves with position and the ifUpdatedAt
// check (TASK_CHANGED with the current task). Calls the board does not use answer with an empty list.

const ANA = { id: '00000000-0000-4000-8000-000000000001', name: 'Ana Ruiz', kind: 'person' as const };
const TOMAS = { id: '00000000-0000-4000-8000-000000000002', name: 'Tomás Berg', kind: 'person' as const };
const CLAUDE = { id: '00000000-0000-4000-8000-000000000003', name: 'claude-dev', kind: 'agent' as const };

export const BOARD_PEOPLE = { ANA, TOMAS, CLAUDE };

const WEBHOOKS: MilestoneRef = {
  id: '50000000-0000-4000-8000-000000000001',
  name: 'Webhooks v2',
  status: 'active',
  targetDate: '2026-11-14',
};

type Input = Record<string, unknown>;

export interface FakeBoardOptions {
  /** Cards per status; defaults to two in each open column and one Done. */
  layout?: Partial<Record<TaskStatus, number>>;
  usesMilestones?: boolean;
  usesCycles?: boolean;
  /** The project mirrors Backlog.md: status, assignee and milestone come from the files. */
  mirrored?: boolean;
  /** Subtasks added under a card: `count` of them, the first `done` of them Done, the rest Todo. */
  subtasks?: { parent: string; count: number; done?: number };
  /** M6: criteria counts per card key, sent with the list as the server does. */
  criteria?: Record<string, WorkItemProgress>;
  /** Due dates per card key. */
  dueDates?: Record<string, string>;
}

export function createFakeBoardApi({
  layout = { backlog: 1, todo: 2, in_progress: 2, in_review: 1, done: 1 },
  usesMilestones = true,
  usesCycles = true,
  mirrored = false,
  subtasks,
  criteria = {},
  dueDates = {},
}: FakeBoardOptions = {}) {
  const project = { id: '10000000-0000-4000-8000-000000000001', key: 'PAY', name: 'Payments' };
  const base = Date.parse('2026-10-20T10:00:00.000Z');
  const tasks: Task[] = [];
  let number = 0;
  for (const status of TASK_STATUSES) {
    for (let index = 0; index < (layout[status] ?? 0); index++) {
      number++;
      const assignee =
        number % 3 === 1
          ? { ...CLAUDE, responsible: ANA }
          : number % 3 === 2
            ? { ...TOMAS, responsible: null }
            : null;
      tasks.push({
        id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
        key: `PAY-${number}`,
        number,
        project,
        title: `Card ${number}`,
        description: null,
        status,
        priority: 'medium',
        assignee,
        createdBy: ANA,
        createdOnBehalfOf: null,
        milestone: number % 2 === 1 ? WEBHOOKS : null,
        cycle: null,
        cycleAddedAt: null,
        rank: index + 1,
        locked: mirrored
          ? ['title', 'description', 'status', 'priority', 'assignee', 'milestone', 'createdAt']
          : [],
        createdAt: new Date(base).toISOString(),
        updatedAt: new Date(base + number * 1000).toISOString(),
      });
    }
  }

  if (subtasks) {
    const parent = tasks.find((task) => task.key === subtasks.parent);
    const done = subtasks.done ?? 0;
    for (let index = 0; index < subtasks.count; index++) {
      number++;
      tasks.push({
        id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
        key: `PAY-${number}`,
        number,
        project,
        title: `Subtask ${index + 1}`,
        description: null,
        status: index < done ? 'done' : 'todo',
        priority: 'medium',
        assignee: null,
        createdBy: ANA,
        createdOnBehalfOf: null,
        milestone: null,
        cycle: null,
        cycleAddedAt: null,
        rank: 100 + index,
        locked: [],
        parent: parent
          ? { key: parent.key, title: parent.title, status: parent.status, assignee: null }
          : null,
        createdAt: new Date(base + index * 1000).toISOString(),
        updatedAt: new Date(base + number * 1000).toISOString(),
      });
    }
    if (parent) parent.subtaskProgress = { done, total: subtasks.count };
  }
  for (const task of tasks) {
    const dueDate = dueDates[task.key];
    if (dueDate) task.dueDate = dueDate;
    // The full task (tasks.get) lists the criteria the counts stand for: checked, waived, then open.
    const progress = criteria[task.key];
    if (progress) {
      const checked = progress.settled - progress.waived;
      task.criteria = Array.from(
        { length: progress.total },
        (_, index): WorkItem => ({
          number: index + 1,
          text: `Criterion ${index + 1} of ${task.key}`,
          state: index < checked ? 'checked' : index < progress.settled ? 'waived' : 'open',
          waivedReason: index >= checked && index < progress.settled ? 'Not needed' : null,
          waivedBy: index >= checked && index < progress.settled ? ANA : null,
          locked: false,
        }),
      );
      task.doneItems = [];
    }
  }

  const calls = { update: [] as Input[], list: [] as Input[] };
  const control = {
    /** Make the next update of this key fail with TASK_CHANGED after moving it elsewhere. */
    changedBehindYourBack: null as null | { key: string; status: TaskStatus },
  };

  const find = (key: unknown) => {
    const task = tasks.find((candidate) => candidate.key === String(key));
    if (!task) throw new ORPCError('NOT_FOUND', { message: 'Task not found' });
    return task;
  };
  const toItem = (task: Task): TaskListItem => {
    const {
      description: _d,
      createdBy: _c,
      createdOnBehalfOf: _o,
      parent,
      criteria: _criteria,
      doneItems: _doneItems,
      ...item
    } = task;
    const progress = criteria[task.key];
    return { ...item, parentKey: parent?.key ?? null, ...(progress ? { criteriaProgress: progress } : {}) };
  };
  const PRIORITY_ORDER = ['none', 'low', 'medium', 'high', 'urgent'];
  const bySort = (sort: string) => (a: Task, b: Task) => {
    const updated = b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
    if (sort === 'manual') return a.rank - b.rank || updated;
    if (sort === 'priority')
      return PRIORITY_ORDER.indexOf(b.priority) - PRIORITY_ORDER.indexOf(a.priority) || updated;
    return updated;
  };
  const boardOrder = (a: Task, b: Task) =>
    TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) ||
    a.rank - b.rank ||
    a.id.localeCompare(b.id);
  const asList = (value: unknown) => (value == null ? undefined : Array.isArray(value) ? value : [value]);
  let clock = base + 1_000_000;
  const touch = (task: Task) => {
    clock += 1000;
    task.updatedAt = new Date(clock).toISOString();
  };

  const members: Member[] = [ANA, TOMAS, CLAUDE].map((person) => ({
    ...person,
    email: person.kind === 'agent' ? null : `${person.name}@example.com`,
    role: 'member' as const,
    responsible: person.kind === 'agent' ? ANA : null,
    lastActiveAt: null,
    apiKeyCount: 0,
    joinedAt: new Date(base).toISOString(),
  }));

  const known = {
    projects: {
      list: async (): Promise<{ items: ProjectWithCounts[] }> => {
        const open = tasks.filter((task) =>
          ['backlog', 'todo', 'in_progress', 'in_review'].includes(task.status),
        );
        const count = (status: TaskStatus) => open.filter((task) => task.status === status).length;
        return {
          items: [
            {
              ...project,
              description: null,
              usesMilestones,
              usesCycles,
              currentCycle: null,
              repository: mirrored ? 'https://gitlab.com/reddevs/payments.git' : null,
              backlog: mirrored
                ? {
                    mode: 'mirror',
                    state: 'healthy',
                    defaultBranch: 'main',
                    lastReadAt: new Date(base).toISOString(),
                    lastReadCommit: 'a1b2c3d4e5f6',
                    lastTrigger: 'webhook',
                    problems: { files: 0, values: 0 },
                    hidden: 0,
                    detachedAt: null,
                  }
                : null,
              createdAt: new Date(base).toISOString(),
              updatedAt: new Date(base).toISOString(),
              openCounts: {
                backlog: count('backlog'),
                todo: count('todo'),
                in_progress: count('in_progress'),
                in_review: count('in_review'),
              },
              openCount: open.length,
              lastActivityAt: new Date(base).toISOString(),
              assignees: [],
            },
          ],
        };
      },
    },
    members: { list: async () => ({ items: members }) },
    me: {
      get: async () => ({
        user: { ...ANA, email: 'ana@example.com', responsible: null, theme: 'system' },
        role: 'owner',
      }),
    },
    tasks: {
      list: async (input: Input): Promise<TaskListPage> => {
        calls.list.push(input);
        const status = asList(input.status) as TaskStatus[] | undefined;
        const assignees = asList(input.assignee) as string[] | undefined;
        const cycles = asList(input.cycle) as (string | number)[] | undefined;
        const parentKey = input.parent as string | undefined;
        const matching = [...tasks]
          .sort(typeof input.sort === 'string' ? bySort(input.sort) : boardOrder)
          .filter((task) => (parentKey ? task.parent?.key === parentKey : true))
          .filter((task) => (input.topLevel === true ? !task.parent : true))
          .filter(
            (task) =>
              !assignees ||
              assignees.some((assignee) =>
                assignee === 'agents' ? task.assignee?.kind === 'agent' : task.assignee?.id === assignee,
              ),
          )
          .filter(
            (task) =>
              !cycles ||
              cycles.some((cycle) => (cycle === 'none' ? !task.cycle : task.cycle?.number === Number(cycle))),
          );
        const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as StatusCounts;
        for (const task of matching) counts[task.status]++;
        const filtered = matching.filter((task) => !status || status.includes(task.status));
        const limit = Number(input.limit ?? 50);
        const offset = Number(input.cursor ?? 0);
        const page = filtered.slice(offset, offset + limit);
        return {
          items: page.map(toItem),
          nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
          counts,
        };
      },
      get: async (input: Input): Promise<Task> => structuredClone(find(input.key)),
      update: async (input: Input): Promise<Task> => {
        calls.update.push(input);
        const task = find(input.key);
        const changed = control.changedBehindYourBack;
        if (changed && changed.key === task.key) {
          control.changedBehindYourBack = null;
          task.status = changed.status;
          touch(task);
        }
        if (
          typeof input.ifUpdatedAt === 'string' &&
          Date.parse(input.ifUpdatedAt) < Date.parse(task.updatedAt)
        ) {
          throw new ORPCError(TASK_CHANGED, {
            status: 409,
            message: `${task.key} changed since you loaded it`,
            data: { task: structuredClone(task) },
          });
        }
        if (typeof input.status === 'string') task.status = input.status as TaskStatus;
        if (typeof input.priority === 'string') task.priority = input.priority as Task['priority'];
        const column = tasks
          .filter((other) => other.status === task.status && other !== task)
          .sort(boardOrder);
        const position = input.position as { before?: string; after?: string } | undefined;
        if (position) {
          const anchorKey = position.before ?? position.after;
          const index = column.findIndex((other) => other.key === anchorKey);
          const anchor = column[index];
          if (anchor) {
            const neighbour = position.before ? column[index - 1] : column[index + 1];
            task.rank = neighbour
              ? (anchor.rank + neighbour.rank) / 2
              : position.before
                ? anchor.rank - 1
                : anchor.rank + 1;
          }
        } else if (typeof input.status === 'string') {
          task.rank = Math.min(1, ...column.map((other) => other.rank)) - 1;
        }
        if ('assignee' in input) {
          const person = [ANA, TOMAS, CLAUDE].find((candidate) => candidate.id === input.assignee);
          task.assignee = person ? { ...person, responsible: person.kind === 'agent' ? ANA : null } : null;
        }
        touch(task);
        return structuredClone(task);
      },
    },
  };

  /** Anything the board does not use (milestones, cycles, timeline, comments) answers an empty list. */
  const fallback = (path: string[]): unknown =>
    new Proxy(async () => ({ items: [] }), {
      get: (_target, key) => (typeof key === 'string' ? fallback([...path, key]) : undefined),
    });
  const client = new Proxy(known, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      const value = (target as Record<string, unknown>)[key];
      if (!value) return fallback([key]);
      return new Proxy(value as Record<string, unknown>, {
        get: (group, method) =>
          typeof method === 'string' ? (group[method] ?? fallback([key, method])) : undefined,
      });
    },
  });

  return { client, calls, control, tasks };
}

export type FakeBoardApi = ReturnType<typeof createFakeBoardApi>;
