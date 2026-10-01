CREATE TABLE IF NOT EXISTS "message_reactions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "message_id" text NOT NULL,
  "user_id" text NOT NULL,
  "emoji" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_user" ON "message_reactions" ("tenant_id", "device_id", "binding_id", "agent_id", "message_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_reactions_message" ON "message_reactions" ("device_id", "binding_id", "agent_id", "message_id");
