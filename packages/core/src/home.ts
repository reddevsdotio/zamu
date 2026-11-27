// Home (M5): what needs attention, grouped by why, across every project the actor can read. It
// replaces the dashboard and My tasks. Rules: the Home contract in @zamu/contracts (entities.ts) and
// the "M5-05 Home data" brief of the M5 plan.
//
// Grouping. A tab's groups are HOME_GROUPS_BY_TAB[tab]; one SQL CASE puts each candidate task in
// the first group it qualifies for, so a task shows once. Only open tasks that are not hidden and
// not archived (M7), in readable projects and matching the filters, are candidates; M7 adds one
// branch of Done tasks for mergedOpen.
//   Mine: review (In review and waiting on me: I am the responsible human of its agent assignee,
//     else its creator), mergedOpen (M7: a merge moved it to Done while a criterion or done item is
//     open, and it waits on me by the review rule), checkAgain (M7: its check-again day is today
//     or past), mentions (an unanswered comment mentions me), then, for my tasks only (assigned to
//     me, or created by me and unassigned; checkAgain too), blocked, overdue and assigned. My
//     agents' other work shows on the Agents tab, not in Mine (frame 099).
//   Everyone: review (every task In review), mergedOpen (every such task), blocked, overdue,
//     dueThisWeek (today to Sunday).
//   Agents: waiting: In review tasks an agent holds, and unanswered agent comments that mention a
//     person of the workspace.
// Blocked means at least one blocker that is open and not hidden. Overdue means due before today.
// "Unanswered" means no later comment or activity row by the mentioned person (the dashboard rule).
// "Today" is the calendar day of the injected clock in APP_TIME_ZONE (cycles.ts todayIn).
//
// Query budget per getHome: readableProjects (plus one label lookup with the label filter), one
// ranked query for the tab's groups (each group's uncapped total and first HOME_GROUP_ITEM_LIMIT
// items), a fixed set of batch lookups for the rows (users, milestones, cycles, labels, blockers,
// blocks, subtask progress, criteria and done-item counts, mirrors, M7 the linked requests, M8 the
// waves of the rows' milestones with their locks, none when no row is in a wave), one
// count query per other tab, the deadlines query and, on Agents, the cards, today's counts and
// recent actions. No query runs per row.
//
// Plans: candidates come from index-backed branches (task assignee, project and status, project
// and due date, comment_mention user, task_dependency), stay narrow while they are ranked, and the
// full rows are read for the returned items only. Measured with scripts/dashboard-stress.ts
// --suite home.
import {
  type CycleState,
  DUE_SOON_DAYS,
  formatTaskKey,
  GetHomeInput,
  HOME_AGENT_ACTION_LIMIT,
  HOME_GROUP_ITEM_LIMIT,
  HOME_GROUP_KEYS,
  HOME_GROUPS_BY_TAB,
  Home,
  type HomeAgent,
  type HomeAgentAction,
  HomeCounts,
  type HomeDeadline,
  type HomeGroupKey,
  type HomeItem,
  type HomePill,
  type HomeReason,
  type HomeRelation,
  type HomeTab,
  type HomeTaskRef,
  OPEN_TASK_STATUSES,
  type PullRequestRef,
  priorityFromValue,
  priorityToValue,
  type RelatedTask,
  TASK_OWNED_FIELDS,
  type TaskListItem,
  type TaskStatus,
  type UserRef,
} from '@zamu/contracts';
import type { Db } from '@zamu/db';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type ActivityRow, toActivities } from './activity';
import { type Actor, authorize } from './authz';
import type { DbContext } from './context';
import { progressFor, workItemProgressOf } from './criteria';
import {
  addCalendarDays,
  type ClockContext,
  calendarDaysBetween,
  clockNow,
  cycleStateOn,
  DEFAULT_TIME_ZONE,
  nextMonday,
  todayIn,
} from './cycles';
import { mentionExcerpt } from './dashboard';
import { parseInput } from './errors';
import { loadUsers, mirroredProjectIds, readableProjects, toDate, type UserRow, userRef } from './internal';
import { mentionedUserIds } from './mentions';
import { type RequestSummary, requestSummariesOf } from './tasks';
import { taskWaveOf, type WaveState, waveStates } from './waves';

type HomeContext = DbContext & ClockContext;

/** An agent is working while it holds an In progress task touched within this window. */
const WORKING_WINDOW_MS = 3_600_000;
/** Most entries of the deadlines strip. */
const DEADLINE_LIMIT = HOME_GROUP_ITEM_LIMIT;

const OPEN_STATUSES_SQL = sql.raw(OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(', '));
const IN_REVIEW_CHANGE = JSON.stringify([{ field: 'status', to: 'in_review' }]);
const IN_PROGRESS_CHANGE = JSON.stringify([{ field: 'status', to: 'in_progress' }]);

/** Groups that count towards the Mine tab and the sidebar. */
const MINE_COUNTED = ['review', 'mergedOpen', 'checkAgain', 'mentions', 'blocked', 'overdue'] as const;

interface Params {
  projectIds: string[];
  me: string;
  workspaceId: string;
  today: string;
  timeZone: string;
  now: Date;
  /** Ids of the labels named by the label filter (any project), or null for no label filter. */
  labelIds: string[] | null;
  /** Priority values 0 to 4, or null for no priority filter. */
  priorities: number[] | null;
}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// SQL building blocks
// ---------------------------------------------------------------------------

const uuids = (values: string[]) => sql`${sql.param(values)}::uuid[]`;

/**
 * A task under `alias` that Home may show: in a readable project, not hidden, open, and matching
 * the priority and label filters (label ids resolved beforehand).
 *
 * `labels` picks the form of the label filter. join (default), for the top level of a scan: an
 * EXISTS the planner turns into one hashed semi-join over the matching task_label rows. probe,
 * inside laterals and aggregate filters that run once per outer row: a correlated lookup of the
 * task's few task_label rows by the task_id prefix of the primary key, the ids checked as a filter
 * (the text cast keeps label_id out of the index condition, and OFFSET 0 keeps the subquery
 * correlated). With label_id = any(ids) as an index condition the planner costs every lookup as one
 * index search per id; with labels merged across many projects that adds up to millions of units
 * per query, which switches JIT on for queries that run in milliseconds.
 */
function visibleOpen(alias: string, params: Params, labels: 'join' | 'probe' = 'join'): SQL {
  return visibleWith(alias, params, labels, sql`${sql.raw(alias)}.status in (${OPEN_STATUSES_SQL})`);
}

/**
 * M7: a Done task under `alias` in the merged-with-open-items group: a merge closed it, it is not
 * archived, and a criterion or done item is still open (task_item(task_id, kind, position) index).
 * Visible and filtered like visibleOpen. The candidates come from the partial index on
 * merged_done_at.
 */
function mergedOpen(alias: string, params: Params): SQL {
  const t = sql.raw(alias);
  return visibleWith(
    alias,
    params,
    'join',
    sql`${t}.merged_done_at is not null and ${t}.status = 'done'
      and exists (select 1 from task_item oi where oi.task_id = ${t}.id and oi.state = 'open')`,
  );
}

