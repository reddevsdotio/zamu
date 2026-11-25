// The Zamu block of a task file: data Backlog.md has no field for, kept as YAML between
// `<!-- zamu:start -->` and `<!-- zamu:end -->` at the end of the file (inside a yaml code fence, so
// Markdown viewers show it as code). An export writes it, the reader takes it out of the body before
// the sections are split, and an import applies it. Backlog.md itself keeps the block when it edits
// the file: it inserts its own sections above it. In M6 it holds waived criteria and done items.
import { dump } from 'js-yaml';
import { fenceMask } from './sections';
import type { ParseWarning, ZamuBlock, ZamuWaiver } from './types';
import { isRecord, loadYaml } from './yaml';

export const ZAMU_BLOCK_START = '<!-- zamu:start -->';
export const ZAMU_BLOCK_END = '<!-- zamu:end -->';

const FENCE_OPEN = /^```(?:ya?ml)?[\t ]*$/i;
const FENCE_CLOSE = /^```[\t ]*$/;

function readWaiver(value: unknown): ZamuWaiver | null {
  if (!isRecord(value)) return null;
  const { kind, number, text, reason } = value;
  if (kind !== 'criterion' && kind !== 'done') return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  if (typeof reason !== 'string' || !reason.trim()) return null;
  return {
    kind,
    number,
    text: typeof text === 'string' ? text.trim() : null,
    reason: reason.replace(/\s+/g, ' ').trim(),
  };
}

/** Reads the YAML between the markers (an optional yaml fence around it is dropped). */
export function parseZamuBlock(
  content: string,
): { ok: true; block: ZamuBlock } | { ok: false; reason: string } {
  const lines = content.split('\n');
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  if (lines.length >= 2 && FENCE_OPEN.test(lines[0] ?? '') && FENCE_CLOSE.test(lines.at(-1) ?? '')) {
    lines.shift();
    lines.pop();
  }
  const loaded = loadYaml(lines.join('\n'));
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  if (loaded.value === null || loaded.value === undefined) return { ok: true, block: emptyZamuBlock() };
  if (!isRecord(loaded.value)) return { ok: false, reason: 'the block is not a YAML mapping' };
  const { waived, ...other } = loaded.value;
  const list = Array.isArray(waived) ? waived : [];
  return {
    ok: true,
    block: { waived: list.map(readWaiver).filter((entry) => entry !== null), other },
  };
}

export function emptyZamuBlock(): ZamuBlock {
  return { waived: [], other: {} };
}

/**
 * Takes the last Zamu block (markers outside code fences) out of a task body. Returns the body
 * without it and the block, or null when there is none. A block whose YAML does not parse is still
 * removed, with a warning, so it never shows up in the description.
 */
export function extractZamuBlock(
  body: string,
  warnings: ParseWarning[] = [],
): { body: string; block: ZamuBlock | null } {
  const lines = body.split('\n');
  const mask = fenceMask(lines);
  let start = -1;
  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (mask[index] || lines[index]?.trim() !== ZAMU_BLOCK_START) continue;
    const close = lines.findIndex((line, at) => at > index && !mask[at] && line.trim() === ZAMU_BLOCK_END);
    if (close === -1) continue;
    start = index;
    end = close;
    break;
  }
  if (start === -1) return { body, block: null };
  const parsed = parseZamuBlock(lines.slice(start + 1, end).join('\n'));
  if (!parsed.ok) {
    warnings.push({
      code: 'invalid_zamu_block',
      message: `the Zamu block is not valid YAML (${parsed.reason}); it was left out`,
      field: 'zamu',
    });
  }
  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
  return { body: rest, block: parsed.ok ? parsed.block : emptyZamuBlock() };
}

/** True when the block has nothing to say (no file needs it). */
export function isEmptyZamuBlock(block: ZamuBlock): boolean {
  return block.waived.length === 0 && Object.keys(block.other).length === 0;
}

/** The block as written at the end of a task file, markers included, without a final newline. */
export function renderZamuBlock(block: ZamuBlock): string {
  const data: Record<string, unknown> = { ...block.other };
  if (block.waived.length > 0) {
    data.waived = block.waived.map((waiver) => ({
      kind: waiver.kind,
      number: waiver.number,
      ...(waiver.text !== null ? { text: waiver.text } : {}),
      reason: waiver.reason,
    }));
  }
  const yaml = dump(data, { lineWidth: -1, noRefs: true }).trimEnd();
  return [ZAMU_BLOCK_START, '```yaml', yaml, '```', ZAMU_BLOCK_END].join('\n');
}
