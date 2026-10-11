CREATE TABLE IF NOT EXISTS execution_requirement_baselines (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 status TEXT NOT NULL,
 baseline_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,project_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_requirement_baselines_project ON execution_requirement_baselines(tenant_id,project_id,status,updated_at,id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_requirement_revisions (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 baseline_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 revision_json TEXT NOT NULL,
 PRIMARY KEY(baseline_id,revision),
 FOREIGN KEY(tenant_id,project_id,baseline_id) REFERENCES execution_requirement_baselines(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_requirement_bindings (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 baseline_id TEXT NOT NULL,
 baseline_revision BIGINT NOT NULL,
 baseline_hash TEXT NOT NULL,
 binding_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id),
 FOREIGN KEY(tenant_id,project_id,run_id) REFERENCES execution_runs(tenant_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,project_id,baseline_id) REFERENCES execution_requirement_baselines(tenant_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(baseline_id,baseline_revision) REFERENCES execution_requirement_revisions(baseline_id,revision)
);
