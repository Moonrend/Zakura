CREATE TABLE IF NOT EXISTS acp_device_auth_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL DEFAULT '',
  user_code TEXT NOT NULL DEFAULT '',
  verification_uri TEXT NOT NULL DEFAULT '',
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  next_poll_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE UNIQUE INDEX acp_device_auth_one_active ON acp_device_auth_attempts(tenant_id,space_id,profile_id) WHERE status IN ('starting','pending','polling','persisting');
-- statement-breakpoint
CREATE INDEX acp_device_auth_expiry ON acp_device_auth_attempts(expires_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS acp_profile_auth_locks (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  token TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id,space_id,profile_id)
);
