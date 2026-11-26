import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { canonicalTaskPath, prefetchTaskPage, settleOnServer } from '~/features/tasks/prefetch';
import { TaskPage } from '~/features/tasks/TaskPage';

// One task on a full page: /w/<slug>/p/PAY/PAY-140. Subtask keys (PAY-786.1) work as they are; a Backlog.md ID
// (/p/PAY/BACK-786.1, back-007) or a key in the wrong case redirects to the task's own key.
export const Route = createFileRoute('/_app/w/$workspace/p/$projectKey/$taskKey')({
  beforeLoad: async ({ context, params }) => {
    const target = await canonicalTaskPath(
      context.api,
      context.queryClient,
      params.projectKey,
      params.taskKey,
    );
    if (!target) throw notFound();
    if (target.projectKey !== params.projectKey || target.taskKey !== params.taskKey) {
      throw redirect({
        to: '/w/$workspace/p/$projectKey/$taskKey',
        params: { ...params, ...target },
        replace: true,
      });
    }
  },
  loader: ({ context, params }) =>
    settleOnServer(prefetchTaskPage(context.api, context.queryClient, params.taskKey)),
  head: ({ params }) => ({ meta: [{ title: `${params.taskKey} · Zamu` }] }),
  component: TaskPageRoute,
});

function TaskPageRoute() {
  const { projectKey, taskKey } = Route.useParams();
  return <TaskPage key={taskKey} projectKey={projectKey} taskKey={taskKey} />;
}
