CREATE INDEX IF NOT EXISTS execution_review_tasks ON execution_tasks(tenant_id,status,created_at,run_id,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_review_operations ON execution_operations(tenant_id,status,created_at,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_review_merges ON execution_merge_previews(tenant_id,status,created_at,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_review_source ON execution_source_attestations(tenant_id,status,created_at,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_review_knowledge ON execution_knowledge(tenant_id,kind,status,created_at,id);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS execution_review_baselines ON execution_requirement_baselines(tenant_id,status,created_at,id);
