CREATE TABLE execution_portfolio_policies (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL,
 policy_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE execution_portfolio_service (
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL,
 virtual_finish BIGINT NOT NULL DEFAULT 0,
 dispatch_count BIGINT NOT NULL DEFAULT 0,
 last_dispatched_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE execution_resource_reservations (
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 fence BIGINT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id,run_id,task_id,kind),
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX execution_resource_agent ON execution_resource_reservations(tenant_id,agent_id,kind);
