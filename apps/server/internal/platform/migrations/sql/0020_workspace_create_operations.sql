CREATE TABLE workspace_create_operations (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    computer_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    config_digest TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (space_id, node_id)
);
