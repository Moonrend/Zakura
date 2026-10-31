-- Egress policy applies to every container a node starts. It belongs to the
-- node's owning tenant; the upstream proxy URL may carry credentials and is
-- stored sealed.
CREATE TABLE node_egress_policies (
    node_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off','allow','deny')),
    allow_json TEXT NOT NULL DEFAULT '[]',
    deny_json TEXT NOT NULL DEFAULT '[]',
    no_upstream_json TEXT NOT NULL DEFAULT '[]',
    upstream_enc TEXT NOT NULL DEFAULT '',
    log_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    applied_at TEXT,
    apply_error TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
