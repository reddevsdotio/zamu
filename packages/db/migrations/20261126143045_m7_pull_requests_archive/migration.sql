CREATE TABLE "pull_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"author" text,
	"merged_by" text,
	"web_url" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"host_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_projectId_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "pull_request_number_check" CHECK ("number" >= 1),
	CONSTRAINT "pull_request_state_check" CHECK ("state" in ('open', 'draft', 'merged', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "repository_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_key" text NOT NULL,
	"connection_id" uuid,
	"default_branch" text,
	"close_on_merge" boolean DEFAULT true NOT NULL,
	"webhook_id" text NOT NULL,
	"webhook_secret_ciphertext" text,
	"webhook_last_at" timestamp with time zone,
	"webhook_last_status" text,
	"synced_at" timestamp with time zone,
	"sync_cursor" timestamp with time zone,
	"sync_error" text,
	"moves_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_link_webhook_last_status_check" CHECK ("webhook_last_status" in ('ok', 'bad_signature', 'bad_payload'))
);
--> statement-breakpoint
CREATE TABLE "task_pull_request" (
	"task_id" uuid,
	"pull_request_id" uuid,
	"via_branch" boolean DEFAULT false NOT NULL,
	"via_description" boolean DEFAULT false NOT NULL,
	"via_hand" boolean DEFAULT false NOT NULL,
	"linked_by_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_pull_request_pkey" PRIMARY KEY("task_id","pull_request_id"),
	CONSTRAINT "task_pull_request_removed_check" CHECK ("removed_at" is not null or "removed_by_id" is null)
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "cause" jsonb;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "archive_after_days" smallint;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "work_branch" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "archived_by_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "merged_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "check_again_on" date;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "check_again_reason" text;--> statement-breakpoint
CREATE INDEX "task_projectId_status_closedAt_idx" ON "task" ("project_id","status","closed_at") WHERE "archived_at" is null and "status" in ('done', 'canceled');--> statement-breakpoint
CREATE INDEX "task_assigneeId_checkAgainOn_idx" ON "task" ("assignee_id","check_again_on") WHERE "check_again_on" is not null;--> statement-breakpoint
CREATE INDEX "task_projectId_mergedDone_idx" ON "task" ("project_id") WHERE "merged_done_at" is not null;--> statement-breakpoint
CREATE INDEX "task_projectId_workBranch_idx" ON "task" ("project_id","work_branch") WHERE "work_branch" is not null;--> statement-breakpoint
CREATE INDEX "task_projectId_archived_idx" ON "task" ("project_id") WHERE "archived_at" is not null;--> statement-breakpoint
CREATE INDEX "pull_request_projectId_headBranch_idx" ON "pull_request" ("project_id","head_branch");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_link_projectId_unique" ON "repository_link" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_link_webhookId_unique" ON "repository_link" ("webhook_id");--> statement-breakpoint
CREATE INDEX "repository_link_connectionId_idx" ON "repository_link" ("connection_id");--> statement-breakpoint
CREATE INDEX "task_pull_request_pullRequestId_idx" ON "task_pull_request" ("pull_request_id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_archived_by_id_user_id_fkey" FOREIGN KEY ("archived_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_link" ADD CONSTRAINT "repository_link_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_link" ADD CONSTRAINT "repository_link_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_link" ADD CONSTRAINT "repository_link_connection_id_git_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "git_connection"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_pull_request_id_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_request"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_linked_by_id_user_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task_pull_request" ADD CONSTRAINT "task_pull_request_removed_by_id_user_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_archive_after_days_check" CHECK ("archive_after_days" between 1 and 365);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_work_branch_check" CHECK (char_length("work_branch") between 1 and 255);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_archived_check" CHECK ("archived_at" is not null or "archived_by_id" is null);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_check_again_check" CHECK (("check_again_on" is null and "check_again_reason" is null) or ("check_again_on" is not null and "check_again_reason" is not null and char_length("check_again_reason") between 1 and 200));--> statement-breakpoint
ALTER TABLE "activity" DROP CONSTRAINT "activity_origin_check", ADD CONSTRAINT "activity_origin_check" CHECK ("origin" in ('app', 'backlog', 'git'));--> statement-breakpoint
-- Backfill (hand-written): when each Done or Canceled task closed. The time of the latest activity
-- row that set the status to the task's current value (a creation in that status counts), else the
-- task's updated_at. Open tasks stay null. No activity rows and no updated_at change.
UPDATE "task" t SET "closed_at" = coalesce(
  (
    SELECT max(a."created_at") FROM "activity" a
    WHERE a."task_id" = t."id"
      AND jsonb_typeof(a."changes") = 'array'
      AND a."changes" @> jsonb_build_array(jsonb_build_object('field', 'status', 'to', t."status"::text))
  ),
  t."updated_at"
)
WHERE t."status" IN ('done', 'canceled') AND t."closed_at" IS NULL;--> statement-breakpoint
-- Backfill (hand-written): tasks of a project that mirrors Backlog.md (mode mirror, not detached)
-- whose file sits in the archive folder (backlog_data.kind archived) start archived, by no one, at
-- their updated_at. The next refresh keeps them archived. Imported and detached projects are left
-- alone: their tasks are Zamu's, and the nightly job archives them once the project turns it on.
UPDATE "task" t SET "archived_at" = t."updated_at"
FROM "backlog_source" s
WHERE s."project_id" = t."project_id"
  AND s."mode" = 'mirror'
  AND s."state" <> 'detached'
  AND jsonb_typeof(t."backlog_data") = 'object'
  AND t."backlog_data"->>'kind' = 'archived'
  AND t."archived_at" IS NULL;
