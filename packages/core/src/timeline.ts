// The task timeline: activity entries, comments and (M6) work notes in one list, oldest first,
// narrowed by the `show` filter, with the size of every filter so clients can label them.
import {
  formatTaskKey,
  ListTaskTimelineInput,
  type Timeline,
  type TimelineCounts,
  type TimelineFilter,
  type TimelineItem,
} from '@zamu/contracts';
import type { z } from 'zod';
import { loadTaskActivityRows, toActivities } from './activity';
import type { Actor } from './authz';
import { loadTaskCommentRows, toComments } from './comments';
import type { DbContext } from './context';
import { parseInput } from './errors';
import { findTask } from './internal';

function compareItems(a: TimelineItem, b: TimelineItem): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0) return byTime;
  // uuidv7 ids sort by creation time, so they break ties within a millisecond (and inside one
  // transaction, where every row shares now()).
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Which timeline kinds each filter keeps. */
const FILTER_KINDS: Record<TimelineFilter, ReadonlySet<TimelineItem['kind']>> = {
  all: new Set(['activity', 'comment', 'note']),
  comments: new Set(['comment']),
  notes: new Set(['note']),
  history: new Set(['activity']),
};

/**
 * A task's history: activity entries, comments and notes, oldest first, ties broken by id.
 * Deleted comments and notes stay with a null body; their author is who deleted them (only
 * authors delete).
 * M3: the task may be addressed by its Backlog.md id. Entries a Backlog.md refresh wrote carry
 * origin backlog, the commit in originRef and a null actor (the Backlog.md actor); a null actor
 * with origin app is the system (the hourly cycle job). Hidden tasks keep their timeline.
 * M6: notes come back as items of kind note. `show` (default all) keeps comments, notes or
 * history (activity) only; `counts` gives the size of each filter, deleted entries included.
 */
export async function listTaskTimeline(
  { db }: DbContext,
  actor: Actor,
  input: z.input<typeof ListTaskTimelineInput>,
): Promise<Timeline> {
  const { key, project: projectKey, show = 'all' } = parseInput(ListTaskTimelineInput, input);
  const { project, task } = await findTask(db, actor, key, { project: projectKey });
  const taskKey = formatTaskKey(project.key, task.number, task.keySuffix);
  const [activityRows, commentRows] = await Promise.all([
    loadTaskActivityRows(db, task.id),
    loadTaskCommentRows(db, task.id),
  ]);
  const [activities, comments] = await Promise.all([
    toActivities(db, taskKey, activityRows),
    toComments(db, taskKey, commentRows),
  ]);
  const items: TimelineItem[] = [
    ...activities.map((item) => ({ ...item, kind: 'activity' as const })),
    ...comments.map((item) =>
      item.kind === 'note' ? { ...item, kind: 'note' as const } : { ...item, kind: 'comment' as const },
    ),
  ];
  const counts: TimelineCounts = { all: items.length, comments: 0, notes: 0, history: 0 };
  for (const item of items) {
    if (item.kind === 'activity') counts.history += 1;
    else if (item.kind === 'note') counts.notes += 1;
    else counts.comments += 1;
  }
  const kinds = FILTER_KINDS[show];
  return { items: items.filter((item) => kinds.has(item.kind)).sort(compareItems), counts };
}
