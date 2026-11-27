// M8 tables: the waves of a milestone (ordered groups of its tasks, each with a gate) and the gate
// results recorded on them. A wave's number is its position; core keeps positions dense under a lock
// on the milestone row, so there is no unique index on position and a reorder is one statement. The
// gate's state is its latest result; every result is kept as evidence. task.wave_id lives in ./app.
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { milestone } from './app';
import { organization, user } from './auth';

/** Longest wave name, in characters. Names are unique per milestone ignoring case. */
export const WAVE_NAME_MAX_LENGTH = 100;
/** Longest gate description (Markdown), in characters. */
export const GATE_DESCRIPTION_MAX_LENGTH = 4_000;
/** Longest gate result note (Markdown), in characters. A note is required. */
export const GATE_NOTE_MAX_LENGTH = 10_000;

/** A recorded gate result. A gate with no result is open; there is no way back to open. */
export const GATE_RESULT_STATES = ['passed', 'failed'] as const;
export type GateResultState = (typeof GATE_RESULT_STATES)[number];

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

export const wave = pgTable(
  'wave',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Deleting a milestone deletes its waves; their tasks lose the wave (task.wave_id set null). */
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestone.id, { onDelete: 'cascade' }),
    /** 1, 2, 3 ... within the milestone, dense; shown as W1, W2. Core rewrites it on reorder and removal. */
    position: integer('position').notNull(),
    name: text('name').notNull(),
    /** Markdown: what the gate checks. Null when none was written. */
    gateDescription: text('gate_description'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('wave_milestoneId_name_unique').on(table.milestoneId, sql`lower(${table.name})`),
    index('wave_milestoneId_position_idx').on(table.milestoneId, table.position),
    check('wave_position_check', sql`${table.position} >= 1`),
    check(
      'wave_name_check',
      sql`char_length(${table.name}) between 1 and ${sql.raw(String(WAVE_NAME_MAX_LENGTH))} and ${table.name} !~ '[\\r\\n]'`,
    ),
    check(
      'wave_gate_description_check',
      sql`char_length(${table.gateDescription}) <= ${sql.raw(String(GATE_DESCRIPTION_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One recorded result of a wave's gate, kept forever (the gate's state is the newest row). The
 * actor, the person an agent acts for, and the machine and branch the CLI sent, as activity rows
 * record them.
 */
export const gateResult = pgTable(
  'gate_result',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    waveId: uuid('wave_id')
      .notNull()
      .references(() => wave.id, { onDelete: 'cascade' }),
    state: text('state', { enum: GATE_RESULT_STATES }).notNull(),
    /** Markdown: what was checked. */
    note: text('note').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The agent's responsible human; null when a person recorded it. */
    onBehalfOfId: uuid('on_behalf_of_id').references(() => user.id, { onDelete: 'restrict' }),
    /** The CLI's x-zamu-machine header; null otherwise. */
    machine: text('machine'),
    /** The CLI's x-zamu-branch header; null otherwise. */
    branch: text('branch'),
    createdAt: createdAt(),
  },
  (table) => [
    index('gate_result_waveId_createdAt_idx').on(table.waveId, table.createdAt.desc()),
    check('gate_result_state_check', sql`${table.state} in ('passed', 'failed')`),
    check(
      'gate_result_note_check',
      sql`char_length(${table.note}) between 1 and ${sql.raw(String(GATE_NOTE_MAX_LENGTH))}`,
    ),
  ],
);
