// The files zamu keeps for itself and how they are written. Several zamu processes run at once on one
// machine (sub-agents), so a change to a shared file happens under a lock file and lands through a
// temporary file renamed over the old one: a reader never sees half a file and no writer loses
// another's change. The offline queue, the remembered statuses, the clone cache and the config use it.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { CLI_QUEUE_DIR } from '@zamu/contracts';
import type { CliIo } from './io';

export type FileIo = Pick<CliIo, 'env' | 'homeDir'>;

/** A lock older than this was left by a process that died; it is removed. */
export const LOCK_STALE_MS = 30_000;
/** How long a command waits for another zamu process to finish with a file. */
const LOCK_WAIT_MS = 40_000;

/** $XDG_STATE_HOME/zamu, else ~/.local/state/zamu. Relative XDG values are ignored, as the spec says. */
export function stateDir(io: FileIo): string {
  const xdg = io.env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(io.homeDir, '.local', 'state');
  return join(base, CLI_QUEUE_DIR);
}

/** Another zamu process held the lock for longer than a command waits. */
export class FileLockedError extends Error {
  constructor(
    readonly lockPath: string,
    what = 'the offline queue',
  ) {
    super(`Another zamu process is using ${what} (lock file ${lockPath}).`);
    this.name = 'QueueLockedError';
  }
}

export interface LockOptions {
  staleMs?: number;
  waitMs?: number;
  /** Names the file in the error when the wait runs out. */
  what?: string;
}

export interface Lock {
  /** Marks the lock as alive, for holders that work longer than a moment (the replay). */
  touch: () => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` holding `<path>.lock`, created exclusively. A lock whose file hasn't changed for
 * `staleMs` belonged to a process that died and is taken over. Gives up after `waitMs`.
 */
export async function withLock<T>(
  path: string,
  work: (lock: Lock) => Promise<T>,
  { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, what }: LockOptions = {},
): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const started = Date.now();
  let delay = 5;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const age = await stat(lockPath).then(
      (info) => Date.now() - info.mtimeMs,
      () => null,
    );
    if (age === null) continue;
    if (age > staleMs) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() - started > waitMs) throw new FileLockedError(lockPath, what);
    await pause(delay + Math.random() * delay);
    delay = Math.min(delay * 2, 100);
  }
  try {
    return await work({
      touch: async () => {
        const now = new Date();
        await utimes(lockPath, now, now).catch(() => {});
      },
    });
  } finally {
    // Only our own lock: one taken over as stale by another process stays theirs.
    const current = await readFile(lockPath, 'utf8').catch(() => null);
    if (current === token) await rm(lockPath, { force: true });
  }
}

/**
 * Writes JSON to `path` through a temporary file and a rename, so readers never see half a file.
 * The directory is created owner-only (0700) and the file is 0600: some of these files hold keys.
 */
export async function writeAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    // The mode option only applies when the file is created, and umask may have narrowed it anyway.
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
