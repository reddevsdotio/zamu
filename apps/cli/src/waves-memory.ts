// What zamu last saw of each milestone's waves (M8), so `zamu tasks update KEY --wave W3` can still
// be queued when the server doesn't answer: the wave number or name has to become a wave id, and the
// server can't be asked. Every plan the server returns (zamu milestones show, zamu waves put) is
// remembered per server and workspace in waves.json next to the queue, with the milestone each task
// was in; tasks the server returns add their milestone. Best effort, like the remembered statuses: a
// failure here never fails a command, it only means an offline --wave by number or name isn't queued.
// The server checks the wave again when the queued write is sent, lock rule included.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stateDir, withLock, writeAtomically } from './files';
import type { CliIo } from './io';

const FILE_NAME = 'waves.json';
/** Milestones and tasks kept per server and workspace (the most recent ones). */
const MAX_MILESTONES = 200;
const MAX_TASKS = 2_000;

const RememberedWave = z.object({ id: z.string(), number: z.number().int(), name: z.string() });
export type RememberedWave = z.output<typeof RememberedWave>;

const RememberedMilestone = z.object({
  name: z.string(),
  project: z.string(),
  waves: z.array(RememberedWave),
  at: z.string(),
});
export type RememberedMilestone = z.output<typeof RememberedMilestone>;

const Bucket = z.object({
  milestones: z.record(z.string(), RememberedMilestone),
  /** Task key (upper case) to the id of its milestone, null when it has none. */
  tasks: z.record(z.string(), z.object({ milestone: z.string().nullable(), at: z.string() })),
});
type Bucket = z.output<typeof Bucket>;

const WavesFile = z.object({ version: z.literal(1), servers: z.record(z.string(), Bucket) });
type WavesFile = z.output<typeof WavesFile>;

type Io = Pick<CliIo, 'env' | 'homeDir'>;

function wavesPath(io: Io): string {
  return join(stateDir(io), FILE_NAME);
}

async function readWaves(io: Io): Promise<WavesFile> {
  const text = await readFile(wavesPath(io), 'utf8').catch(() => null);
  if (text !== null) {
    try {
      const parsed = WavesFile.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Unreadable: start again.
    }
  }
  return { version: 1, servers: {} };
}

/** What a result says about milestones and their waves, and the milestone of each task. */
interface Seen {
  milestones: Record<string, Omit<RememberedMilestone, 'at'>>;
  tasks: Record<string, string | null>;
}

const PlanShape = z.object({
  milestone: z.object({ id: z.string(), name: z.string(), project: z.object({ key: z.string() }) }),
  waves: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      name: z.string(),
      tasks: z.array(z.object({ key: z.string() })),
    }),
  ),
  notInWave: z.array(z.object({ key: z.string() })),
});

const TaskShape = z.object({
  key: z.string(),
  milestone: z.object({ id: z.string() }).nullable().optional(),
});

function seenIn(procedure: string, result: unknown): Seen | null {
  if (procedure === 'milestones.plan' || procedure === 'waves.putTasks') {
    const plan = PlanShape.safeParse(result);
    if (!plan.success) return null;
    const { milestone, waves, notInWave } = plan.data;
    const tasks: Record<string, string> = {};
    for (const task of [...waves.flatMap((wave) => wave.tasks), ...notInWave]) {
      tasks[task.key.toUpperCase()] = milestone.id;
    }
    return {
      milestones: {
        [milestone.id]: {
          name: milestone.name,
          project: milestone.project.key,
          waves: waves.map(({ id, number, name }) => ({ id, number, name })),
        },
      },
      tasks,
    };
  }
  if (procedure === 'tasks.get' || procedure === 'tasks.update' || procedure === 'tasks.create') {
    const task = TaskShape.safeParse(result);
    if (!task.success) return null;
    return { milestones: {}, tasks: { [task.data.key.toUpperCase()]: task.data.milestone?.id ?? null } };
  }
  return null;
}

function newest<T extends { at: string }>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, max));
}

/** Remembers the milestones, waves and task milestones in a result. Never throws. */
export async function rememberWaves(
  io: CliIo,
  bucket: string,
  procedure: string,
  result: unknown,
): Promise<void> {
  const seen = seenIn(procedure, result);
  if (!seen) return;
  const path = wavesPath(io);
  try {
    await withLock(
      path,
      async () => {
        const file = await readWaves(io);
        const current: Bucket = file.servers[bucket] ?? { milestones: {}, tasks: {} };
        const at = new Date(io.now?.() ?? Date.now()).toISOString();
        let changed = false;
        const milestones = { ...current.milestones };
        for (const [id, milestone] of Object.entries(seen.milestones)) {
          milestones[id] = { ...milestone, at };
          changed = true;
        }
        const tasks = { ...current.tasks };
        for (const [key, milestone] of Object.entries(seen.tasks)) {
          if (tasks[key]?.milestone === milestone) continue;
          if (!tasks[key] && milestone === null) continue;
          tasks[key] = { milestone, at };
          changed = true;
        }
        if (!changed) return;
        await writeAtomically(path, {
          ...file,
          servers: {
            ...file.servers,
            [bucket]: { milestones: newest(milestones, MAX_MILESTONES), tasks: newest(tasks, MAX_TASKS) },
          },
        });
      },
      { waitMs: 2_000 },
    );
  } catch {
    // See the module comment.
  }
}

/** The milestones and task milestones remembered for a server and workspace. */
export async function rememberedWaves(io: Io, bucket: string): Promise<Bucket> {
  return (await readWaves(io)).servers[bucket] ?? { milestones: {}, tasks: {} };
}
