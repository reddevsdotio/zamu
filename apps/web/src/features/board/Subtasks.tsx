import { useQuery } from '@tanstack/react-query';
import type { TaskListItem } from '@zamu/contracts';
import { useMemo } from 'react';
import { retryOnce } from '~/features/tasks/errors';
import { useApi } from '~/lib/workspace';
import { BoardSubtaskRow } from '~/ui';

// The rows under an expanded parent card (frame 032): its subtasks, loaded with tasks.list parent=KEY
// when the card opens. The query sits under tasks.list, so field changes and moves refresh it too.

export interface SubtaskRowsProps {
  projectKey: string;
  parentKey: string;
  /** The viewer's own avatar stays off the rows. */
  viewerId: string | null;
  onOpen: (key: string) => void;
}

const MAX_SUBTASKS = 100;

/** Oldest first, the order they were added in. */
const byCreated = (a: TaskListItem, b: TaskListItem) =>
  a.createdAt.localeCompare(b.createdAt) || a.number - b.number;

export function SubtaskRows({ projectKey, parentKey, viewerId, onOpen }: SubtaskRowsProps) {
  const api = useApi();
  const query = useQuery({
    ...api.orpc.tasks.list.queryOptions({
      input: { project: [projectKey], parent: parentKey, limit: MAX_SUBTASKS },
    }),
    retry: retryOnce,
  });
  const items = query.data?.items;
  const rows = useMemo(() => [...(items ?? [])].sort(byCreated), [items]);
  if (query.isPending) {
    return <p className="m-0 px-1 py-1.5 text-xs text-fg-3">Loading subtasks…</p>;
  }
  if (query.isError) {
    return <p className="m-0 px-1 py-1.5 text-xs text-fg-3">Couldn't load the subtasks.</p>;
  }
  return (
    <div className="-mx-1 mt-0.5 -mb-1 flex flex-col">
      {rows.map((task) => (
        <BoardSubtaskRow
          key={task.key}
          taskKey={task.key}
          title={task.title}
          status={task.status}
          assignee={
            task.assignee && task.assignee.id !== viewerId
              ? { name: task.assignee.name, kind: task.assignee.kind }
              : null
          }
          onPress={() => onOpen(task.key)}
        />
      ))}
    </div>
  );
}
