CREATE TABLE IF NOT EXISTS execution_merge_previews (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 status TEXT NOT NULL,
 preview_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id) REFERENCES execution_runs(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_merge_previews_run ON execution_merge_previews(tenant_id,project_id,run_id,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_merge_audit (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 preview_id TEXT NOT NULL REFERENCES execution_merge_previews(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL,
 action TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 comment TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id) REFERENCES execution_runs(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_source_attestations (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 author_id TEXT NOT NULL,
 activity_ids_json TEXT NOT NULL,
 comment TEXT NOT NULL,
 status TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT 'null',
 error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
