package computers

// These statements are shared with the runtime store so creation and selection
// are committed in the same transaction. Both derive Space ownership from the
// session, never caller input.
//
// A new chat records no explicit choice: NULL means "follow the Space server
// computer", so later Space changes never rebind an existing chat.
const InitializeSessionDefaultSQL = `INSERT INTO session_computer_defaults(session_id,tenant_id,space_id,computer_id)
 SELECT cs.id,cs.tenant_id,a.space_id,NULL FROM cloud_agent_sessions cs
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 WHERE cs.id=? AND cs.tenant_id=? AND a.space_id IS NOT NULL
 ON CONFLICT(session_id) DO NOTHING`

// SnapshotRunTargetSQL pins the chat's choice, or the Space server computer when
// the chat has none, so every Run names its computer explicitly.
const SnapshotRunTargetSQL = `INSERT INTO run_computer_targets(run_id,tenant_id,space_id,computer_id)
 SELECT r.id,cs.tenant_id,a.space_id,COALESCE(d.computer_id,sc.id) FROM cloud_agent_runs r
 JOIN cloud_agent_sessions cs ON cs.id=r.session_id
 JOIN agents a ON a.id=cs.agent_id AND a.tenant_id=cs.tenant_id
 LEFT JOIN session_computer_defaults d ON d.session_id=cs.id AND d.tenant_id=cs.tenant_id AND d.space_id=a.space_id
 LEFT JOIN computers sc ON sc.tenant_id=cs.tenant_id AND sc.space_id=a.space_id AND sc.role='server'
 WHERE r.id=? AND cs.tenant_id=? AND a.space_id IS NOT NULL
 ON CONFLICT(run_id) DO NOTHING`