function visibleWith(alias: string, params: Params, labels: 'join' | 'probe', status: SQL): SQL {
  const t = sql.raw(alias);
  const parts: SQL[] = [
    sql`${t}.project_id = any(${uuids(params.projectIds)})`,
    sql`${t}.hidden_at is null`,
    sql`${t}.archived_at is null`,
    status,
  ];
  if (params.priorities) parts.push(sql`${t}.priority = any(${sql.param(params.priorities)}::smallint[])`);
  if (params.labelIds) {
    const ids = uuids(params.labelIds);
    parts.push(
      labels === 'join'
        ? sql`exists (select 1 from task_label fl where fl.task_id = ${t}.id and fl.label_id = any(${ids}))`
        : sql`exists (
            select 1 from task_label fl
            where fl.task_id = ${t}.id and fl.label_id::text = any(${ids}::text[])
            offset 0)`,
    );
  }
  return sql.join(parts, sql` and `);
}

/**
 * bk.yes is true when the task under `alias` has an open blocker that is not hidden. A LIMIT 1
 * lateral on the task_dependency primary key: unlike EXISTS it is not copied into every place
 * that reads it (each copy became a hashed subplan over every open task).
 */
const blockerLateral = (alias: string) => sql`left join lateral (
    select true as yes from task_dependency d join task b on b.id = d.blocker_id
    where d.task_id = ${sql.raw(alias)}.id and b.status in (${OPEN_STATUSES_SQL}) and b.hidden_at is null
    limit 1) bk on true`;

/** Agents `me` is responsible for (user.responsible_user_id index). */
const myAgents = (me: string) =>
  sql`select ma.id from "user" ma where ma.responsible_user_id = ${me}::uuid and ma.kind = 'agent'`;

/** Who an In review task waits on: its agent assignee's responsible human, else its creator (a human). */
const WAITING_ON = sql.raw(
  `case when ua.kind = 'agent' and ua.responsible_user_id is not null then ua.responsible_user_id ` +
    `else coalesce(t.created_on_behalf_of_id, t.created_by_id) end`,
);

/**
 * The comment under `alias` is unanswered by `person` (a SQL expression): no later live comment by
 * them on the task and no later activity row by them. Same rule as the dashboard mentions.
 */
const unanswered = (alias: string, person: SQL) => {
  const c = sql.raw(alias);
  return sql`not exists (
      select 1 from comment reply
      where reply.task_id = ${c}.task_id and reply.created_at > ${c}.created_at
        and reply.author_id = ${person} and reply.deleted_at is null)
    and not exists (
      select 1 from activity touch
      where touch.task_id = ${c}.task_id and touch.created_at > ${c}.created_at
        and touch.actor_id = ${person})`;
};

/** Task columns a candidate branch returns: what classification and ordering read. */
const CANDIDATE_COLUMNS = sql.raw(
  `t.id, t.project_id, t.status, t.priority, t.assignee_id, t.created_by_id, t.created_on_behalf_of_id, ` +
    `t.due_date, t.updated_at, t.check_again_on, t.merged_done_at`,
);

/**
 * Candidate branches as one row per task, under alias t. Branches stay narrow (CANDIDATE_COLUMNS)
 * so the ranking sorts small rows; rankedRows reads the full task for the returned rows only.
 */
const candidates = (branches: SQL[]) =>
  sql`(select distinct on (u.id) u.* from (${sql.join(branches, sql` union all `)}) u order by u.id) t`;

/**
 * The open, visible task `ref` points at, as a candidate branch. OFFSET 0 keeps it a primary key
 * probe per row of `from` instead of a hash join over every open task.
 */
const candidateById = (from: SQL, ref: string, params: Params) => sql`select t.* from ${from}
  cross join lateral (
    select ${CANDIDATE_COLUMNS} from task t
    where t.id = ${sql.raw(ref)} and ${visibleOpen('t', params, 'probe')} offset 0) t`;

/** Group codes in SQL: the index in HOME_GROUP_KEYS. Integers sort and partition faster than text. */
const G = Object.fromEntries(HOME_GROUP_KEYS.map((key, index) => [key, sql.raw(String(index))])) as Record<
  HomeGroupKey,
  SQL
>;

const NO_MENTION_SELECT = sql.raw(
  `null::uuid as comment_id, null::timestamptz as comment_at, null::uuid as comment_author_id, ` +
    `null::uuid as comment_on_behalf_of_id, null::uuid as mentioned_id, false as question`,
);

/**
 * The tab's candidate tasks with their group code g (rows without one are dropped), reason columns
 * and sort keys. Review rows sort by their last update; the time they entered In review is looked
 * up for the returned rows only (rankedRows).
 */
function classified(params: Params, tab: HomeTab): SQL {
  const inner =
    tab === 'mine' ? mineSource(params) : tab === 'everyone' ? everyoneSource(params) : waitingSource(params);
  return sql`
    select x.*,
      case when x.g = ${G.mentions} or (x.g = ${G.waiting} and x.reason_kind = 'mention') then x.comment_at
        when x.g in (${G.review}, ${G.waiting}) then x.updated_at
        when x.g = ${G.mergedOpen} then x.merged_done_at
      end as sort_at
    from (${inner}) x
    where x.g is not null`;
}

function mineSource(params: Params): SQL {
  const { me } = params;
  const open = visibleOpen('t', params);
  const meId = sql`${me}::uuid`;
  // My tasks for blocked, overdue and assigned. Tasks of my agents reach Mine only through review
  // (they wait on me) and mentions.
  const mine = sql`(t.assignee_id = ${meId} or (t.assignee_id is null and t.created_by_id = ${meId}))`;
  return sql`
    with mn as (
      -- My unanswered mentions, the newest per task (comment_mention user_id index, comment pkey).
      select distinct on (c.task_id) c.task_id, c.id, c.created_at, c.author_id, c.on_behalf_of_id,
        au.kind = 'agent' as by_agent
      from comment_mention cm
      cross join lateral (
        select c.task_id, c.id, c.created_at, c.author_id, c.on_behalf_of_id from comment c
        where c.id = cm.comment_id and c.deleted_at is null and c.author_id <> ${meId}
          and ${unanswered('c', meId)}
        offset 0) c
      join "user" au on au.id = c.author_id
      where cm.user_id = ${meId}
      order by c.task_id, c.created_at desc, c.id desc)
    select t.*, (bk.yes is not null) as blocked, ${WAITING_ON} as waiting_on,
      mn.id as comment_id, mn.created_at as comment_at, mn.author_id as comment_author_id,
      mn.on_behalf_of_id as comment_on_behalf_of_id,
      case when mn.id is not null then ${meId} end as mentioned_id,
      coalesce(mn.by_agent, false) as question,
      case
        when t.assignee_id = ${meId} then 'assignee'
        when ua.kind = 'agent' and ua.responsible_user_id = ${meId} then 'agent'
        when t.assignee_id is null and t.created_by_id = ${meId} then 'creator'
      end as relation,
      null::text as reason_kind,
      case
        when t.status = 'in_review' and ${WAITING_ON} = ${meId} then ${G.review}
        when t.status = 'done' and t.merged_done_at is not null and ${WAITING_ON} = ${meId} then ${G.mergedOpen}
        when t.status not in (${OPEN_STATUSES_SQL}) then null
        when ${mine} and t.check_again_on <= ${params.today}::date then ${G.checkAgain}
        when mn.id is not null then ${G.mentions}
        when ${mine} and bk.yes is not null then ${G.blocked}
        when ${mine} and t.due_date < ${params.today}::date then ${G.overdue}
        when ${mine} then ${G.assigned}
      end as g
    from ${candidates([
      sql`select ${CANDIDATE_COLUMNS} from task t where ${open} and t.assignee_id = ${meId}`,
      sql`select ${CANDIDATE_COLUMNS} from task t
        where ${open} and t.status = 'in_review' and t.assignee_id in (${myAgents(me)})`,
      sql`select ${CANDIDATE_COLUMNS} from task t
        where ${open} and t.assignee_id is null and t.created_by_id = ${meId}`,
      sql`select ${CANDIDATE_COLUMNS} from task t where ${open} and t.status = 'in_review'
        and (t.created_by_id = ${meId} or t.created_on_behalf_of_id = ${meId})`,
      // M7: Done tasks merged with open items that wait on me (the review rule's person).
      sql`select ${CANDIDATE_COLUMNS} from task t where ${mergedOpen('t', params)}
        and (t.assignee_id in (${myAgents(me)}) or t.created_by_id = ${meId}
          or t.created_on_behalf_of_id = ${meId})`,
      candidateById(sql`mn`, 'mn.task_id', params),
    ])}
    left join "user" ua on ua.id = t.assignee_id
    left join mn on mn.task_id = t.id
    ${blockerLateral('t')}`;
}

