ALTER TABLE "zakurabot_devices" ADD COLUMN "user_id" text REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "zakurabot_authorizations" ADD COLUMN "code_challenge" text;
--> statement-breakpoint
ALTER TABLE "zakurabot_authorizations" ADD COLUMN "last_polled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "zakurabot_authorizations" ADD COLUMN "interval_seconds" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
CREATE TABLE "zakurabot_files" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL REFERENCES "zakurabot_devices"("id") ON DELETE CASCADE,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "zakurabot_files_conversation" ON "zakurabot_files" ("device_id", "binding_id", "agent_id");
