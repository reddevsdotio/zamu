CREATE TABLE "workspace_slug_alias" (
	"slug" text PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_alias_slug_check" CHECK (char_length("slug") between 2 and 40 and "slug" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_workspace_id" uuid;--> statement-breakpoint
CREATE INDEX "user_lastWorkspaceId_idx" ON "user" ("last_workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_slug_alias_workspaceId_idx" ON "workspace_slug_alias" ("workspace_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_last_workspace_id_organization_id_fkey" FOREIGN KEY ("last_workspace_id") REFERENCES "organization"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_slug_alias" ADD CONSTRAINT "workspace_slug_alias_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Backfill (hand-written): the workspace each user used last starts as their oldest membership.
UPDATE "user" SET "last_workspace_id" = (
  SELECT m."organization_id" FROM "member" m
  WHERE m."user_id" = "user"."id"
  ORDER BY m."created_at", m."id"
  LIMIT 1
)
WHERE "last_workspace_id" IS NULL;--> statement-breakpoint
-- Slug check (hand-written): workspace slugs now name workspaces in URLs, so each one must be 2 to 40
-- characters of a-z, 0-9 and single hyphens, start with a letter, not end with a hyphen, and not be a
-- reserved word (WORKSPACE_SLUG_RESERVED in @zamu/contracts). Slugs made by 0.9 setup already pass.
-- Any other slug is rewritten the way a new one is suggested, with a number appended while it is taken;
-- the old slug becomes an alias of the workspace when it fits the alias format.
DO $$
DECLARE
  reserved constant text[] := ARRAY['api', 'w', 'new', 'settings', 'admin', 'setup', 'signin', 'invite',
    'welcome', 'help', 'docs', 'static', 'assets'];
  pattern constant text := '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
  ws record;
  base text;
  candidate text;
  suffix integer;
BEGIN
  FOR ws IN SELECT "id", "slug" FROM "organization" ORDER BY "created_at", "id" LOOP
    IF char_length(ws.slug) BETWEEN 2 AND 40 AND ws.slug ~ pattern AND NOT ws.slug = ANY (reserved) THEN
      CONTINUE;
    END IF;
    base := regexp_replace(lower(ws.slug), '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '^-+|-+$', '', 'g');
    IF base = '' THEN
      base := 'workspace';
    ELSIF base !~ '^[a-z]' THEN
      base := 'w-' || base;
    END IF;
    base := regexp_replace(left(base, 40), '-+$', '');
    IF char_length(base) < 2 OR base = ANY (reserved) THEN
      base := left(base, 30) || '-workspace';
    END IF;
    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM "organization" WHERE "slug" = candidate AND "id" <> ws.id)
      OR EXISTS (SELECT 1 FROM "workspace_slug_alias" WHERE "slug" = candidate) LOOP
      suffix := suffix + 1;
      candidate := regexp_replace(left(base, 40 - char_length(suffix::text) - 1), '-+$', '') || '-' || suffix;
    END LOOP;
    UPDATE "organization" SET "slug" = candidate WHERE "id" = ws.id;
    IF char_length(ws.slug) BETWEEN 2 AND 40 AND ws.slug ~ pattern THEN
      INSERT INTO "workspace_slug_alias" ("slug", "workspace_id") VALUES (ws.slug, ws.id)
      ON CONFLICT ("slug") DO NOTHING;
    END IF;
  END LOOP;
END $$;
