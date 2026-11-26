// Dashboard: the action queue (In review, Mentions, Stalled, Deadlines), one row per project and
// the agents strip, across every project the actor can read. Rules: section 5 "Dashboard rules" of
// the M4 plan. M7: archived tasks are left out of every group and count, but milestone and cycle
// progress keep counting them.
//
// Query budget: readableProjects, then one query per queue group, one for the project rows and one
// for the agents, in parallel. Each group query returns its first QUEUE_ITEM_LIMIT items with the
// uncapped total (count(*) over (), evaluated before LIMIT). getDashboardCounts runs the same group
// predicates as count(*) only. "Now" and "today" come from the injected clock, never from the
// database, so tests can move time.
import {
  DASHBOARD_GROUP_ITEM_LIMIT,
  Dashboard,
  type DashboardAgent,
  DashboardCounts,
  type DashboardProject,
  type DashboardScope,
  type DeadlineItem,
  formatTaskKey,
  GetDashboardInput,
  type MentionItem,
  OPEN_TASK_STATUSES,
  priorityFromValue,
  type ReviewItem,
  type StalledItem,
  type TaskStatus,
  type UserRef,
} from '@zamu/contracts';
import type { Db } from '@zamu/db';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import { addCalendarDays, type ClockContext, calendarDaysBetween, clockNow, todayIn } from './cycles';
import { parseInput } from './errors';
import { readableProjects, toDate } from './internal';
import { splitFences, splitInline } from './mentions';

/** An in-progress task held by an agent is stalled after this long without an update or comment. */
export const STALLED_AGENT_HOURS = 24;
/** The same for people and unassigned tasks. */
export const STALLED_PERSON_DAYS = 5;
/** A current cycle is a deadline when it ends today or within this many days after today. */
export const DEADLINE_CYCLE_DAYS = 2;
/** Most items a queue group returns; the total still counts every item. */
export const QUEUE_ITEM_LIMIT = DASHBOARD_GROUP_ITEM_LIMIT;
/** Longest mention excerpt before the ellipsis. */
export const MENTION_EXCERPT_LENGTH = 200;

const HOUR_MS = 3_600_000;
const STALLED_PERSON_HOURS = STALLED_PERSON_DAYS * 24;

type DashboardContext = DbContext & ClockContext;

// ---------------------------------------------------------------------------
// Mention excerpt
// ---------------------------------------------------------------------------