function everyoneSource(params: Params): SQL {
  const open = visibleOpen('t', params);
  const weekEnd = addCalendarDays(nextMonday(params.today), -1);
  return sql`
    with bl as (
      -- Tasks with an open, visible blocker: one primary key probe per dependency.
      select distinct d.task_id from task_dependency d
      cross join lateral (
        select 1 from task b
        where b.id = d.blocker_id and b.status in (${OPEN_STATUSES_SQL}) and b.hidden_at is null
        offset 0) b)
    select t.*, (bl.task_id is not null) as blocked, ${WAITING_ON} as waiting_on, ${NO_MENTION_SELECT},
      null::text as relation, null::text as reason_kind,
      case
        when t.status = 'in_review' then ${G.review}
        when t.status = 'done' and t.merged_done_at is not null then ${G.mergedOpen}
        when t.status not in (${OPEN_STATUSES_SQL}) then null
        when bl.task_id is not null then ${G.blocked}
        when t.due_date < ${params.today}::date then ${G.overdue}
        when t.due_date <= ${weekEnd}::date then ${G.dueThisWeek}
      end as g
    from ${candidates([
      sql`select ${CANDIDATE_COLUMNS} from task t where ${open} and t.status = 'in_review'`,
      sql`select ${CANDIDATE_COLUMNS} from task t where ${mergedOpen('t', params)}`,
      candidateById(sql`bl`, 'bl.task_id', params),
      sql`select ${CANDIDATE_COLUMNS} from task t where ${open} and t.due_date <= ${weekEnd}::date`,
    ])}
    left join "user" ua on ua.id = t.assignee_id
    left join bl on bl.task_id = t.id`;
}

/**
 * Agents tab: In review tasks an agent holds (reason review, waiting on a person), else the newest
 * unanswered agent comment that mentions a person of the workspace (reason mention).
 */
function waitingSource(params: Params): SQL {
  const open = visibleOpen('t', params);
  const workspace = sql`${params.workspaceId}::uuid`;
  return sql`
    with agents as (
      select wa.id from member wm join "user" wa on wa.id = wm.user_id and wa.kind = 'agent'
      where wm.organization_id = ${workspace}),
    aq as (
      -- Agent comments mentioning a person of the workspace who has not answered, newest per task.
      select distinct on (c.task_id) c.task_id, c.id, c.created_at, c.author_id, c.on_behalf_of_id,
        cm.user_id as mentioned_id
      from comment_mention cm
      join "user" mu on mu.id = cm.user_id and mu.kind = 'person'
      join member mm on mm.user_id = mu.id and mm.organization_id = ${workspace}
      cross join lateral (
        select c.task_id, c.id, c.created_at, c.author_id, c.on_behalf_of_id from comment c
        where c.id = cm.comment_id and c.deleted_at is null and c.author_id in (select id from agents)
          and ${unanswered('c', sql`cm.user_id`)}
        offset 0) c
      order by c.task_id, c.created_at desc, c.id desc, cm.user_id)
    select t.*, (bk.yes is not null) as blocked, ${WAITING_ON} as waiting_on,
      aq.id as comment_id, aq.created_at as comment_at, aq.author_id as comment_author_id,
      aq.on_behalf_of_id as comment_on_behalf_of_id, aq.mentioned_id, false as question,
      null::text as relation, k.kind as reason_kind,
      case when k.kind is not null then ${G.waiting} end as g
    from ${candidates([
      sql`select ${CANDIDATE_COLUMNS} from task t
        where ${open} and t.status = 'in_review' and t.assignee_id in (select id from agents)`,
      candidateById(sql`aq`, 'aq.task_id', params),
    ])}
    left join "user" ua on ua.id = t.assignee_id
    left join aq on aq.task_id = t.id
    ${blockerLateral('t')}
    cross join lateral (
      select case
        when t.status = 'in_review' and ua.kind = 'agent' then 'review'
        when aq.id is not null then 'mention'
      end as kind) k`;
}

/**
 * Order inside a group. overdue, assigned, dueThisWeek: due date first (none last); checkAgain:
 * the check-again day first (longest waiting first). Then priority (highest first) except on
 * waiting. blocked: then due date. Then newest first: the comment time for mentions, the last
 * update for reviews, the merge for mergedOpen. Then last update and id.
 */
const GROUP_ORDER = sql`case when c.g in (${G.overdue}, ${G.assigned}, ${G.dueThisWeek}) then c.due_date
    when c.g = ${G.checkAgain} then c.check_again_on end asc nulls last,
  case when c.g <> ${G.waiting} then c.priority end desc nulls last,
  case when c.g = ${G.blocked} then c.due_date end asc nulls last,
  c.sort_at desc nulls last, c.updated_at desc, c.id desc`;

/**
 * Each group's uncapped total and its first HOME_GROUP_ITEM_LIMIT rows, in group order. The full
 * task, its project, the parent's key, the comment body and, for In review tasks, the newest move
 * to In review (activity(task_id, created_at) index) are read for those rows only.
 */
