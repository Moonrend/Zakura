package computers

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// maxManifestBytes bounds a persisted provider manifest. Railways' manifest is a
// handful of short fields; anything larger is corrupt or hostile and is rejected
// rather than stored.
const maxManifestBytes = 16 * 1024

// UpdateManifest persists a provider manifest for display only. The update is a
// scoped compare-and-swap on the full pinned identity, so a stale incarnation or
// another tenant can never overwrite a runtime it does not own; a missing row is
// sql.ErrNoRows. The map is marshalled verbatim and size-capped.
func (s Store) UpdateManifest(ctx context.Context, t Target, manifest map[string]any, now time.Time) error {
	if t.TenantID == "" || t.SpaceID == "" || t.ComputerID == "" || t.RuntimeID == "" || t.Incarnation == "" {
		return errors.New("runtime identity is incomplete")
	}
	if len(manifest) == 0 {
		return nil
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if len(raw) > maxManifestBytes {
		return errors.New("provider manifest is too large")
	}
	result, err := s.DB.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET manifest_json=?,updated_at=? WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=?`), string(raw), now.UTC().Format(time.RFC3339Nano), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation)
	return requireRow(result, err)
}
