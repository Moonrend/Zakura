CREATE TABLE IF NOT EXISTS execution_knowledge (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 status TEXT NOT NULL,
 prior_status TEXT NOT NULL DEFAULT '',
 run_id TEXT NOT NULL DEFAULT '',
 task_id TEXT NOT NULL DEFAULT '',
 revision BIGINT NOT NULL,
 token_length INTEGER NOT NULL,
 entry_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id) REFERENCES execution_projects(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,project_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_knowledge_project ON execution_knowledge(tenant_id,project_id,status,kind,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_knowledge_task ON execution_knowledge(tenant_id,project_id,run_id,task_id,id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_knowledge_revisions (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 revision_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(entry_id,revision),
 FOREIGN KEY(tenant_id,project_id,entry_id) REFERENCES execution_knowledge(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_knowledge_terms (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 term TEXT NOT NULL,
 field TEXT NOT NULL,
 frequency INTEGER NOT NULL,
 PRIMARY KEY(entry_id,term,field),
 FOREIGN KEY(tenant_id,project_id,entry_id) REFERENCES execution_knowledge(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_knowledge_term_lookup ON execution_knowledge_terms(tenant_id,project_id,term,entry_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_knowledge_tags (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 tag TEXT NOT NULL,
 PRIMARY KEY(entry_id,tag),
 FOREIGN KEY(tenant_id,project_id,entry_id) REFERENCES execution_knowledge(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_knowledge_tag_lookup ON execution_knowledge_tags(tenant_id,project_id,tag,entry_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_knowledge_comments (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 comment_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,project_id,entry_id) REFERENCES execution_knowledge(tenant_id,project_id,id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_knowledge_comment_lookup ON execution_knowledge_comments(tenant_id,project_id,entry_id,created_at,id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_knowledge_receipts (
 tenant_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 arguments_hash TEXT NOT NULL,
 run_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 result_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id,operation_id),
 FOREIGN KEY(tenant_id,project_id,run_id,task_id) REFERENCES execution_tasks(tenant_id,project_id,run_id,id) ON DELETE CASCADE
);
