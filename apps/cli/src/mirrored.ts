// Backlog.md mirror errors at a terminal: the server's problem names the file and a Backlog.md
// command; zamu adds what it can look up (the task's key, the default branch, the project's cycle)
// so the message says where to make the change and what still works here. With --json the problem
// is printed as the server sent it. The same hook prints an OPEN_ITEMS refusal (M6) with the flags
// that settle each open item.
import { isMirroredProblemCode, ProjectList, Task } from '@zamu/contracts';
import type { CommandContext } from './context';
import { type CliError, type MirroredContext, mirroredLines, openItemsLines } from './errors';

/** Upper-cased project key of a task reference: PAY for PAY-786.1. */
export function refPrefix(key: string): string {
  return key.trim().toUpperCase().split('-')[0] ?? '';
}

/**
 * Fills in the human text of a *_MIRRORED failure from the command's target. Lookups that fail
 * leave their part out: the error itself is what matters.
 */
export async function describeFailure(context: CommandContext, failure: CliError): Promise<void> {
  if (context.json) return;
  if (failure.problem.code === 'OPEN_ITEMS') {
    const key = context.target?.task?.key.trim().toUpperCase();
    failure.lines = openItemsLines(failure.problem, {
      ...(key ? { taskKey: key } : {}),
      ...(context.target?.status ? { status: context.target.status } : {}),
    });
    return;
  }
  if (!isMirroredProblemCode(failure.problem.code)) return;
  const extra: MirroredContext = {};
  let projectKey = context.target?.project;
  try {
    const client = await context.client();
    const ref = context.target?.task;
    if (ref) {
      const task = Task.parse(await client.tasks.get(ref));
      extra.taskKey = task.key;
      projectKey = task.project.key;
    }
    if (projectKey) {
      const key = projectKey.trim().toUpperCase();
      const project = ProjectList.parse(await client.projects.list()).items.find((item) => item.key === key);
      if (project) {
        extra.branch = project.backlog?.defaultBranch ?? null;
        extra.usesCycles = project.usesCycles;
        extra.cycle = project.currentCycle?.number ?? null;
      }
    }
  } catch {
    // Keep what was found so far.
  }
  if (!extra.taskKey && context.target?.task) extra.taskKey = context.target.task.key.trim().toUpperCase();
  failure.lines = mirroredLines(failure.problem, extra);
}
