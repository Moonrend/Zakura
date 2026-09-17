CREATE TABLE "zakurabot_interactions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "device_id" text NOT NULL REFERENCES "zakurabot_devices"("id") ON DELETE CASCADE,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL REFERENCES "cloud_agent_sessions"("id") ON DELETE CASCADE,
  "run_id" text,
  "source_session_id" text NOT NULL REFERENCES "cloud_agent_sessions"("id") ON DELETE CASCADE,
  "source_run_id" text,
  "request_id" text NOT NULL,
  "type" text NOT NULL,
  "payload_json" text NOT NULL,
  "reply_to" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "claimed_at" timestamp with time zone,
  "event_seq" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "zakurabot_interactions_session" ON "zakurabot_interactions" ("session_id", "request_id");
