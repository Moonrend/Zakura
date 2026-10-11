CREATE TABLE IF NOT EXISTS execution_deliveries (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 name TEXT NOT NULL,
 version TEXT NOT NULL,
 revision BIGINT NOT NULL,
 status TEXT NOT NULL,
 record_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,project_id,kind,name,version),
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_deliveries_project ON execution_deliveries(tenant_id,project_id,kind,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_delivery_channels (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 channel TEXT NOT NULL,
 delivery_id TEXT NOT NULL REFERENCES execution_deliveries(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL,
 author_id TEXT NOT NULL,
 comment TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id,channel),
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_delivery_audit (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL REFERENCES execution_deliveries(id) ON DELETE CASCADE,
 action TEXT NOT NULL,
 author_id TEXT NOT NULL,
 comment TEXT NOT NULL,
 detail_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
