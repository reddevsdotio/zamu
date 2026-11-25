// zamu queue and zamu queue drop ID (M6): the writes waiting in the offline queue, and removing one
// that should not be sent. Both work on the local file only and never contact the server.
import type { CliQueueEntry } from '@zamu/contracts';
import { type CommandContext, emit } from '../context';
import { notFoundError } from '../errors';
import { formatTime, table } from '../format';
import { dropQueued, listQueue, queuePath } from '../queue';

export async function showQueue(context: CommandContext): Promise<void> {
  const items = await listQueue(context.io);
  emit(context, 'queue.list', { items }, (data) => {
    if (data.items.length === 0) return 'Nothing queued.\n';
    const servers = new Set(data.items.map((entry) => entry.url));
    const count = data.items.length === 1 ? '1 write waits' : `${data.items.length} writes wait`;
    const head = `${count} for the server; the next zamu command that reaches it sends them, oldest first.\n`;
    return `${head}\n${table<CliQueueEntry>(
      data.items,
      [
        { header: 'ID', value: (entry) => entry.id },
        { header: 'QUEUED', value: (entry) => formatTime(entry.queuedAt) },
        ...(servers.size > 1 ? [{ header: 'SERVER', value: (entry: CliQueueEntry) => entry.url }] : []),
        { header: 'TASK', value: (entry) => entry.taskKey },
        { header: 'WRITE', value: (entry) => entry.summary },
      ],
      context.style,
      context.io.isTTY ? context.io.columns : undefined,
    )}`;
  });
}

export async function dropQueueEntry(context: CommandContext, id: string): Promise<void> {
  const dropped = await dropQueued(context.io, id);
  if (!dropped) {
    throw notFoundError(`Nothing queued with id ${id.trim()}.`, [
      `zamu queue lists the queued writes (${queuePath(context.io)}).`,
    ]);
  }
  emit(
    context,
    'queue.drop',
    { dropped },
    (data) =>
      `Dropped ${data.dropped.id}: ${data.dropped.taskKey} ${data.dropped.summary}. It won't be sent.\n`,
  );
}
