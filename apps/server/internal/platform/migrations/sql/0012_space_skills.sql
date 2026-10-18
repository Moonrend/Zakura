CREATE TABLE IF NOT EXISTS space_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  version TEXT,
  revision TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  path TEXT NOT NULL,
  auto_update BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'installed',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space_id, name)
);
CREATE INDEX IF NOT EXISTS space_skills_owner ON space_skills(tenant_id, space_id);
CREATE INDEX IF NOT EXISTS space_skills_package ON space_skills(skill_id);
