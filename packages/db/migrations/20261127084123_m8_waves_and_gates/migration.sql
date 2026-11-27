CREATE TABLE "gate_result" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"state" text NOT NULL,
	"note" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"on_behalf_of_id" uuid,
	"machine" text,
	"branch" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_result_state_check" CHECK ("state" in ('passed', 'failed')),
	CONSTRAINT "gate_result_note_check" CHECK (char_length("note") between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "wave" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"gate_description" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wave_position_check" CHECK ("position" >= 1),
	CONSTRAINT "wave_name_check" CHECK (char_length("name") between 1 and 100 and "name" !~ '[\r\n]'),
	CONSTRAINT "wave_gate_description_check" CHECK (char_length("gate_description") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "milestone" ADD COLUMN "plan_url" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "wave_id" uuid;--> statement-breakpoint
CREATE INDEX "task_waveId_idx" ON "task" ("wave_id") WHERE "wave_id" is not null;--> statement-breakpoint
CREATE INDEX "gate_result_waveId_createdAt_idx" ON "gate_result" ("wave_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "wave_milestoneId_name_unique" ON "wave" ("milestone_id",lower("name"));--> statement-breakpoint
CREATE INDEX "wave_milestoneId_position_idx" ON "wave" ("milestone_id","position");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_wave_id_wave_id_fkey" FOREIGN KEY ("wave_id") REFERENCES "wave"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "gate_result" ADD CONSTRAINT "gate_result_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gate_result" ADD CONSTRAINT "gate_result_wave_id_wave_id_fkey" FOREIGN KEY ("wave_id") REFERENCES "wave"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gate_result" ADD CONSTRAINT "gate_result_actor_id_user_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "gate_result" ADD CONSTRAINT "gate_result_on_behalf_of_id_user_id_fkey" FOREIGN KEY ("on_behalf_of_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "wave" ADD CONSTRAINT "wave_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wave" ADD CONSTRAINT "wave_milestone_id_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestone"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wave" ADD CONSTRAINT "wave_created_by_id_user_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_plan_url_check" CHECK (char_length("plan_url") between 1 and 2000 and "plan_url" !~ '[\r\n]');