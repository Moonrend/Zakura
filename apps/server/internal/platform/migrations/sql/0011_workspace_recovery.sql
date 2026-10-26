CREATE TABLE IF NOT EXISTS computer_workspace_leases (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  token TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS computer_workspace_leases_expiry ON computer_workspace_leases(expires_at);

-- Cleanup ownership intentionally outlives deleted computer/runtime rows.
CREATE TABLE IF NOT EXISTS computer_cleanup_intents (
  runtime_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  pending BOOLEAN NOT NULL DEFAULT TRUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt BIGINT NOT NULL,
  token TEXT NOT NULL,
  last_error TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (runtime_id, incarnation)
);
CREATE INDEX IF NOT EXISTS computer_cleanup_intents_due ON computer_cleanup_intents(pending, next_attempt);
