CREATE TABLE workspace_connections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    stream_owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    stream_id TEXT,
    close_method TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX workspace_connections_space ON workspace_connections(tenant_id, space_id);
