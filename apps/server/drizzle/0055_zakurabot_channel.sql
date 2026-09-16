CREATE TABLE "zakurabot_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "binding_ids_json" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "zakurabot_devices_token" ON "zakurabot_devices" ("token_hash");
--> statement-breakpoint
CREATE INDEX "zakurabot_devices_tenant" ON "zakurabot_devices" ("tenant_id");
--> statement-breakpoint
CREATE TABLE "zakurabot_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "seq" serial NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL REFERENCES "zakurabot_devices"("id") ON DELETE CASCADE,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "client_message_id" text,
  "frame_json" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "zakurabot_messages_client" ON "zakurabot_messages" ("device_id", "binding_id", "agent_id", "client_message_id");
--> statement-breakpoint
CREATE INDEX "zakurabot_messages_history" ON "zakurabot_messages" ("device_id", "binding_id", "agent_id", "seq");
