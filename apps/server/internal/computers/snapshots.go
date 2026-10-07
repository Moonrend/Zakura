package computers

// These statements are shared with the runtime store so creation and selection
// are committed in the same transaction. NULL is a durable "no computer" choice.
// Both statements derive Space ownership from the session, never caller input.
const InitializeSessionDefaultSQL = `INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
 SELECT cs.id,cs.tenant_id,a.space_id,d.computer_id FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN space_computer_defaults d ON d.space_id=a.space_id AND d.tenant_id=cs.tenant_id
 WHERE cs.id=? AND cs.tenant_id=? AND a.space_id IS NOT NULL
 ON CONFLICT(session_id) DO NOTHING`

const SnapshotRunTargetSQL = `INSERT INTO run_computer_targets(run_id,tenant_id,space_id,computer_id)
 SELECT r.id,cs.tenant_id,a.space_id,d.computer_id FROM cloud_agent_runs r
 JOIN cloud_agent_sessions cs ON cs.id=r.session_id
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN session_computer_defaults d ON d.session_id=cs.id AND d.tenant_id=cs.tenant_id AND d.space_id=a.space_id
 WHERE r.id=? AND cs.tenant_id=? AND a.space_id IS NOT NULL
 ON CONFLICT(run_id) DO NOTHING`
