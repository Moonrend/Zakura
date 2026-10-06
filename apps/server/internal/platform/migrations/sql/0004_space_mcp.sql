UPDATE agent_bindings SET agent_id = NULL WHERE agent_id IS NOT NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mcp_policies_space_id ON mcp_policies(space_id);
