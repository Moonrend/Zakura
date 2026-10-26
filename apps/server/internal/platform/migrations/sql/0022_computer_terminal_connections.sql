ALTER TABLE workspace_connections ADD COLUMN computer_id TEXT;
-- statement-breakpoint
ALTER TABLE workspace_connections ADD COLUMN runtime_id TEXT;
-- statement-breakpoint
ALTER TABLE workspace_connections ADD COLUMN incarnation TEXT;
-- statement-breakpoint
CREATE INDEX workspace_connections_computer ON workspace_connections(tenant_id, space_id, computer_id);
