CREATE TABLE IF NOT EXISTS project_campaigns (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL,
 source_project_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 campaign_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,source_project_id) REFERENCES execution_projects(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS project_campaigns_source ON project_campaigns(tenant_id,source_project_id,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS project_campaign_variants (
 tenant_id TEXT NOT NULL,
 campaign_id TEXT NOT NULL,
 variant_id TEXT NOT NULL,
 project_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL,
 run_id TEXT,
 PRIMARY KEY(tenant_id,campaign_id,variant_id),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES project_campaigns(tenant_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS project_campaign_audit (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 campaign_id TEXT NOT NULL,
 author_id TEXT NOT NULL,
 action TEXT NOT NULL,
 variant_id TEXT NOT NULL DEFAULT '',
 comment TEXT NOT NULL,
 details_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES project_campaigns(tenant_id,id) ON DELETE CASCADE
);