async function rankedRows(db: Db, params: Params, tab: HomeTab): Promise<Row[]> {
  return db.execute<Row>(
    sql`
      select r.id as "taskId", r.g, r."groupTotal", r.blocked, r.waiting_on as "waitingOnId", r.relation,
        r.reason_kind as "reasonKind", r.comment_id as "commentId", cb.body as "commentBody",
        r.comment_author_id as "commentAuthorId", r.comment_on_behalf_of_id as "commentOnBehalfOfId",
        r.mentioned_id as "mentionedId", r.question,
        t.number, t.key_suffix as "keySuffix", t.title, t.status, t.priority, t.assignee_id as "assigneeId",
        t.milestone_id as "milestoneId", t.cycle_id as "cycleId", t.cycle_added_at as "cycleAddedAt",
        t.rank, t.backlog_id as "backlogId", t.due_date::text as "dueDate", t.created_at as "createdAt",
        t.updated_at as "updatedAt", t.final_summary is not null as "hasFinalSummary",
        t.check_again_on::text as "checkAgainOn", t.check_again_reason as "checkAgainReason",
        t.merged_done_at as "mergedDoneAt", t.wave_id as "waveId",
        p.id as "projectId", p.key as "projectKey", p.name as "projectName",
        pt.number as "parentNumber", pt.key_suffix as "parentKeySuffix",
        rv.actor_id as "reviewActorId", rv.on_behalf_of_id as "reviewOnBehalfOfId",
        case
          when r.g = ${G.review} or (r.g = ${G.waiting} and r.reason_kind = 'review')
            then coalesce(rv.created_at, t.updated_at)
          when r.g = ${G.mergedOpen} then t.merged_done_at
          else r.comment_at
        end as "reasonAt"
      from (
        select c.*, count(*) over (partition by c.g) as "groupTotal",
          row_number() over (partition by c.g order by ${GROUP_ORDER}) as rn
        from (${classified(params, tab)}) c) r
      join task t on t.id = r.id
      join project p on p.id = t.project_id
      left join task pt on pt.id = t.parent_id
      left join comment cb on cb.id = r.comment_id
      left join lateral (
        select a.actor_id, a.on_behalf_of_id, a.created_at from activity a
        where t.status = 'in_review' and a.task_id = t.id and a.changes @> ${IN_REVIEW_CHANGE}::jsonb
        order by a.created_at desc
        limit 1) rv on true
      where r.rn <= ${HOME_GROUP_ITEM_LIMIT}
      order by r.g, r.rn`,
    'objects',
  );
}

/** Group totals of a tab by group key, without items. */
async function groupTotals(db: Db, params: Params, tab: HomeTab): Promise<Map<string, number>> {
  const rows = await db.execute<{ g: string | number; n: string | number }>(
    sql`select c.g, count(*) as n from (${classified(params, tab)}) c group by c.g`,
    'objects',
  );
  return new Map(rows.map((row) => [HOME_GROUP_KEYS[Number(row.g)] as string, Number(row.n)]));
}

function mineTotal(totals: Map<string, number>): number {
  return MINE_COUNTED.reduce((sum, key) => sum + (totals.get(key) ?? 0), 0);
}

function everyoneTotal(totals: Map<string, number>): number {
  return HOME_GROUPS_BY_TAB.everyone.reduce((sum, key) => sum + (totals.get(key) ?? 0), 0);
}

