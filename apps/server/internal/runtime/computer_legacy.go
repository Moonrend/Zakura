package runtime

import "gorm.io/gorm"

// adoptLegacyComputer registers an explicitly enabled old-style workspace in the
// same transaction as its creation. Never overwrite a selection, existing
// computer identity, or a chat/Run snapshot when the Space is edited later.
func adoptLegacyComputer(tx *gorm.DB, tenant, space string) error {
	result := tx.Exec(`INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,legacy_workspace_scope,legacy_workspace_kind,workspace_image,created_at,updated_at)
 SELECT 'legacy:' || s.id,s.tenant_id,s.id,s.name,
 CASE WHEN n.kind='computer' THEN 'remote_agent' ELSE 'server' END,
 s.runtime_node_id,s.id,s.workspace_kind,s.workspace_image,s.created_at,s.updated_at
 FROM spaces s LEFT JOIN runtime_nodes n ON n.id=s.runtime_node_id
 WHERE s.tenant_id=? AND s.id=? AND s.enable_computer
 ON CONFLICT(id) DO NOTHING`, tenant, space)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return nil
	}
	return tx.Exec(`INSERT INTO space_computer_defaults(space_id,tenant_id,computer_id) VALUES(?,? ,?) ON CONFLICT(space_id) DO NOTHING`, space, tenant, "legacy:"+space).Error
}
