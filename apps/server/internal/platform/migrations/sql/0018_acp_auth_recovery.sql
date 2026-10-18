ALTER TABLE acp_profile_auth_locks ADD COLUMN node_id TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE acp_profile_auth_locks ADD COLUMN computer_id TEXT NOT NULL DEFAULT '';
