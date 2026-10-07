CREATE TABLE IF NOT EXISTS computers (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('server','remote_agent','ssh','temporary','e2b','railway')),
 runtime_node_id TEXT,
 settings_json TEXT NOT NULL DEFAULT '{}',
 secret_ref TEXT,
 capabilities_json TEXT NOT NULL DEFAULT '[]',
 idle_seconds INTEGER NOT NULL DEFAULT 900 CHECK(idle_seconds > 0),
 max_lifetime_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(max_lifetime_seconds >= idle_seconds),
 legacy_workspace_scope TEXT,
 legacy_workspace_kind TEXT,
 workspace_image TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,space_id,id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_computers_space ON computers(tenant_id,space_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS computer_runtimes (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 computer_id TEXT NOT NULL,
 session_scope TEXT NOT NULL DEFAULT '',
 incarnation TEXT NOT NULL UNIQUE,
 create_operation_id TEXT NOT NULL UNIQUE,
 external_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending_approval','creating','ready','disconnected','stopping','expired','destroyed','failed','unknown')),
 expires_at TEXT,
 idle_deadline TEXT,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,space_id,computer_id) REFERENCES computers(tenant_id,space_id,id),
 UNIQUE(tenant_id,space_id,computer_id,id,incarnation)
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_computer_runtime_active ON computer_runtimes(computer_id,session_scope) WHERE state IN ('pending_approval','creating','ready','disconnected','stopping','unknown');
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS space_computer_defaults (
 space_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 computer_id TEXT NOT NULL,
 FOREIGN KEY(tenant_id,space_id,computer_id) REFERENCES computers(tenant_id,space_id,id)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS session_computer_defaults (
 session_id TEXT PRIMARY KEY REFERENCES cloud_agent_sessions(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 computer_id TEXT,
 FOREIGN KEY(tenant_id,space_id,computer_id) REFERENCES computers(tenant_id,space_id,id)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS run_computer_targets (
 run_id TEXT PRIMARY KEY REFERENCES cloud_agent_runs(id) ON DELETE CASCADE,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 computer_id TEXT,
 FOREIGN KEY(tenant_id,space_id,computer_id) REFERENCES computers(tenant_id,space_id,id)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS computer_execution_targets (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 computer_id TEXT NOT NULL,
 runtime_id TEXT NOT NULL,
 incarnation TEXT NOT NULL,
 run_id TEXT REFERENCES cloud_agent_runs(id),
 tool_call_id TEXT,
 external_job_id TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,space_id,computer_id,runtime_id,incarnation) REFERENCES computer_runtimes(tenant_id,space_id,computer_id,id,incarnation)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS computer_project_workspaces (
 tenant_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 computer_id TEXT NOT NULL,
 runtime_id TEXT NOT NULL,
 incarnation TEXT NOT NULL,
 project_id TEXT NOT NULL REFERENCES space_projects(id) ON DELETE CASCADE,
 path TEXT NOT NULL,
 state TEXT NOT NULL,
 PRIMARY KEY(runtime_id,project_id),
 FOREIGN KEY(tenant_id,space_id,computer_id,runtime_id,incarnation) REFERENCES computer_runtimes(tenant_id,space_id,computer_id,id,incarnation)
);
-- statement-breakpoint
-- Adopt identity only. Keep the old scope so reconciliation can locate the existing
-- container/volume/host directory; never create a replacement during migration.
INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,legacy_workspace_scope,legacy_workspace_kind,workspace_image,created_at,updated_at)
SELECT 'legacy:' || s.id,s.tenant_id,s.id,s.name,CASE WHEN n.kind='computer' THEN 'remote_agent' ELSE 'server' END,s.runtime_node_id,s.id,s.workspace_kind,s.workspace_image,s.created_at,s.updated_at FROM spaces s LEFT JOIN runtime_nodes n ON n.id=s.runtime_node_id WHERE s.enable_computer
ON CONFLICT(id) DO NOTHING;
-- statement-breakpoint
INSERT INTO space_computer_defaults(space_id,tenant_id,computer_id)
SELECT space_id,tenant_id,id FROM computers WHERE legacy_workspace_scope IS NOT NULL
ON CONFLICT(space_id) DO NOTHING;

-- statement-breakpoint
-- Preserve existing chat choices without creating runtimes. A NULL selection is
-- deliberate: later changes to the Space default must not rebind old chats.
INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
SELECT cs.id,cs.tenant_id,a.space_id,d.computer_id
FROM cloud_agent_sessions cs
JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
LEFT JOIN space_computer_defaults d ON d.space_id=a.space_id AND d.tenant_id=cs.tenant_id
WHERE a.space_id IS NOT NULL
ON CONFLICT(session_id) DO NOTHING;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS computer_creation_approvals (
 runtime_id TEXT PRIMARY KEY REFERENCES computer_runtimes(id),
 create_operation_id TEXT NOT NULL UNIQUE,
 approved_by TEXT NOT NULL,
 approved_at TEXT NOT NULL
);
