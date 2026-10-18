ALTER TABLE agent_tool_approvals ADD COLUMN space_id TEXT;
-- statement-breakpoint
ALTER TABLE agent_tool_approvals ADD COLUMN target_digest TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE agent_tool_approvals ADD COLUMN source TEXT NOT NULL DEFAULT 'standard';
-- statement-breakpoint
ALTER TABLE agent_tool_approvals ADD COLUMN protocol_request_id TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tool_approvals_run_pending ON agent_tool_approvals(tenant_id,session_id,run_id,status);
