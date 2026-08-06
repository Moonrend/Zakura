-- Per-binding credentials: each platform connector instance stores its own config.
-- Multiple bindings of the same platform are allowed; configs never share.
ALTER TABLE "agent_channel_bindings"
  ADD COLUMN IF NOT EXISTS "config_enc" text DEFAULT '' NOT NULL;

DROP INDEX IF EXISTS "agent_channel_bindings_tenant_platform_profile";

CREATE INDEX IF NOT EXISTS "agent_channel_bindings_tenant_platform"
  ON "agent_channel_bindings" ("tenant_id", "platform");
