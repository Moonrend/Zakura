CREATE TABLE node_installations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    node_id TEXT NOT NULL UNIQUE,
    node_incarnation TEXT NOT NULL,
    bootstrap_hash TEXT NOT NULL,
    credential_nonce TEXT NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL
);
