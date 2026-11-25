CREATE TABLE connector_oauth_states (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_scope TEXT NOT NULL,
    source_profile_id TEXT NOT NULL,
    destination_scope TEXT NOT NULL,
    destination_profile_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX connector_oauth_states_expires_idx ON connector_oauth_states(expires_at);
