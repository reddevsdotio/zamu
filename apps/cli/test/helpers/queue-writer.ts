// Runs zamu notes add COUNT times against a server that never answers, so each note is queued. The
// offline queue test starts two of these at once to check that two processes never lose an entry.
// Usage: node --import tsx queue-writer.ts <count> <label>; HOME and XDG_STATE_HOME pick the queue.
import type { CliIo } from '../../src/io';
import { main } from '../../src/main';

const [count = '1', label = 'writer'] = process.argv.slice(2);

const io: CliIo = {
  stdout: () => {},
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => '',
  env: {
    ZAMU_URL: 'http://zamu.test',
    ZAMU_KEY: 'zamu_live_test',
    ZAMU_MACHINE: 'writer',
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  },
  homeDir: process.env.HOME ?? '/',
  cwd: process.env.HOME ?? '/',
  isTTY: false,
  fetch: () => Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })),
};

for (let i = 0; i < Number(count); i++) {
  const code = await main(['notes', 'add', 'PAY-1', `${label} ${i}`], io);
  if (code !== 7) {
    process.stderr.write(`notes add exited ${code}\n`);
    process.exit(1);
  }
}
