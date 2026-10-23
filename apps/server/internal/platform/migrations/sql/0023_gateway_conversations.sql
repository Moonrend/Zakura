CREATE TABLE gateway_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL,
    harness TEXT NOT NULL,
    client_key TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    model TEXT,
    origin_json TEXT NOT NULL DEFAULT '{}',
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, space_id, scope_key, harness, client_key)
);
-- statement-breakpoint
CREATE INDEX gateway_sessions_scope_idx ON gateway_sessions(tenant_id, space_id, scope_key, harness, updated_at);
-- statement-breakpoint
CREATE TABLE gateway_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    run_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(session_id, seq)
);
-- statement-breakpoint
CREATE TABLE gateway_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(session_id, position)
);
-- statement-breakpoint
CREATE INDEX gateway_messages_fingerprint_idx ON gateway_messages(fingerprint, session_id);
-- statement-breakpoint
CREATE TABLE gateway_response_links (
    session_id TEXT NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    PRIMARY KEY(session_id, response_id)
);
-- statement-breakpoint
CREATE INDEX gateway_response_links_id_idx ON gateway_response_links(response_id);
