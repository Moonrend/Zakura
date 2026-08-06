-- 统一远程 Agent 通道：凭据继续复用 connector_auth_profiles。
CREATE TABLE IF NOT EXISTS "agent_channel_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "profile_key" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "settings_json" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_bindings_tenant_platform_profile"
  ON "agent_channel_bindings" ("tenant_id", "platform", "profile_key");
CREATE INDEX IF NOT EXISTS "agent_channel_bindings_tenant"
  ON "agent_channel_bindings" ("tenant_id");
CREATE INDEX IF NOT EXISTS "agent_channel_bindings_agent"
  ON "agent_channel_bindings" ("agent_id");
CREATE INDEX IF NOT EXISTS "agent_channel_bindings_platform"
  ON "agent_channel_bindings" ("platform");

CREATE TABLE IF NOT EXISTS "agent_channel_threads" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL REFERENCES "cloud_agent_sessions"("id") ON DELETE CASCADE,
  "external_thread_key" text NOT NULL,
  "external_user_key" text,
  "last_event_id" text,
  "last_event_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_threads_binding_thread"
  ON "agent_channel_threads" ("binding_id", "external_thread_key");
CREATE INDEX IF NOT EXISTS "agent_channel_threads_tenant"
  ON "agent_channel_threads" ("tenant_id");
CREATE INDEX IF NOT EXISTS "agent_channel_threads_session"
  ON "agent_channel_threads" ("session_id");

CREATE TABLE IF NOT EXISTS "agent_channel_events" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "binding_id" text NOT NULL REFERENCES "agent_channel_bindings"("id") ON DELETE CASCADE,
  "external_event_id" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_channel_events_binding_event"
  ON "agent_channel_events" ("binding_id", "external_event_id");
CREATE INDEX IF NOT EXISTS "agent_channel_events_received"
  ON "agent_channel_events" ("received_at");
