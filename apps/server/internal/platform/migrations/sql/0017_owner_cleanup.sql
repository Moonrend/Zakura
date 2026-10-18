ALTER TABLE spaces ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE computers ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- Intents outlive deleted Spaces, computers, containers and tenants. In
-- particular, none of these identity columns has a cascading foreign key.
CREATE TABLE IF NOT EXISTS managed_container_cleanup_intents (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL DEFAULT '',
 container_id TEXT NOT NULL,
 node_id TEXT NOT NULL,
 docker_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 pending BOOLEAN NOT NULL DEFAULT TRUE,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt BIGINT NOT NULL,
 token TEXT NOT NULL DEFAULT '',
 last_error TEXT,
 updated_at BIGINT NOT NULL,
 UNIQUE(node_id,docker_id)
);
CREATE INDEX IF NOT EXISTS managed_container_cleanup_due ON managed_container_cleanup_intents(pending,next_attempt);
