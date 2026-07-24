-- 0017_runner_access
-- Local runner 预授权 + 共享 runner

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_use_local_runner" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- 默认授权平台管理员
UPDATE "users" SET "can_use_local_runner" = true WHERE "is_platform_admin" = true;
--> statement-breakpoint

ALTER TABLE "runtime_nodes" ADD COLUMN IF NOT EXISTS "is_shared" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "runtime_nodes" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "runtime_nodes" ADD CONSTRAINT "runtime_nodes_created_by_user_id_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "runtime_nodes_shared" ON "runtime_nodes" ("is_shared");
