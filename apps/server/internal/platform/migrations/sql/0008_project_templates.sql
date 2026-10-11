CREATE TABLE IF NOT EXISTS project_templates (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL,
 current_version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active',
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS project_templates_tenant ON project_templates(tenant_id,status,updated_at,id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS project_template_versions (
 tenant_id TEXT NOT NULL,
 template_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 definition_json TEXT NOT NULL,
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,template_id,version),
 FOREIGN KEY(tenant_id,template_id) REFERENCES project_templates(tenant_id,id) ON DELETE CASCADE
);
