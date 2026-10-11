CREATE TABLE IF NOT EXISTS execution_tenant_controls (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 draining INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_projects (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL,
 event_sequence BIGINT NOT NULL DEFAULT 0,
 project_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_projects_space ON execution_projects(tenant_id,space_id,updated_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_runs (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 status TEXT NOT NULL,
 revision BIGINT NOT NULL,
 run_json TEXT NOT NULL,
 project_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,project_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_runs_project ON execution_runs(tenant_id,project_id,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_tasks (
 id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 status TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0,
 revision BIGINT NOT NULL,
 lease_owner TEXT NOT NULL DEFAULT '',
 lease_until TEXT,
 fence BIGINT NOT NULL DEFAULT 0,
 model_allowance BIGINT NOT NULL DEFAULT 0,
 model_reserved INTEGER NOT NULL DEFAULT 0,
 task_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,id),
 FOREIGN KEY(tenant_id,project_id,run_id) REFERENCES execution_runs(tenant_id,project_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,project_id,run_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_tasks_claim ON execution_tasks(status,lease_until,priority,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_checkpoints (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 sequence BIGINT NOT NULL,
 checkpoint_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE,
 UNIQUE(run_id,task_id,sequence)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_operations (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 checkpoint_id TEXT NOT NULL,
 call_id TEXT NOT NULL,
 status TEXT NOT NULL,
 revision BIGINT NOT NULL,
 operation_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE,
 UNIQUE(run_id,task_id,checkpoint_id,call_id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_operations_task ON execution_operations(tenant_id,project_id,run_id,task_id,status);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_verifications (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 verification_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_verifications_task ON execution_verifications(tenant_id,project_id,run_id,task_id,revision);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_reviews (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 review_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_events (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL DEFAULT '',
 task_id TEXT NOT NULL DEFAULT '',
 sequence BIGINT NOT NULL,
 event_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(project_id,sequence)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_events_run ON execution_events(tenant_id,project_id,run_id,sequence);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_task_dependencies (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 dependency_id TEXT NOT NULL,
 PRIMARY KEY(run_id,task_id,dependency_id),
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,project_id,run_id,dependency_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_dependencies_ready ON execution_task_dependencies(tenant_id,project_id,run_id,task_id);