/** Agents that are members of the workspace. */
async function agentCount(db: Db, params: Params): Promise<number> {
  const [row] = await db.execute<{ n: string | number }>(
    sql`select count(*) as n from member mb join "user" u on u.id = mb.user_id and u.kind = 'agent'
      where mb.organization_id = ${params.workspaceId}::uuid`,
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

/** A Postgres date as YYYY-MM-DD; null stays null. */
function calendarDate(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).slice(0, 10);
}

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** Users by id plus the responsible humans of the agents among them, in two queries. */
async function usersWithResponsibles(db: Db, ids: Iterable<string | null>): Promise<Map<string, UserRow>> {
  const users = await loadUsers(
    db,
    [...ids].filter((id): id is string => id !== null),
  );
  const responsibleIds = [...users.values()]
    .map((row) => row.responsibleUserId)
    .filter((id): id is string => id !== null && !users.has(id));
  for (const [id, row] of await loadUsers(db, responsibleIds)) users.set(id, row);
  return users;
}

function refOf(users: Map<string, UserRow>, id: string | null): UserRef | null {
  const row = id ? users.get(id) : undefined;
  return row ? userRef(row) : null;
}

function assigneeOf(users: Map<string, UserRow>, id: string | null) {
  const row = id ? users.get(id) : undefined;
  if (!row) return null;
  return { ...userRef(row), responsible: refOf(users, row.responsibleUserId) };
}

const taskKeyOf = (row: Row) => formatTaskKey(String(row.projectKey), Number(row.number), str(row.keySuffix));

const projectOf = (row: Row) => ({
  id: String(row.projectId),
  key: String(row.projectKey),
  name: String(row.projectName),
});

/** What the item rows need besides their own columns, loaded in one batch per kind. */
interface Details {
  users: Map<string, UserRow>;
  milestones: Map<string, { id: string; name: string; status: string; targetDate: string | null }>;
  cycles: Map<
    string,
    { id: string; number: number; name: string | null; startsOn: string; endsOn: string; state: CycleState }
  >;
  labels: Map<string, { id: string; name: string; color: number; source: string }[]>;
  /** Open, visible blockers per blocked task, by key. */
  blockers: Map<string, { key: string; title: string; status: TaskStatus; assigneeId: string | null }[]>;
  /** Open, visible tasks waiting on each task. */
  blocks: Map<string, number>;
  subtasks: Map<string, { done: number; total: number }>;
  /** M6: criteria and done-item counts per task, from one grouped query (workItemProgressOf). */
  workItems: Awaited<ReturnType<typeof workItemProgressOf>>;
  mirrored: Set<string>;
  /** M7: the linked requests per task (newest, merged last, count), from one query. */
  requests: Map<string, RequestSummary>;
  /** M8: the waves of the rows' milestones with their locks, from one query (waves.ts). */
  waves: Map<string, WaveState[]>;
}

async function loadDetails(db: Db, rows: Row[], today: string): Promise<Details> {
  const taskIds = rows.map((row) => String(row.taskId));
  const milestoneIds = [...new Set(rows.map((row) => str(row.milestoneId)).filter((id) => id !== null))];
  const cycleIds = [...new Set(rows.map((row) => str(row.cycleId)).filter((id) => id !== null))];
  const none = Promise.resolve([] as Row[]);
  const waveMilestoneIds = rows.flatMap((row) =>
    row.waveId && row.milestoneId ? [String(row.milestoneId)] : [],
  );
  const [milestones, cycles, labels, blockers, blocks, subtasks, workItems, mirrored, requests, waves] =
    await Promise.all([
      milestoneIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select id, name, status, target_date::text as "targetDate" from milestone
            where id = any(${uuids(milestoneIds)})`,
            'objects',
          ),
      cycleIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select id, number, name, starts_on::text as "startsOn", ends_on::text as "endsOn",
              completed_at as "completedAt"
            from cycle where id = any(${uuids(cycleIds)})`,
            'objects',
          ),
      taskIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select tl.task_id as "taskId", l.id, l.name, l.color, l.source
            from task_label tl join label l on l.id = tl.label_id
            where tl.task_id = any(${uuids(taskIds)})
            order by lower(l.name), l.id`,
            'objects',
          ),
      taskIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select d.task_id as "taskId", b.number, b.key_suffix as "keySuffix", b.title, b.status,
              b.assignee_id as "assigneeId", p.key as "projectKey"
            from task_dependency d
            join task b on b.id = d.blocker_id
            join project p on p.id = b.project_id
            where d.task_id = any(${uuids(taskIds)}) and b.status in (${OPEN_STATUSES_SQL})
              and b.hidden_at is null
            order by p.key, b.number, b.key_suffix nulls first`,
            'objects',
          ),
      taskIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select d.blocker_id as "taskId", count(*) as n
            from task_dependency d join task w on w.id = d.task_id
            where d.blocker_id = any(${uuids(taskIds)}) and w.status in (${OPEN_STATUSES_SQL})
              and w.hidden_at is null
            group by d.blocker_id`,
            'objects',
          ),
      taskIds.length === 0
        ? none
        : db.execute<Row>(
            sql`select s.parent_id as "taskId", count(*) filter (where s.status = 'done') as done,
              count(*) filter (where s.status <> 'canceled') as total
            from task s
            where s.parent_id = any(${uuids(taskIds)}) and s.hidden_at is null
            group by s.parent_id`,
            'objects',
          ),
      workItemProgressOf(db, taskIds),
      mirroredProjectIds(
        db,
        rows.map((row) => String(row.projectId)),
      ),
      requestSummariesOf(db, taskIds),
      waveStates(db, waveMilestoneIds),
    ]);

  const userIds = new Set<string | null>();
  for (const row of rows) {
    for (const column of [
      'assigneeId',
      'reviewActorId',
      'reviewOnBehalfOfId',
      'waitingOnId',
      'commentAuthorId',
      'commentOnBehalfOfId',
      'mentionedId',
    ]) {
      userIds.add(str(row[column]));
    }
  }
  for (const row of blockers) userIds.add(str(row.assigneeId));
  const users = await usersWithResponsibles(db, userIds);

  const grouped = <T>(list: Row[], map: (row: Row) => T) => {
    const result = new Map<string, T[]>();
    for (const row of list) {
      const key = String(row.taskId);
      const items = result.get(key) ?? [];
      items.push(map(row));
      result.set(key, items);
    }
    return result;
  };

  return {
    users,
    milestones: new Map(
      milestones.map((row) => [
        String(row.id),
        {
          id: String(row.id),
          name: String(row.name),
          status: String(row.status),
          targetDate: calendarDate(row.targetDate),
        },
      ]),
    ),
    cycles: new Map(
      cycles.map((row) => {
        const startsOn = String(row.startsOn);
        const endsOn = String(row.endsOn);
        const completedAt = row.completedAt === null ? null : timestamp(row.completedAt);
        return [
          String(row.id),
          {
            id: String(row.id),
            number: Number(row.number),
            name: str(row.name),
            startsOn,
            endsOn,
            state: cycleStateOn({ startsOn, endsOn, completedAt }, today),
          },
        ];
      }),
    ),
    labels: grouped(labels, (row) => ({
      id: String(row.id),
      name: String(row.name),
      color: Number(row.color),
      source: String(row.source),
    })),
    blockers: grouped(blockers, (row) => ({
      key: formatTaskKey(String(row.projectKey), Number(row.number), str(row.keySuffix)),
      title: String(row.title),
      status: row.status as TaskStatus,
      assigneeId: str(row.assigneeId),
    })),
    blocks: new Map(blocks.map((row) => [String(row.taskId), Number(row.n)])),
    subtasks: new Map(
      subtasks.map((row) => [String(row.taskId), { done: Number(row.done), total: Number(row.total) }]),
    ),
    workItems,
    mirrored,
    requests,
    waves,
  };
}

/** M7: the row's check-again day and reason; null when none. */
function checkAgainOfRow(row: Row): { on: string; reason: string } | null {
  const on = calendarDate(row.checkAgainOn);
  return on === null || row.checkAgainReason === null || row.checkAgainReason === undefined
    ? null
    : { on, reason: String(row.checkAgainReason) };
}

/** M7: open items of a Done task a merge closed; null unless it is in the merged-with-open-items state. */
function mergedOpenOfRow(row: Row, details: Details): { openCriteria: number; openDoneItems: number } | null {
  if (row.status !== 'done' || row.mergedDoneAt === null || row.mergedDoneAt === undefined) return null;
  const progress = progressFor(details.workItems, String(row.taskId));
  const open = { openCriteria: progress.criteria.open, openDoneItems: progress.done.open };
  return open.openCriteria + open.openDoneItems > 0 ? open : null;
}

function listItemOf(row: Row, details: Details): z.input<typeof TaskListItem> {
  const taskId = String(row.taskId);
  const projectKey = String(row.projectKey);
  const milestoneId = str(row.milestoneId);
  const cycleId = str(row.cycleId);
  const parentNumber = row.parentNumber;
  const workItems = progressFor(details.workItems, taskId);
  return {
    id: taskId,
    key: taskKeyOf(row),
    number: Number(row.number),
    project: projectOf(row),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: priorityFromValue(Number(row.priority)),
    assignee: assigneeOf(details.users, str(row.assigneeId)),
    milestone: milestoneId ? (details.milestones.get(milestoneId) ?? null) : null,
    cycle: cycleId ? (details.cycles.get(cycleId) ?? null) : null,
    cycleAddedAt: row.cycleAddedAt === null ? null : timestamp(row.cycleAddedAt),
    rank: Number(row.rank),
    backlogId: str(row.backlogId),
    locked: details.mirrored.has(String(row.projectId)) ? [...TASK_OWNED_FIELDS] : [],
    hidden: false,
    hiddenAt: null,
    labels: details.labels.get(taskId) ?? [],
    dueDate: calendarDate(row.dueDate),
    subtaskProgress: details.subtasks.get(taskId) ?? { done: 0, total: 0 },
    blocked: Boolean(row.blocked),
    parentKey:
      parentNumber === null || parentNumber === undefined
        ? null
        : formatTaskKey(projectKey, Number(parentNumber), str(row.parentKeySuffix)),
    criteriaProgress: workItems.criteria,
    doneProgress: workItems.done,
    hasFinalSummary: Boolean(row.hasFinalSummary),
    checkAgain: checkAgainOfRow(row),
    archivedAt: null,
    pullRequest: details.requests.get(taskId)?.newest ?? null,
    pullRequestCount: details.requests.get(taskId)?.count ?? 0,
    wave: taskWaveOf(details.waves, str(row.waveId)),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  } as z.input<typeof TaskListItem>;
}

function requireRef(users: Map<string, UserRow>, id: unknown, what: string): UserRef {
  const ref = refOf(users, str(id));
  if (!ref) throw new Error(`home row without ${what}`);
  return ref;
}

function reviewReason(row: Row, users: Map<string, UserRow>): z.input<typeof HomeReason> {
  return {
    kind: 'review',
    requestedBy: refOf(users, str(row.reviewActorId)),
    onBehalfOf: refOf(users, str(row.reviewOnBehalfOfId)),
    waitingOn: refOf(users, str(row.waitingOnId)),
    at: timestamp(row.reasonAt),
  };
}

function mentionReason(row: Row, users: Map<string, UserRow>): z.input<typeof HomeReason> {
  return {
    kind: 'mention',
    author: requireRef(users, row.commentAuthorId, 'comment author'),
    onBehalfOf: refOf(users, str(row.commentOnBehalfOfId)),
    mentioned: requireRef(users, row.mentionedId, 'mentioned user'),
    comment: { id: String(row.commentId), excerpt: mentionExcerpt(String(row.commentBody ?? '')) },
    at: timestamp(row.reasonAt),
  };
}

function reasonOf(
  row: Row,
  group: HomeGroupKey,
  details: Details,
  today: string,
): z.input<typeof HomeReason> {
  const dueDate = calendarDate(row.dueDate);
  switch (group) {
    case 'review':
      return reviewReason(row, details.users);
    case 'mentions':
      return mentionReason(row, details.users);
    case 'waiting':
      return row.reasonKind === 'review'
        ? reviewReason(row, details.users)
        : mentionReason(row, details.users);
    case 'blocked': {
      const blockers = details.blockers.get(String(row.taskId)) ?? [];
      return {
        kind: 'blocked',
        blockers: blockers.map(
          (blocker): RelatedTask => ({
            key: blocker.key,
            title: blocker.title,
            status: blocker.status,
            assignee: refOf(details.users, blocker.assigneeId),
          }),
        ),
      };
    }
    case 'overdue':
      return {
        kind: 'overdue',
        dueDate: dueDate as string,
        daysOverdue: calendarDaysBetween(dueDate as string, today),
      };
    case 'dueThisWeek':
      return {
        kind: 'due',
        dueDate: dueDate as string,
        daysLeft: calendarDaysBetween(today, dueDate as string),
      };
    case 'assigned':
      return { kind: 'assigned' };
    case 'mergedOpen': {
      const open = mergedOpenOfRow(row, details) ?? { openCriteria: 0, openDoneItems: 0 };
      const summary = details.requests.get(String(row.taskId));
      const merged = summary?.merged ?? null;
      const pullRequest: PullRequestRef | null = merged
        ? { provider: merged.provider, number: merged.number, title: merged.title, url: merged.url }
        : null;
      return {
        kind: 'mergedOpen',
        pullRequest,
        mergedBy: merged ? (summary?.mergedBy ?? null) : null,
        ...open,
        at: timestamp(row.reasonAt),
      };
    }
    case 'checkAgain': {
      const check = checkAgainOfRow(row) as { on: string; reason: string };
      return {
        kind: 'checkAgain',
        on: check.on,
        reason: check.reason,
        daysAgo: Math.max(0, calendarDaysBetween(check.on, today)),
      };
    }
  }
}

/** The task's other states, in contract order, leaving out the state of its own group. */
function pillsOf(
  row: Row,
  group: HomeGroupKey,
  item: z.input<typeof TaskListItem>,
  details: Details,
  today: string,
) {
  const pills: HomePill[] = [];
  const dueDate = calendarDate(row.dueDate);
  // No review pill: review is the first group of every tab that has it.
  if (row.blocked && group !== 'blocked') pills.push({ kind: 'blocked' });
  if (dueDate !== null && dueDate < today && group !== 'overdue') {
    pills.push({ kind: 'overdue', daysOverdue: calendarDaysBetween(dueDate, today) });
  }
  if (dueDate !== null && dueDate >= today && group !== 'dueThisWeek') {
    const daysLeft = calendarDaysBetween(today, dueDate);
    if (daysLeft <= DUE_SOON_DAYS) pills.push({ kind: 'due', daysLeft });
  }
  const blocks = details.blocks.get(String(row.taskId)) ?? 0;
  if (blocks > 0) pills.push({ kind: 'blocks', count: blocks });
  const cycleId = str(row.cycleId);
  const cycle = cycleId ? details.cycles.get(cycleId) : undefined;
  if (cycle?.state === 'current')
    pills.push({ kind: 'cycle', cycle: { number: cycle.number, name: cycle.name } });
  if (row.question) pills.push({ kind: 'question' });
  if (item.assignee === null) pills.push({ kind: 'unassigned' });
  // M7: a merged task with open items, and a check-again day that came, outside their own groups.
  const merged = group === 'mergedOpen' ? null : mergedOpenOfRow(row, details);
  if (merged) pills.push({ kind: 'mergedOpen', openItems: merged.openCriteria + merged.openDoneItems });
  const check = checkAgainOfRow(row);
  const open = (OPEN_TASK_STATUSES as readonly string[]).includes(String(row.status));
  if (check && open && check.on <= today && group !== 'checkAgain')
    pills.push({ kind: 'checkAgain', on: check.on });
  return pills;
}

/** The tab's groups, in HOME_GROUPS_BY_TAB order, empty ones included. */
async function groupsOf(db: Db, params: Params, tab: HomeTab) {
  const rows = await rankedRows(db, params, tab);
  const details = await loadDetails(db, rows, params.today);
  const totals = new Map<string, number>();
  const items = new Map<string, z.input<typeof HomeItem>[]>();
  for (const row of rows) {
    const group = HOME_GROUP_KEYS[Number(row.g)] as HomeGroupKey;
    totals.set(group, Number(row.groupTotal));
    const task = listItemOf(row, details);
    const list = items.get(group) ?? [];
    list.push({
      task,
      reason: reasonOf(row, group, details, params.today),
      relation: tab === 'mine' ? ((row.relation as HomeRelation | null) ?? null) : null,
      pills: pillsOf(row, group, task, details, params.today),
    });
    items.set(group, list);
  }
  const groups = HOME_GROUPS_BY_TAB[tab].map((key) => ({
    key,
    total: totals.get(key) ?? 0,
    items: items.get(key) ?? [],
  }));
  return { groups, totals };
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * Milestones not Completed with a target date up to DUE_SOON_DAYS after today (overdue included),
 * current cycles ending within DUE_SOON_DAYS, both with an open task of the tab, and open tasks
 * of the tab due within DUE_SOON_DAYS or overdue. Soonest first; at most DEADLINE_LIMIT.
 */
async function deadlines(db: Db, params: Params, tab: 'mine' | 'everyone'): Promise<HomeDeadline[]> {
  const { me, today } = params;
  const lastDay = addCalendarDays(today, DUE_SOON_DAYS);
  const open = visibleOpen('t', params);
  const openProbe = visibleOpen('t', params, 'probe');
  const ofTab =
    tab === 'mine'
      ? sql`and (t.assignee_id = ${me}::uuid or (t.assignee_id is null and t.created_by_id = ${me}::uuid))`
      : sql``;
  const rows = await db.execute<Row>(
    sql`
      select * from (
        select 'milestone' as kind, 0 as "kindRank", m.id::text as id, m.name, m.target_date::text as "dueOn",
          null::integer as number, null::text as "keySuffix", null::text as status, null::text as "startsOn",
          p.id as "projectId", p.key as "projectKey", p.name as "projectName", mp.done, mp.total
        from milestone m
        join project p on p.id = m.project_id
        -- Progress per milestone on task(milestone_id).
        cross join lateral (
          select count(*) filter (where t.status = 'done') as done,
            count(*) filter (where t.status <> 'canceled') as total,
            count(*) filter (where ${openProbe} ${ofTab}) as open
          from task t where t.milestone_id = m.id and t.hidden_at is null) mp
        where m.project_id = any(${uuids(params.projectIds)}) and p.uses_milestones and m.hidden_at is null
          and m.status <> 'completed' and m.target_date <= ${lastDay}::date and mp.open > 0
        union all
        select 'cycle', 1, c.id::text, c.name, c.ends_on::text, c.number, null, null, c.starts_on::text,
          p.id, p.key, p.name, cp.done, cp.total
        from cycle c
        join project p on p.id = c.project_id
        -- Progress per cycle on task(cycle_id).
        cross join lateral (
          select count(*) filter (where t.status = 'done') as done, count(*) as total,
            count(*) filter (where ${openProbe} ${ofTab}) as open
          from task t where t.cycle_id = c.id and t.hidden_at is null) cp
        where c.project_id = any(${uuids(params.projectIds)}) and p.uses_cycles
          and c.completed_at is null and c.starts_on <= ${today}::date
          and c.ends_on >= ${today}::date and c.ends_on <= ${lastDay}::date and cp.open > 0
        union all
        select 'task', 2, t.id::text, t.title, t.due_date::text, t.number, t.key_suffix, t.status::text, null,
          p.id, p.key, p.name, 0, 0
        from task t
        join project p on p.id = t.project_id
        where ${open} ${ofTab} and t.due_date <= ${lastDay}::date
      ) d
      order by d."dueOn" asc, d."kindRank" asc, d."projectKey" asc, d.number asc nulls first, d.name asc
      limit ${DEADLINE_LIMIT}`,
    'objects',
  );
  return rows.map((row): HomeDeadline => {
    const project = projectOf(row);
    const dueOn = calendarDate(row.dueOn) as string;
    const progress = { done: Number(row.done), total: Number(row.total) };
    if (row.kind === 'milestone') {
      return {
        kind: 'milestone',
        project,
        milestone: { id: String(row.id), name: String(row.name), targetDate: dueOn },
        daysLeft: calendarDaysBetween(today, dueOn),
        progress,
      };
    }
    if (row.kind === 'cycle') {
      return {
        kind: 'cycle',
        project,
        cycle: {
          number: Number(row.number),
          name: str(row.name),
          startsOn: calendarDate(row.startsOn) as string,
          endsOn: dueOn,
        },
        daysLeft: calendarDaysBetween(today, dueOn) + 1,
        progress,
      };
    }
    return {
      kind: 'task',
      task: {
        key: formatTaskKey(project.key, Number(row.number), str(row.keySuffix)),
        title: String(row.name),
        status: row.status as TaskStatus,
        project,
      },
      dueDate: dueOn,
      daysLeft: calendarDaysBetween(today, dueOn),
    };
  });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * One card per agent member of the workspace: its open, visible tasks (filters apply), the In
 * progress task touched most recently, today's activity rows and comments, and its last
 * HOME_AGENT_ACTION_LIMIT actions. Activity and comments count in the readable projects (project
 * filter included). Working first, then by name.
 */
async function agentCards(db: Db, params: Params): Promise<HomeAgent[]> {
  // Both task reads below are laterals per agent.
  const open = visibleOpen('t', params, 'probe');
  const projects = uuids(params.projectIds);
  const workingSince = new Date(params.now.getTime() - WORKING_WINDOW_MS);
  const cards = await db.execute<Row>(
    sql`
      select u.id as "agentId", u.responsible_user_id as "responsibleId",
        load.assigned, load.in_review as "inReview", load.blocked,
        cur.id as "taskId", cur.number, cur.key_suffix as "keySuffix", cur.title, cur.status,
        cur.project_id as "projectId", cur.project_key as "projectKey", cur.project_name as "projectName",
        cur.touched_at as "touchedAt",
        coalesce(
          (select max(a.created_at) from activity a
            where a.task_id = cur.id and a.changes @> ${IN_PROGRESS_CHANGE}::jsonb),
          cur.updated_at) as since
      from member mb
      join "user" u on u.id = mb.user_id and u.kind = 'agent'
      cross join lateral (
        select count(*) as assigned,
          count(*) filter (where t.status = 'in_review') as in_review,
          count(*) filter (where bk.yes) as blocked
        from task t ${blockerLateral('t')}
        where t.assignee_id = u.id and ${open}) load
      left join lateral (
        select t.id, t.number, t.key_suffix, t.title, t.status, p.id as project_id, p.key as project_key,
          p.name as project_name, touched.at as touched_at, t.updated_at
        from task t
        join project p on p.id = t.project_id
        cross join lateral (select greatest(t.updated_at,
          (select max(lc.created_at) from comment lc where lc.task_id = t.id)) as at) touched
        where t.assignee_id = u.id and t.status = 'in_progress' and ${open}
        order by touched.at desc, t.id desc
        limit 1) cur on true
      where mb.organization_id = ${params.workspaceId}::uuid`,
    'objects',
  );
  const agentIds = cards.map((row) => String(row.agentId));
  if (agentIds.length === 0) return [];

  const dayStart = sql`(${params.today}::date::timestamp at time zone ${params.timeZone})`;
  const [today, recent] = await Promise.all([
    // One grouped query over activity(actor_id, created_at) and comment(author_id, created_at).
    db.execute<Row>(
      sql`
        select x.actor_id as "agentId", count(*) as n from (
          select a.actor_id from activity a
          where a.actor_id = any(${uuids(agentIds)}) and a.created_at >= ${dayStart}
            and a.project_id = any(${projects})
          union all
          select c.author_id from comment c join task wt on wt.id = c.task_id
          where c.author_id = any(${uuids(agentIds)}) and c.created_at >= ${dayStart}
            and c.deleted_at is null and wt.project_id = any(${projects})
        ) x
        group by x.actor_id`,
      'objects',
    ),
    db.execute<Row>(
      sql`
        select u.id as "agentId", x.* from "user" u
        cross join lateral (
          select * from (
            (select 'activity' as kind, a.id, a.type, a.changes, a.actor_id as "actorId",
                a.on_behalf_of_id as "onBehalfOfId", a.origin, a.origin_ref as "originRef",
                null::text as body, a.created_at as at,
                t.number, t.key_suffix as "keySuffix", t.title, t.status,
                p.id as "projectId", p.key as "projectKey", p.name as "projectName"
              from activity a
              join task t on t.id = a.task_id and t.hidden_at is null
              join project p on p.id = t.project_id
              where a.actor_id = u.id and a.project_id = any(${projects}) and t.project_id = any(${projects})
              order by a.created_at desc
              limit ${HOME_AGENT_ACTION_LIMIT})
            union all
            (select 'comment', c.id, null, null, null, null, null, null, c.body, c.created_at,
                t.number, t.key_suffix, t.title, t.status, p.id, p.key, p.name
              from comment c
              join task t on t.id = c.task_id and t.hidden_at is null
              join project p on p.id = t.project_id
              where c.author_id = u.id and c.deleted_at is null and t.project_id = any(${projects})
              order by c.created_at desc
              limit ${HOME_AGENT_ACTION_LIMIT})
          ) both_kinds
          order by at desc, id desc
          limit ${HOME_AGENT_ACTION_LIMIT}) x
        where u.id = any(${uuids(agentIds)})`,
      'objects',
    ),
  ]);

  // Activity changes resolve through the activity mapper (users, milestones, cycles, labels) in
  // one call; its task key is only used for the Activity shape, which is dropped here.
  const activityRows = recent.filter((row) => row.kind === 'activity');
  const resolved = new Map<string, unknown[]>();
  if (activityRows.length > 0) {
    const mapped = await toActivities(
      db,
      taskKeyOf(activityRows[0] as Row),
      activityRows.map(
        (row) =>
          ({
            id: String(row.id),
            type: row.type,
            changes: row.changes,
            actorId: str(row.actorId),
            onBehalfOfId: str(row.onBehalfOfId),
            origin: row.origin,
            originRef: str(row.originRef),
            createdAt: timestamp(row.at),
          }) as unknown as ActivityRow,
      ),
    );
    for (const activity of mapped) resolved.set(activity.id, activity.changes);
  }
  const commentMentions = new Map<string, string[]>();
  for (const row of recent) {
    if (row.kind === 'comment') commentMentions.set(String(row.id), mentionedUserIds(String(row.body ?? '')));
  }
  const users = await usersWithResponsibles(db, [
    ...agentIds,
    ...cards.map((row) => str(row.responsibleId)),
    ...[...commentMentions.values()].flat(),
  ]);

  const changesToday = new Map(today.map((row) => [String(row.agentId), Number(row.n)]));
  const actionsByAgent = new Map<string, z.input<typeof HomeAgentAction>[]>();
  for (const row of recent) {
    const task: HomeTaskRef = {
      key: taskKeyOf(row),
      title: String(row.title),
      status: row.status as TaskStatus,
      project: projectOf(row),
    };
    const action: z.input<typeof HomeAgentAction> =
      row.kind === 'activity'
        ? {
            kind: 'activity',
            id: String(row.id),
            task,
            type: row.type as never,
            changes: (resolved.get(String(row.id)) ?? []) as never,
            at: timestamp(row.at),
          }
        : {
            kind: 'comment',
            id: String(row.id),
            task,
            excerpt: mentionExcerpt(String(row.body ?? '')),
            mentions: (commentMentions.get(String(row.id)) ?? [])
              .map((id) => refOf(users, id))
              .filter((ref): ref is UserRef => ref !== null),
            at: timestamp(row.at),
          };
    const list = actionsByAgent.get(String(row.agentId)) ?? [];
    list.push(action);
    actionsByAgent.set(String(row.agentId), list);
  }

  const result = cards.map((row) => {
    const agentId = String(row.agentId);
    const touchedAt = row.touchedAt === null ? null : timestamp(row.touchedAt);
    const working = touchedAt !== null && touchedAt >= workingSince;
    const actions = actionsByAgent.get(agentId) ?? [];
    return {
      agent: assigneeOf(users, agentId) as NonNullable<ReturnType<typeof assigneeOf>>,
      state: working ? ('working' as const) : ('idle' as const),
      currentTask: working
        ? {
            key: taskKeyOf(row),
            title: String(row.title),
            status: row.status as TaskStatus,
            project: projectOf(row),
            since: timestamp(row.since),
          }
        : null,
      counts: {
        assigned: Number(row.assigned),
        inReview: Number(row.inReview),
        blocked: Number(row.blocked),
        changesToday: changesToday.get(agentId) ?? 0,
      },
      recent: actions,
      lastActivityAt: actions[0]?.at ?? null,
    };
  });
  result.sort(
    (a, b) =>
      Number(b.state === 'working') - Number(a.state === 'working') ||
      a.agent.name.localeCompare(b.agent.name) ||
      a.agent.id.localeCompare(b.agent.id),
  );
  return result as unknown as HomeAgent[];
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Ids of the labels in `projectIds` named like `names`, ignoring case: Home merges labels by name
 * across projects (label_projectId_name_unique on project_id, lower(name)).
 */
async function labelIdsNamed(db: Db, projectIds: string[], names: string[]): Promise<string[]> {
  const lowered = [...new Set(names.map((name) => name.toLowerCase()))];
  const rows = await db.execute<{ id: string }>(
    sql`select l.id from label l
      where l.project_id = any(${uuids(projectIds)}) and lower(l.name) = any(${sql.param(lowered)}::text[])`,
    'objects',
  );
  return rows.map((row) => String(row.id));
}

async function paramsFor(ctx: HomeContext, actor: Actor, input: GetHomeInput): Promise<Params> {
  authorize(actor, 'workspace.read');
  const projects = await readableProjects(ctx.db, actor, input.project);
  const projectIds = projects.map((row) => row.id);
  return {
    projectIds,
    me: actor.userId,
    workspaceId: actor.workspaceId,
    today: todayIn(ctx),
    timeZone: ctx.timeZone ?? DEFAULT_TIME_ZONE,
    now: clockNow(ctx),
    labelIds: input.label ? await labelIdsNamed(ctx.db, projectIds, input.label) : null,
    priorities: input.priority ? [...new Set(input.priority.map(priorityToValue))] : null,
  };
}

/**
 * Home for `tab` (default mine): the tab's groups with uncapped totals and up to
 * HOME_GROUP_ITEM_LIMIT items each, the counts of all three tabs, the deadlines strip (Mine and
 * Everyone) and the agent cards (Agents). Reads only the projects the actor can read (API key
 * scopes apply) and leaves hidden tasks out. The project, label and priority filters narrow
 * groups, counts and deadlines alike. Read-only keys may call it.
 */
export async function getHome(
  ctx: HomeContext,
  actor: Actor,
  input?: z.input<typeof GetHomeInput>,
): Promise<Home> {
  const parsed = parseInput(GetHomeInput, input);
  const { tab } = parsed;
  const params = await paramsFor(ctx, actor, parsed);
  const { db } = ctx;

  if (tab === 'agents') {
    const [{ groups }, agents, mine, everyone] = await Promise.all([
      groupsOf(db, params, tab),
      agentCards(db, params),
      groupTotals(db, params, 'mine'),
      groupTotals(db, params, 'everyone'),
    ]);
    return Home.parse({
      tab,
      generatedAt: params.now,
      counts: { mine: mineTotal(mine), everyone: everyoneTotal(everyone), agents: agents.length },
      deadlines: [],
      groups,
      agents,
    });
  }

  const other: HomeTab = tab === 'mine' ? 'everyone' : 'mine';
  const [{ groups, totals }, otherTotals, agents, strip] = await Promise.all([
    groupsOf(db, params, tab),
    groupTotals(db, params, other),
    agentCount(db, params),
    deadlines(db, params, tab),
  ]);
  const mineTotals = tab === 'mine' ? totals : otherTotals;
  const everyoneTotals = tab === 'mine' ? otherTotals : totals;
  return Home.parse({
    tab,
    generatedAt: params.now,
    counts: { mine: mineTotal(mineTotals), everyone: everyoneTotal(everyoneTotals), agents },
    deadlines: strip,
    groups,
    agents: [],
  });
}

/**
 * The Mine counts of needs your review, merged with open items and check again (M7), mentions,
 * blocked and overdue, and their sum: the sidebar count. Each task counts once, in its first
 * group, as on Home.
 */
export async function getHomeCounts(ctx: HomeContext, actor: Actor): Promise<HomeCounts> {
  const params = await paramsFor(ctx, actor, parseInput(GetHomeInput, {}));
  const totals = await groupTotals(ctx.db, params, 'mine');
  const counts = Object.fromEntries(MINE_COUNTED.map((key) => [key, totals.get(key) ?? 0])) as Record<
    (typeof MINE_COUNTED)[number],
    number
  >;
  return HomeCounts.parse({ ...counts, total: mineTotal(totals) });
}
