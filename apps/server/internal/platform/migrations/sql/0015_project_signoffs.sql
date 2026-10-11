CREATE TABLE IF NOT EXISTS execution_signoff_policies (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 policy_json TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_signoff_policy_revisions (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 policy_json TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id,revision),
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_signoff_policies(tenant_id,project_id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS execution_merge_previews_signoff_scope ON execution_merge_previews(tenant_id,project_id,run_id,id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_signoff_votes (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 preview_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 policy_hash TEXT NOT NULL,
 evidence_hash TEXT NOT NULL,
 status TEXT NOT NULL,
 sequence BIGINT NOT NULL,
 vote_json TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,run_id) REFERENCES execution_runs(tenant_id,project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,project_id,run_id,preview_id) REFERENCES execution_merge_previews(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS execution_signoff_votes_active_user ON execution_signoff_votes(tenant_id,project_id,preview_id,user_id,policy_hash,evidence_hash) WHERE status='active';
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_signoff_votes_preview ON execution_signoff_votes(tenant_id,project_id,preview_id,sequence);