/** Block markers at the start of a line: headings, blockquotes, list items, task-list boxes. */
const BLOCK_MARKERS =
  /^[ \t]*(?:(?:#{1,6}(?=[ \t]|$)|>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])|\[[ xX]\](?=[ \t]))[ \t]*)+/gm;
/** A line that is only a thematic break (---, ***, ___) or a setext underline (===). */
const THEMATIC_BREAK = /^[ \t]*(?:(?:[-*_=][ \t]*){3,})$/gm;
/** Emphasis and strikethrough markers that are not escaped. */
const STRONG = /(?<!\\)(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g;
const EMPHASIS = /(?<![\\\w*])([*_])(?=\S)([\s\S]*?\S)\1(?![\w*])/g;
/** Backslash escapes of ASCII punctuation. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** [text](destination) and ![alt](src); the text is kept. */
const LINK_TEXT = /^!?\[((?:[^[\]\\]|\\.)*)\]/s;

/** Prose without block syntax. Runs on whole blocks, where every `^` is a line start. */
function withoutBlockMarkers(prose: string): string {
  return prose.replace(THEMATIC_BREAK, ' ').replace(BLOCK_MARKERS, '');
}

/** Inline text without emphasis markers and escapes. */
function plainProse(text: string): string {
  return text.replace(STRONG, '$2').replace(EMPHASIS, '$2').replace(ESCAPE, '$1');
}

/** Cuts `text` to `max` characters on a word boundary and adds an ellipsis when it was longer. */
function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  // One word longer than the limit: cut inside it, without splitting a surrogate pair.
  if (space > 0) cut = cut.slice(0, space);
  else {
    cut = cut.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * Plain text of a comment body for a mention row: mention links become @Name, other links keep
 * their text, inline code keeps its backticks, fenced code blocks become [code], and block
 * elements collapse to single spaces. Cut at MENTION_EXCERPT_LENGTH characters on a word boundary
 * with an ellipsis.
 */
export function mentionExcerpt(body: string, max = MENTION_EXCERPT_LENGTH): string {
  const parts: string[] = [];
  for (const block of splitFences(body)) {
    if (block.type === 'code') {
      parts.push(' [code] ');
      continue;
    }
    for (const segment of splitInline(withoutBlockMarkers(block.raw))) {
      switch (segment.type) {
        case 'code':
          parts.push(segment.raw.replace(/\s+/g, ' '));
          break;
        case 'mention': {
          const name = segment.label.replace(ESCAPE, '$1').trim();
          parts.push(name.startsWith('@') ? name : `@${name}`);
          break;
        }
        case 'link': {
          const text = LINK_TEXT.exec(segment.raw);
          // Autolinks (<https://...>) show their address.
          parts.push(text ? plainProse(text[1] ?? '') : segment.raw.slice(1, -1));
          break;
        }
        case 'text':
          parts.push(plainProse(segment.raw));
          break;
      }
    }
  }
  return truncateWords(parts.join('').replace(/\s+/g, ' ').trim(), max);
}

// ---------------------------------------------------------------------------
// SQL building blocks
// ---------------------------------------------------------------------------

const OPEN_STATUSES_SQL = sql.raw(OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(', '));
const IN_REVIEW_CHANGE = JSON.stringify([{ field: 'status', to: 'in_review' }]);

interface Params {
  projectIds: string[];
  me: string;
  workspaceId: string;
  scope: DashboardScope;
  today: string;
  now: Date;
}

const projectIn = (column: string, params: Params) =>
  sql`${sql.raw(column)} = any(${sql.param(params.projectIds)}::uuid[])`;

/** Tasks assigned to me or to the agents I am responsible for (user.responsible_user_id index). */
const assignedToMine = (column: string, me: string) => sql`${sql.raw(column)} in (
  select ${me}::uuid
  union all
  select mine.id from "user" mine where mine.responsible_user_id = ${me}::uuid and mine.kind = 'agent')`;

const mineOnly = (params: Params, condition: SQL) =>
  params.scope === 'mine' ? sql`and ${condition}` : sql``;

/** id, name and kind of a user under a column prefix, e.g. assignee → "assigneeId". */
const userColumns = (alias: string, prefix: string) =>
  sql.raw(`${alias}.id as "${prefix}Id", ${alias}.name as "${prefix}Name", ${alias}.kind as "${prefix}Kind"`);

/** Columns of a task in a dashboard row: t is the task, p its project. */
const TASK_COLUMNS = sql.raw(
  `t.id as "taskId", t.number as "taskNumber", t.title as "taskTitle", t.status as "taskStatus", ` +
    `t.priority as "taskPriority", p.key as "projectKey", p.name as "projectName"`,
);

/** The later of the task's updated_at and its newest comment (comment(task_id, created_at) index). */
const LAST_TOUCH = sql.raw(
  `greatest(t.updated_at, (select max(lc.created_at) from comment lc where lc.task_id = t.id))`,
);

/** Rows of a group, unordered and uncapped. Items and counts select from it. */
interface GroupSource {
  base: SQL;
  /** ORDER BY of the items, on the base's output columns (b.). */
  order: SQL;
}

function reviewSource(params: Params): GroupSource {
  return {
    base: sql`
      select ${TASK_COLUMNS}, ${userColumns('ua', 'assignee')}, ${userColumns('ur', 'responsible')},
        coalesce(
          (select max(a.created_at) from activity a
            where a.task_id = t.id and a.changes @> ${IN_REVIEW_CHANGE}::jsonb),
          t.updated_at) as since
      from task t
      join project p on p.id = t.project_id
      left join "user" ua on ua.id = t.assignee_id
      left join "user" ur on ur.id = ua.responsible_user_id
      where ${projectIn('t.project_id', params)} and t.status = 'in_review' and t.archived_at is null
        ${mineOnly(params, assignedToMine('t.assignee_id', params.me))}`,
    order: sql`b."taskPriority" desc, b.since asc, b."taskId" asc`,
  };
}

function mentionsSource(params: Params): GroupSource {
  const member =
    params.scope === 'everyone'
      ? sql`join member mb on mb.user_id = cm.user_id and mb.organization_id = ${params.workspaceId}::uuid`
      : sql``;
  return {
    base: sql`
      select distinct on (c.task_id, cm.user_id)
        ${TASK_COLUMNS},
        c.id as "commentId", c.body as "commentBody", c.created_at as "commentCreatedAt",
        ${userColumns('au', 'author')}, ${userColumns('ob', 'onBehalfOf')},
        ${userColumns('mu', 'mentioned')}, ${userColumns('mr', 'mentionedResponsible')}
      from comment_mention cm
      ${member}
      join comment c on c.id = cm.comment_id
      join task t on t.id = c.task_id
      join project p on p.id = t.project_id
      join "user" au on au.id = c.author_id
      left join "user" ob on ob.id = c.on_behalf_of_id
      join "user" mu on mu.id = cm.user_id
      left join "user" mr on mr.id = mu.responsible_user_id
      where ${projectIn('c.project_id', params)}
        ${mineOnly(params, sql`cm.user_id = ${params.me}::uuid`)}
        and c.deleted_at is null
        and c.author_id <> cm.user_id
        and t.status in (${OPEN_STATUSES_SQL}) and t.archived_at is null
        and not exists (
          select 1 from comment reply
          where reply.task_id = c.task_id and reply.created_at > c.created_at
            and reply.author_id = cm.user_id and reply.deleted_at is null)
        and not exists (
          select 1 from activity touch
          where touch.task_id = c.task_id and touch.created_at > c.created_at
            and touch.actor_id = cm.user_id)
      order by c.task_id, cm.user_id, c.created_at desc, c.id desc`,
    order: sql`b."commentCreatedAt" desc, b."commentId" desc`,
  };
}

function stalledSource(params: Params): GroupSource {
  const agentCutoff = new Date(params.now.getTime() - STALLED_AGENT_HOURS * HOUR_MS).toISOString();
  const personCutoff = new Date(params.now.getTime() - STALLED_PERSON_HOURS * HOUR_MS).toISOString();
  return {
    base: sql`
      select ${TASK_COLUMNS}, ${userColumns('ua', 'assignee')}, ${userColumns('ur', 'responsible')},
        touched.at as "lastTouchedAt"
      from task t
      join project p on p.id = t.project_id
      left join "user" ua on ua.id = t.assignee_id
      left join "user" ur on ur.id = ua.responsible_user_id
      cross join lateral (select ${LAST_TOUCH} as at) touched
      where ${projectIn('t.project_id', params)} and t.status = 'in_progress' and t.archived_at is null
        ${mineOnly(params, assignedToMine('t.assignee_id', params.me))}
        and touched.at < case when ua.kind = 'agent'
          then ${agentCutoff}::timestamptz else ${personCutoff}::timestamptz end`,
    order: sql`b."lastTouchedAt" asc, b."taskId" asc`,
  };
}

function deadlinesSource(params: Params): GroupSource {
  // Archived tasks still count in progress (done, total) but are not open work.
  const open = sql`t.status in (${OPEN_STATUSES_SQL}) and t.archived_at is null`;
  const mine =
    params.scope === 'mine'
      ? sql`and count(*) filter (where ${open} and ${assignedToMine('t.assignee_id', params.me)}) > 0`
      : sql``;
  const today = params.today;
  const lastCycleDay = addCalendarDays(today, DEADLINE_CYCLE_DAYS);
  return {
    base: sql`
      select 'milestone' as kind, 0 as "kindRank", m.id as "id", m.name as "name",
        m.target_date as "dueOn", null::integer as "cycleNumber", null::date as "startsOn",
        p.key as "projectKey", p.name as "projectName",
        count(*) filter (where ${open}) as "openTasks",
        count(*) filter (where t.status = 'done') as done,
        count(*) filter (where t.status <> 'canceled') as total
      from milestone m
      join project p on p.id = m.project_id
      join task t on t.milestone_id = m.id
      where ${projectIn('m.project_id', params)} and p.uses_milestones
        and m.status <> 'completed' and m.target_date < ${today}::date
      group by m.id, p.id
      having count(*) filter (where ${open}) > 0 ${mine}
      union all
      select 'cycle', 1, c.id, c.name, c.ends_on, c.number, c.starts_on,
        p.key, p.name,
        count(*) filter (where ${open}),
        count(*) filter (where t.status = 'done'),
        count(*)
      from cycle c
      join project p on p.id = c.project_id
      join task t on t.cycle_id = c.id
      where ${projectIn('c.project_id', params)} and p.uses_cycles
        and c.completed_at is null and c.starts_on <= ${today}::date
        and c.ends_on >= ${today}::date and c.ends_on <= ${lastCycleDay}::date
      group by c.id, p.id
      having count(*) filter (where ${open}) > 0 ${mine}`,
    order: sql`b."kindRank" asc, b."dueOn" asc, b."projectKey" asc, b.name asc`,
  };
}

type Row = Record<string, unknown>;

async function groupItems(db: Db, source: GroupSource): Promise<{ total: number; rows: Row[] }> {
  const rows = await db.execute<Row>(
    sql`select b.*, count(*) over () as "groupTotal" from (${source.base}) b
      order by ${source.order} limit ${QUEUE_ITEM_LIMIT}`,
    'objects',
  );
  return { total: Number(rows[0]?.groupTotal ?? 0), rows };
}

async function groupCount(db: Db, source: GroupSource): Promise<number> {
  const [row] = await db.execute<{ n: string | number }>(
    sql`select count(*) as n from (${source.base}) b`,
    'objects',
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Mapping rows
// ---------------------------------------------------------------------------

function timestamp(value: unknown): Date {
  return toDate(value as Date | string);
}

/** A Postgres date as YYYY-MM-DD. The driver returns dates as text. */
function calendarDate(value: unknown): string {
  return String(value).slice(0, 10);
}

function userAt(row: Row, prefix: string): UserRef | null {
  const id = row[`${prefix}Id`];
  if (id === null || id === undefined) return null;
  return {
    id: String(id),
    name: String(row[`${prefix}Name`]),
    kind: row[`${prefix}Kind`] as UserRef['kind'],
  };
}

function requireUserAt(row: Row, prefix: string): UserRef {
  const user = userAt(row, prefix);
  if (!user) throw new Error(`dashboard row without ${prefix}`);
  return user;
}

/** A user with their responsible human (agents), as AssigneeRef. */
function assigneeAt(row: Row, prefix: string, responsiblePrefix: string) {
  const user = userAt(row, prefix);
  return user ? { ...user, responsible: userAt(row, responsiblePrefix) } : null;
}

function taskAt(row: Row) {
  const projectKey = String(row.projectKey);
  return {
    key: formatTaskKey(projectKey, Number(row.taskNumber)),
    title: String(row.taskTitle),
    status: row.taskStatus as TaskStatus,
    priority: priorityFromValue(Number(row.taskPriority)),
    project: { key: projectKey, name: String(row.projectName) },
  };
}

function toReviewItem(row: Row): z.input<typeof ReviewItem> {
  return {
    task: taskAt(row),
    assignee: assigneeAt(row, 'assignee', 'responsible'),
    since: timestamp(row.since),
  };
}

function toMentionItem(row: Row): z.input<typeof MentionItem> {
  const mentioned = assigneeAt(row, 'mentioned', 'mentionedResponsible');
  if (!mentioned) throw new Error('mention row without the mentioned user');
  return {
    task: taskAt(row),
    comment: {
      id: String(row.commentId),
      excerpt: mentionExcerpt(String(row.commentBody ?? '')),
      createdAt: timestamp(row.commentCreatedAt),
    },
    author: requireUserAt(row, 'author'),
    onBehalfOf: userAt(row, 'onBehalfOf'),
    mentioned,
  };
}

function toStalledItem(row: Row): z.input<typeof StalledItem> {
  const assignee = assigneeAt(row, 'assignee', 'responsible');
  return {
    task: taskAt(row),
    assignee,
    lastTouchedAt: timestamp(row.lastTouchedAt),
    thresholdHours: assignee?.kind === 'agent' ? STALLED_AGENT_HOURS : STALLED_PERSON_HOURS,
  };
}

function toDeadlineItem(row: Row, today: string): DeadlineItem {
  const project = { key: String(row.projectKey), name: String(row.projectName) };
  const progress = { done: Number(row.done), total: Number(row.total) };
  const openTasks = Number(row.openTasks);
  const dueOn = calendarDate(row.dueOn);
  if (row.kind === 'milestone') {
    return {
      kind: 'milestone',
      project,
      milestone: { id: String(row.id), name: String(row.name), targetDate: dueOn },
      daysOverdue: calendarDaysBetween(dueOn, today),
      openTasks,
      progress,
    };
  }
  return {
    kind: 'cycle',
    project,
    cycle: {
      number: Number(row.cycleNumber),
      name: row.name === null ? null : String(row.name),
      startsOn: calendarDate(row.startsOn),
      endsOn: dueOn,
    },
    daysLeft: calendarDaysBetween(today, dueOn) + 1,
    openTasks,
    progress,
  };
}

// ---------------------------------------------------------------------------
// Project rows and agents
// ---------------------------------------------------------------------------

/**
 * Every project in scope with the listProjects counts and last activity, the current cycle with
 * done/total, and the next milestone that is not Completed (earliest target date, undated last)
 * with progress and the number of other open milestones. One query, most recently active first.
 */
async function projectRows(db: Db, params: Params): Promise<z.input<typeof DashboardProject>[]> {
  const status = (value: string) =>
    sql.raw(`count(*) filter (where pt.status = '${value}' and pt.archived_at is null)`);
  const rows = await db.execute<Row>(
    sql`
      select p.key, p.name, p.uses_milestones as "usesMilestones", p.uses_cycles as "usesCycles",
        counts.backlog, counts.todo, counts.in_progress, counts.in_review,
        greatest(p.updated_at, counts.last_task_update) as "lastActivityAt",
        cc.number as "cycleNumber", cc.name as "cycleName", cc.ends_on as "cycleEndsOn",
        cc.done as "cycleDone", cc.total as "cycleTotal",
        nm.id as "milestoneId", nm.name as "milestoneName", nm.target_date as "milestoneTargetDate",
        nm.others as "milestoneOthers", nmp.done as "milestoneDone", nmp.total as "milestoneTotal"
      from project p
      cross join lateral (
        select ${status('backlog')} as backlog, ${status('todo')} as todo,
          ${status('in_progress')} as in_progress, ${status('in_review')} as in_review,
          max(pt.updated_at) as last_task_update
        from task pt where pt.project_id = p.id) counts
      left join lateral (
        select c.number, c.name, c.ends_on,
          count(ct.id) filter (where ct.status = 'done') as done, count(ct.id) as total
        from cycle c left join task ct on ct.cycle_id = c.id
        where c.project_id = p.id and p.uses_cycles and c.completed_at is null
          and c.starts_on <= ${params.today}::date and c.ends_on >= ${params.today}::date
        group by c.id
        order by c.starts_on
        limit 1) cc on true
      left join lateral (
        select m.id, m.name, m.target_date, count(*) over () - 1 as others
        from milestone m
        where m.project_id = p.id and p.uses_milestones and m.status <> 'completed'
        order by m.target_date asc nulls last, lower(m.name), m.id
        limit 1) nm on true
      left join lateral (
        select count(*) filter (where mt.status = 'done') as done,
          count(*) filter (where mt.status <> 'canceled') as total
        from task mt where mt.milestone_id = nm.id) nmp on true
      where ${projectIn('p.id', params)}
      order by "lastActivityAt" desc, p.key asc`,
    'objects',
  );
  return rows.map((row) => {
    const openCounts = {
      backlog: Number(row.backlog),
      todo: Number(row.todo),
      in_progress: Number(row.in_progress),
      in_review: Number(row.in_review),
    };
    const cycleEndsOn = row.cycleEndsOn === null ? null : calendarDate(row.cycleEndsOn);
    const targetDate = row.milestoneTargetDate === null ? null : calendarDate(row.milestoneTargetDate);
    return {
      key: String(row.key),
      name: String(row.name),
      openCounts,
      openCount: Object.values(openCounts).reduce((sum, n) => sum + n, 0),
      usesMilestones: Boolean(row.usesMilestones),
      usesCycles: Boolean(row.usesCycles),
      lastActivityAt: timestamp(row.lastActivityAt),
      currentCycle:
        cycleEndsOn === null
          ? null
          : {
              number: Number(row.cycleNumber),
              name: row.cycleName === null ? null : String(row.cycleName),
              endsOn: cycleEndsOn,
              daysLeft: calendarDaysBetween(params.today, cycleEndsOn) + 1,
              done: Number(row.cycleDone),
              total: Number(row.cycleTotal),
            },
      nextMilestone:
        row.milestoneId === null
          ? null
          : {
              id: String(row.milestoneId),
              name: String(row.milestoneName),
              targetDate,
              overdue: targetDate !== null && targetDate < params.today,
              done: Number(row.milestoneDone),
              total: Number(row.milestoneTotal),
              others: Number(row.milestoneOthers),
            },
    };
  });
}

/**
 * Agents of the workspace (Mine: the ones I am responsible for) with their in-progress task that
 * was touched longest ago, how many they hold, whether that task is stalled, and their newest
 * activity row or comment in projects in scope. Stalled first, then by name. One query.
 */
async function agentRows(db: Db, params: Params): Promise<z.input<typeof DashboardAgent>[]> {
  const agentCutoff = new Date(params.now.getTime() - STALLED_AGENT_HOURS * HOUR_MS).toISOString();
  const rows = await db.execute<Row>(
    sql`
      with agent as (
        select u.id, u.name, u.kind, u.responsible_user_id
        from member mb
        join "user" u on u.id = mb.user_id and u.kind = 'agent'
        where mb.organization_id = ${params.workspaceId}::uuid
          ${mineOnly(params, sql`u.responsible_user_id = ${params.me}::uuid`)})
      select ${userColumns('u', 'agent')}, ${userColumns('r', 'responsible')},
        cur."taskId", cur."taskNumber", cur."taskTitle", cur."taskStatus", cur."taskPriority",
        cur."projectKey", cur."projectName", cur.last_touch as "lastTouchedAt",
        coalesce(cur.held, 0) as "inProgressCount",
        coalesce(cur.last_touch < ${agentCutoff}::timestamptz, false) as stalled,
        greatest(acted.at, wrote.at) as "lastActivityAt"
      from agent u
      left join "user" r on r.id = u.responsible_user_id
      left join lateral (
        select ${TASK_COLUMNS}, touched.at as last_touch, count(*) over () as held
        from task t
        join project p on p.id = t.project_id
        cross join lateral (select ${LAST_TOUCH} as at) touched
        where t.assignee_id = u.id and t.status = 'in_progress' and t.archived_at is null
          and ${projectIn('t.project_id', params)}
        order by touched.at asc, t.id asc
        limit 1) cur on true
      -- Newest activity row and comment per agent in the scoped projects. Each walks
      -- activity(actor_id, created_at) or comment(author_id, created_at) backwards and stops at the
      -- first row in scope, in both scopes. Comments are scoped through their task, as the schema
      -- does not tie comment.project_id to the task's project.
      left join lateral (
        select a.created_at as at from activity a
        where a.actor_id = u.id and ${projectIn('a.project_id', params)}
        order by a.created_at desc
        limit 1) acted on true
      left join lateral (
        select c.created_at as at
        from comment c join task wt on wt.id = c.task_id
        where c.author_id = u.id and ${projectIn('wt.project_id', params)}
        order by c.created_at desc
        limit 1) wrote on true
      order by stalled desc, u.name asc, u.id asc`,
    'objects',
  );
  return rows.map((row) => ({
    agent: { ...requireUserAt(row, 'agent'), responsible: userAt(row, 'responsible') },
    currentTask: row.taskId === null ? null : taskAt(row),
    inProgressCount: Number(row.inProgressCount),
    stalled: Boolean(row.stalled),
    lastActivityAt: row.lastActivityAt === null ? null : timestamp(row.lastActivityAt),
  }));
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function paramsFor(ctx: DashboardContext, actor: Actor, scope: DashboardScope): Promise<Params> {
  authorize(actor, 'workspace.read');
  const projects = await readableProjects(ctx.db, actor);
  return {
    projectIds: projects.map((row) => row.id),
    me: actor.userId,
    workspaceId: actor.workspaceId,
    scope,
    today: todayIn(ctx),
    now: clockNow(ctx),
  };
}

/**
 * The dashboard for `scope` (default mine): the four queue groups with uncapped totals and up to
 * QUEUE_ITEM_LIMIT items each, every project row in scope, and the agents strip. Reads only the
 * projects the actor can read (API key scopes apply); read-only keys may call it.
 */
export async function getDashboard(
  ctx: DashboardContext,
  actor: Actor,
  input?: z.input<typeof GetDashboardInput>,
): Promise<Dashboard> {
  const { scope } = parseInput(GetDashboardInput, input);
  const params = await paramsFor(ctx, actor, scope);
  const { db } = ctx;
  const [review, mentions, stalled, deadlines, projects, agents] = await Promise.all([
    groupItems(db, reviewSource(params)),
    groupItems(db, mentionsSource(params)),
    groupItems(db, stalledSource(params)),
    groupItems(db, deadlinesSource(params)),
    projectRows(db, params),
    agentRows(db, params),
  ]);
  return Dashboard.parse({
    scope,
    generatedAt: params.now,
    groups: {
      review: { total: review.total, items: review.rows.map(toReviewItem) },
      mentions: { total: mentions.total, items: mentions.rows.map(toMentionItem) },
      stalled: { total: stalled.total, items: stalled.rows.map(toStalledItem) },
      deadlines: {
        total: deadlines.total,
        items: deadlines.rows.map((row) => toDeadlineItem(row, params.today)),
      },
    },
    projects,
    agents,
  });
}

/** The Mine queue totals and their sum, without items, project rows or agents. For the rail. */
export async function getDashboardCounts(ctx: DashboardContext, actor: Actor): Promise<DashboardCounts> {
  const params = await paramsFor(ctx, actor, 'mine');
  const { db } = ctx;
  const [review, mentions, stalled, deadlines] = await Promise.all([
    groupCount(db, reviewSource(params)),
    groupCount(db, mentionsSource(params)),
    groupCount(db, stalledSource(params)),
    groupCount(db, deadlinesSource(params)),
  ]);
  return DashboardCounts.parse({
    review,
    mentions,
    stalled,
    deadlines,
    total: review + mentions + stalled + deadlines,
  });
}
