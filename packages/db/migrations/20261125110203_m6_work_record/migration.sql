CREATE TABLE "task_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"waived_reason" text,
	"waived_by_id" uuid,
	"source" text DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_item_taskId_kind_position_unique" UNIQUE("task_id","kind","position") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "task_item_kind_check" CHECK ("kind" in ('criterion', 'done')),
	CONSTRAINT "task_item_state_check" CHECK ("state" in ('open', 'checked', 'waived')),
	CONSTRAINT "task_item_source_check" CHECK ("source" in ('app', 'backlog')),
	CONSTRAINT "task_item_position_check" CHECK ("position" >= 1),
	CONSTRAINT "task_item_text_check" CHECK ("text" <> '' and "text" !~ '[\r\n]'),
	CONSTRAINT "task_item_waived_check" CHECK (("state" = 'waived') = ("waived_reason" is not null) and ("state" = 'waived' or "waived_by_id" is null))
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "machine" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "kind" text DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "machine" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_done_items" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "final_summary" text;--> statement-breakpoint
ALTER TABLE "task_item" ADD CONSTRAINT "task_item_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_item" ADD CONSTRAINT "task_item_waived_by_id_user_id_fkey" FOREIGN KEY ("waived_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_kind_check" CHECK ("kind" in ('comment', 'note'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_done_items_check" CHECK (jsonb_typeof("default_done_items") = 'array');--> statement-breakpoint
-- M6 data migration: moves the work record of every task that came from Backlog.md (task.backlog_data
-- set: mirrors, detached mirrors and imports, hidden tasks included) out of its description, with no
-- activity rows and no updated_at change. Until M6 a refresh rendered the file's sections into the
-- description under fixed headings (renderDescription in packages/backlog-md): the Description
-- section, then "## Acceptance criteria", "## Definition of done", "## Implementation plan",
-- "## Implementation notes", "## Comments from Backlog.md" and "## Final summary". Headings inside
-- code fences are content. The backfill reads those sections back:
--   criteria    each "- [ ] text" / "- [x] #n text" line of Acceptance criteria (outside fences)
--               becomes a task_item of kind criterion, numbered 1.. in file order; [x] is checked.
--   done items  the same for Definition of done, kind done.
--   plan        Implementation plan -> task.plan.
--   summary     Final summary -> task.final_summary.
--   notes       Implementation notes -> backlog_data.implementationNotes (read-only block).
--   description keeps the Description section, the other lines of the two checklist sections under
--               their headings, and Comments from Backlog.md, joined by blank lines; null when empty.
-- Items take source backlog while the project mirrors (mode mirror, not detached), app otherwise.
-- Text is trimmed; empty items are left out. The refresh writes the same values from the files, so
-- the next refresh of unchanged files reports no change.
DO $$
DECLARE
  task_row record;
  lines text[];
  line text;
  fence_char text;
  fence_len integer;
  in_fence boolean;
  opening text[];
  item text[];
  item_text text;
  section text;
  item_source text;
  criterion_count integer;
  done_count integer;
  desc_lines text[];
  ac_lines text[];
  dod_lines text[];
  plan_lines text[];
  notes_lines text[];
  comment_lines text[];
  summary_lines text[];
  parts text[];
  chunk text;
  new_plan text;
  new_summary text;
  new_notes text;
  new_description text;
BEGIN
  FOR task_row IN
    SELECT t.id, t.description, t.backlog_data,
      CASE WHEN s.mode = 'mirror' AND s.state <> 'detached' THEN 'backlog' ELSE 'app' END AS source
    FROM task t
    LEFT JOIN backlog_source s ON s.project_id = t.project_id
    WHERE jsonb_typeof(t.backlog_data) = 'object'
      AND t.description ~ '(^|\n)## (Acceptance criteria|Definition of done|Implementation plan|Implementation notes|Final summary)\r?(\n|$)'
    ORDER BY t.id
  LOOP
    lines := regexp_split_to_array(task_row.description, '\r?\n');
    item_source := task_row.source;
    fence_char := NULL;
    fence_len := 0;
    section := 'description';
    criterion_count := 0;
    done_count := 0;
    desc_lines := '{}';
    ac_lines := '{}';
    dod_lines := '{}';
    plan_lines := '{}';
    notes_lines := '{}';
    comment_lines := '{}';
    summary_lines := '{}';

    FOREACH line IN ARRAY lines LOOP
      -- Code fences, with the rules of the Backlog.md parser: a fence closes on the same character,
      -- at least as long, with nothing after it; a backtick fence whose info string has a backtick
      -- is not a fence.
      opening := regexp_match(line, '^ {0,3}(`{3,}|~{3,})(.*)$');
      IF fence_char IS NOT NULL THEN
        in_fence := true;
        IF opening IS NOT NULL AND left(opening[1], 1) = fence_char AND length(opening[1]) >= fence_len
          AND btrim(opening[2], E' \t') = '' THEN
          fence_char := NULL;
        END IF;
      ELSIF opening IS NOT NULL AND NOT (left(opening[1], 1) = '`' AND position('`' IN opening[2]) > 0) THEN
        fence_char := left(opening[1], 1);
        fence_len := length(opening[1]);
        in_fence := true;
      ELSE
        in_fence := false;
      END IF;

      IF NOT in_fence THEN
        CASE line
          WHEN '## Acceptance criteria' THEN section := 'ac'; CONTINUE;
          WHEN '## Definition of done' THEN section := 'dod'; CONTINUE;
          WHEN '## Implementation plan' THEN section := 'plan'; CONTINUE;
          WHEN '## Implementation notes' THEN section := 'notes'; CONTINUE;
          WHEN '## Comments from Backlog.md' THEN section := 'comments'; CONTINUE;
          WHEN '## Final summary' THEN section := 'summary'; CONTINUE;
          ELSE NULL;
        END CASE;
      END IF;

      IF section IN ('ac', 'dod') AND NOT in_fence THEN
        item := regexp_match(line, '^- \[([ xX])\] (?:#([0-9]+) )?(.+)$');
        IF item IS NOT NULL THEN
          item_text := regexp_replace(item[3], '^\s+|\s+$', '', 'g');
          IF item_text <> '' THEN
            IF section = 'ac' THEN
              criterion_count := criterion_count + 1;
            ELSE
              done_count := done_count + 1;
            END IF;
            INSERT INTO task_item (task_id, kind, position, text, state, source)
            VALUES (
              task_row.id,
              CASE WHEN section = 'ac' THEN 'criterion' ELSE 'done' END,
              CASE WHEN section = 'ac' THEN criterion_count ELSE done_count END,
              item_text,
              CASE WHEN item[1] = ' ' THEN 'open' ELSE 'checked' END,
              item_source
            );
          END IF;
          CONTINUE;
        END IF;
      END IF;

      CASE section
        WHEN 'description' THEN desc_lines := array_append(desc_lines, line);
        WHEN 'ac' THEN ac_lines := array_append(ac_lines, line);
        WHEN 'dod' THEN dod_lines := array_append(dod_lines, line);
        WHEN 'plan' THEN plan_lines := array_append(plan_lines, line);
        WHEN 'notes' THEN notes_lines := array_append(notes_lines, line);
        WHEN 'comments' THEN comment_lines := array_append(comment_lines, line);
        ELSE summary_lines := array_append(summary_lines, line);
      END CASE;
    END LOOP;

    new_plan := nullif(regexp_replace(array_to_string(plan_lines, E'\n'), '^\s+|\s+$', '', 'g'), '');
    new_summary := nullif(regexp_replace(array_to_string(summary_lines, E'\n'), '^\s+|\s+$', '', 'g'), '');
    new_notes := nullif(regexp_replace(array_to_string(notes_lines, E'\n'), '^\s+|\s+$', '', 'g'), '');

    parts := '{}';
    chunk := regexp_replace(array_to_string(desc_lines, E'\n'), '^\s+|\s+$', '', 'g');
    IF chunk <> '' THEN parts := array_append(parts, chunk); END IF;
    chunk := regexp_replace(array_to_string(ac_lines, E'\n'), '^\s+|\s+$', '', 'g');
    IF chunk <> '' THEN parts := array_append(parts, E'## Acceptance criteria\n\n' || chunk); END IF;
    chunk := regexp_replace(array_to_string(dod_lines, E'\n'), '^\s+|\s+$', '', 'g');
    IF chunk <> '' THEN parts := array_append(parts, E'## Definition of done\n\n' || chunk); END IF;
    chunk := regexp_replace(array_to_string(comment_lines, E'\n'), '^\s+|\s+$', '', 'g');
    IF chunk <> '' THEN parts := array_append(parts, E'## Comments from Backlog.md\n\n' || chunk); END IF;
    new_description := nullif(array_to_string(parts, E'\n\n'), '');

    UPDATE task SET
      description = new_description,
      plan = new_plan,
      final_summary = new_summary,
      backlog_data = CASE
        WHEN new_notes IS NULL THEN backlog_data
        ELSE backlog_data || jsonb_build_object('implementationNotes', new_notes)
      END
    WHERE id = task_row.id;
  END LOOP;
END
$$;
