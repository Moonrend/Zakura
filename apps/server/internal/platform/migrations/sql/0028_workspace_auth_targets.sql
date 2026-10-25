-- Authentication on a managed disk must retain its original instance identity.
-- Empty identities are legacy and must not be inferred from today's Space binding.
ALTER TABLE acp_profile_auth_locks ADD COLUMN workspace_instance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE acp_profile_auth_locks ADD COLUMN workspace_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE acp_device_auth_attempts ADD COLUMN workspace_instance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE acp_device_auth_attempts ADD COLUMN workspace_generation BIGINT NOT NULL DEFAULT 0;
CREATE INDEX acp_auth_locks_workspace ON acp_profile_auth_locks(tenant_id,space_id,workspace_instance_id);
CREATE INDEX acp_device_workspace ON acp_device_auth_attempts(tenant_id,space_id,workspace_instance_id);
