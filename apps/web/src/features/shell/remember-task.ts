import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { rememberTask } from '~/features/palette/recent';
import { taskQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { taskKeyFromPath } from './paths';

/**
 * Records the task view's task in the palette's Recent list once the page has loaded it. Reads the
 * cache only: the task page fetches the task, this never does.
 */
export function useRememberOpenedTask(userId: string | undefined, pathname: string): void {
  const api = useApi();
  const key = taskKeyFromPath(pathname);
  const task = useQuery({ ...taskQuery(api, key ?? ''), enabled: false }).data;
  useEffect(() => {
    if (!userId || !key || !task || task.key.toUpperCase() !== key) return;
    rememberTask(userId, {
      key: task.key,
      title: task.title,
      status: task.status,
      projectName: task.project.name,
    });
  }, [userId, key, task]);
}
