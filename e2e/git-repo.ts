// A throwaway local git repository for the specs that run zamu inside a clone: the CLI sends the branch checked
// out there with every request, and `zamu backlog export` writes into it. Commits use a fixed author, so the
// runner needs no git identity of its own.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const identity = {
  GIT_AUTHOR_NAME: 'Zamu e2e',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'Zamu e2e',
  GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

export interface GitRepo {
  /** Absolute path of the working tree. */
  dir: string;
  /** Runs git in the working tree and returns its stdout. */
  git(args: string[]): string;
  /** Writes files (paths relative to the root, forward slashes) and commits them. */
  commit(message: string, files: Record<string, string>): void;
  /** Removes the working tree. */
  remove(): void;
}

/** A new repository with one empty commit on `branch`. */
export function createGitRepo(branch: string): GitRepo {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-e2e-repo-'));
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: '1' },
    });
  git(['init', '--quiet', '--initial-branch', branch]);
  git(['commit', '--quiet', '--allow-empty', '-m', 'Start']);
  return {
    dir,
    git,
    commit(message, files) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, ...path.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git(['add', '--', ...Object.keys(files)]);
      git(['commit', '--quiet', '-m', message]);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
