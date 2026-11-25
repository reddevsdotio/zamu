// zamu notes add (M6): a work note on a task, written while working ("Migration written and
// tested"). A note is a comment of kind note: it shows quietly in the timeline and notifies only the
// people it mentions. zamu tasks update --append-notes writes one the same way.
import { type Comment, CreateCommentInput } from '@zamu/contracts';
import type { ApiClient } from '../client';
import { type CommandContext, emit } from '../context';
import { commentBlock } from '../format';
import { parseInput, readText, type TaskRef, taskRef, withTaskRef } from './shared';

/** Posts a note on the task the reference names. */
export async function postNote(
  context: CommandContext,
  client: ApiClient,
  ref: TaskRef,
  body: string,
): Promise<Comment> {
  return withTaskRef(context, ref, (r) =>
    client.comments.create(parseInput(CreateCommentInput, { ...r, body, kind: 'note' })),
  );
}

/** "Added note <id> on PAY-142" and the note as stored. */
export function noteSummary(context: CommandContext, note: Comment): string {
  const { style } = context;
  const head = `Added note ${style.bold(note.id)} on ${style.bold(note.taskKey)}`;
  return `${head}\n\n${commentBlock(note, style)}\n`;
}

export async function addNote(
  context: CommandContext,
  key: string,
  body: string,
  options: { project?: string } = {},
): Promise<void> {
  const ref = await taskRef(context, key, options.project);
  const text = await readText(context, body);
  parseInput(CreateCommentInput, { ...ref, body: text, kind: 'note' });
  const client = await context.client();
  const note = await postNote(context, client, ref, text);
  emit(context, 'notes.add', note, (data) => noteSummary(context, data));
}
