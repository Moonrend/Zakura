-- Every Space owns exactly one server computer: the computer that IS its
-- workspace (workspace filesystem, ACP environment, installed skills). Other
-- computers are attached. Node, workspace kind and capabilities of the server
-- computer are read from the Space row; the copies below are informational.
ALTER TABLE computers ADD COLUMN role TEXT NOT NULL DEFAULT 'attached';
-- statement-breakpoint
-- The pre-role adoption created at most one 'legacy:<space>' computer per Space,
-- bound to that Space's workspace scope. It already is the workspace, so it
-- becomes the server computer and keeps its identity for existing chat and Run
-- pins. No runtime, container or directory is created or replaced.
UPDATE computers SET role='server',provider='server',legacy_workspace_scope=space_id
WHERE id='legacy:' || space_id;
-- statement-breakpoint
INSERT INTO computers(id,tenant_id,space_id,name,provider,role,runtime_node_id,legacy_workspace_scope,legacy_workspace_kind,workspace_image,capabilities_json,created_at,updated_at)
SELECT 'server:' || s.id,s.tenant_id,s.id,s.name,'server','server',s.runtime_node_id,s.id,s.workspace_kind,s.workspace_image,'[]',s.created_at,s.updated_at
FROM spaces s
WHERE NOT EXISTS (SELECT 1 FROM computers c WHERE c.tenant_id=s.tenant_id AND c.space_id=s.id AND c.role='server')
ON CONFLICT DO NOTHING;
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_computers_space_server ON computers(tenant_id,space_id) WHERE role='server';
-- statement-breakpoint
UPDATE computers SET
 runtime_node_id=(SELECT s.runtime_node_id FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id),
 legacy_workspace_kind=(SELECT s.workspace_kind FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id),
 workspace_image=(SELECT s.workspace_image FROM spaces s WHERE s.id=computers.space_id AND s.tenant_id=computers.tenant_id)
WHERE role='server';
-- statement-breakpoint
-- The configurable Space default is retired: chats without an explicit choice
-- follow the server computer. Existing chat choices and Run pins are untouched;
-- a NULL choice that used to mean "no computer" now resolves to the server.
INSERT INTO space_computer_defaults(space_id,tenant_id,computer_id)
SELECT space_id,tenant_id,id FROM computers WHERE role='server'
ON CONFLICT(space_id) DO UPDATE SET computer_id=excluded.computer_id;
