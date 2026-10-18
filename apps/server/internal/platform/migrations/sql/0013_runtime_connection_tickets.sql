CREATE TABLE IF NOT EXISTS runtime_connection_tickets (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS runtime_connection_tickets_expiry ON runtime_connection_tickets(expires_at);
