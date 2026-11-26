// Runs a background job in a stack's worker container right away, and reads the stack's database, for the
// specs that can't wait for a schedule: the nightly archive (tasks.archive-due at 02:30) takes a `now` in its
// payload, so a spec runs it with the clock it needs and reads the job's output.
//
// The job goes through pg-boss in the worker container (its node_modules has pg-boss, and DATABASE_URL points
// at the stack's Postgres), so the running worker picks it up and runs it like a scheduled one. The script
// sends the job, waits until pg-boss marks it completed or failed, and prints its state and output.
import { mainStack, type Stack } from './stack';

/** Sends JOB_NAME with JOB_DATA, waits up to 60 s for it to finish and prints { state, output } as JSON. */
const SEND_AND_WAIT = `
import { PgBoss } from 'pg-boss';
const name = process.env.JOB_NAME;
const data = JSON.parse(process.env.JOB_DATA ?? '{}');
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  supervise: false,
  schedule: false,
  migrate: false,
});
await boss.start();
const id = await boss.send(name, data);
const deadline = Date.now() + 60_000;
let job = null;
while (Date.now() < deadline) {
  job = await boss.getJobById(name, id);
  if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.log(JSON.stringify({ state: job?.state ?? 'missing', output: job?.output ?? null }));
await boss.stop({ graceful: false });
`;

export interface JobRun<T> {
  state: string;
  output: T;
}

/** Runs `name` with `data` on the stack's worker and returns pg-boss's state and the handler's output. */
export function runJob<T = unknown>(
  name: string,
  data: Record<string, unknown> = {},
  stack: Pick<Stack, 'compose'> = mainStack,
): JobRun<T> {
  const output = stack.compose(
    [
      'exec',
      '-T',
      '-w',
      '/app/worker',
      '-e',
      `JOB_NAME=${name}`,
      '-e',
      `JOB_DATA=${JSON.stringify(data)}`,
      'worker',
      'node',
      '--input-type=module',
      '--eval',
      SEND_AND_WAIT,
    ],
    { quiet: true },
  );
  const line = output.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as JobRun<T>;
}

/** Runs one SQL statement in the stack's Postgres and returns its rows, tab-separated, one per line. */
export function sql(query: string, stack: Pick<Stack, 'compose'> = mainStack): string[] {
  const output = stack.compose(
    ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'zamu', '-tA', '-F', '\t', '-c', query],
    { quiet: true },
  );
  return output.split('\n').filter((line) => line.trim() !== '');
}
