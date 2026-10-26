CREATE TABLE IF NOT EXISTS space_connector_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  connector_ref TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space_id, connector_ref)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS space_connector_legacy_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  connector_ref TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_enc TEXT NOT NULL,
  settings_enc TEXT NOT NULL DEFAULT '',
  encryption_scope TEXT NOT NULL,
  settings_scope TEXT NOT NULL DEFAULT '',
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS space_connector_legacy_owner ON space_connector_legacy_installations(tenant_id, space_id, resolved);
-- statement-breakpoint
INSERT INTO space_connector_legacy_installations (
  id, tenant_id, space_id, agent_id, connector_ref, enabled, config_enc,
  settings_enc, encryption_scope, settings_scope, resolved, created_at, updated_at
)
SELECT i.id, i.tenant_id, a.space_id, i.agent_id, i.connector_ref, i.enabled, i.config_enc,
  COALESCE(s.config_enc, ''), i.tenant_id || ':' || i.agent_id || ':' || i.connector_ref,
  CASE WHEN s.id IS NULL THEN '' ELSE i.tenant_id || ':' || s.connector_ref END,
  FALSE, i.created_at, i.updated_at
FROM agent_connector_installations i
JOIN agents a ON a.id = i.agent_id AND a.tenant_id = i.tenant_id
LEFT JOIN connector_settings s ON s.scope_key = i.tenant_id AND s.connector_ref = CASE
  WHEN EXISTS (SELECT 1 FROM connector_settings direct WHERE direct.scope_key = i.tenant_id AND direct.connector_ref = i.connector_ref) THEN i.connector_ref
  WHEN i.connector_ref LIKE 'email-%' THEN 'email'
  WHEN i.connector_ref = 'email' THEN 'email-smtp'
  ELSE i.connector_ref END
WHERE TRUE
ON CONFLICT (id) DO NOTHING;
-- statement-breakpoint
ALTER TABLE tool_call_logs ADD COLUMN space_id TEXT;
-- statement-breakpoint
ALTER TABLE tool_call_logs ADD COLUMN actor_user_id TEXT;
