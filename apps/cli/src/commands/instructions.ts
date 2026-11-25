// zamu instructions [topic] (M6): prints a guide bundled with the CLI. It needs no server and no
// credentials, so an agent can read it before anything else.
import { CLI_INSTRUCTION_TOPICS, CliInstructionTopic } from '@zamu/contracts';
import { type CommandContext, emit } from '../context';
import { usageError } from '../errors';
import { INSTRUCTIONS } from '../instructions';

export function instructions(context: CommandContext, topic: string | undefined): void {
  const parsed = CliInstructionTopic.safeParse((topic ?? 'overview').trim().toLowerCase());
  if (!parsed.success) {
    throw usageError(`No guide named "${topic}".`, undefined, [
      `Guides: ${CLI_INSTRUCTION_TOPICS.join(', ')}`,
    ]);
  }
  emit(context, 'instructions', { topic: parsed.data, text: INSTRUCTIONS[parsed.data] }, (data) => data.text);
}
