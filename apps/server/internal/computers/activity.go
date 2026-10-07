package computers

import (
	"context"
	"errors"
	"time"
)

// RecordActivity is called only for authorized execution, never catalog polling.
// It renews the idle deadline of the exact incarnation without extending maximum
// lifetime. An expired runtime cannot be revived. A concurrent state/deadline
// change loses the CAS and must be re-resolved before dispatching any effects.
func (s Store) RecordActivity(ctx context.Context, t Target, session string, now time.Time) error {
	r, err := s.GetRuntime(ctx, t)
	if err != nil {
		return err
	}
	var provider Provider
	var seconds int
	err = s.DB.QueryRowContext(ctx, s.query(`SELECT provider,idle_seconds FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), t.TenantID, t.SpaceID, t.ComputerID).Scan(&provider, &seconds)
	if err != nil {
		return err
	}
	c := Computer{ID: t.ComputerID, TenantID: t.TenantID, SpaceID: t.SpaceID, Provider: provider}
	if err = CheckIdentity(t, c, r, session); err != nil {
		return err
	}
	if r.State != Ready || r.ExternalID == "" {
		return ErrTransitionConflict
	}
	if !c.SessionScoped() {
		return nil
	}
	if seconds <= 0 || r.ExpiresAt.IsZero() || r.IdleDeadline.IsZero() || r.IdleDeadline.After(r.ExpiresAt) {
		return errors.New("temporary runtime has invalid lifetime")
	}
	if !now.Before(r.ExpiresAt) || !now.Before(r.IdleDeadline) {
		return ErrRuntimeEnded
	}
	next := now.Add(time.Duration(seconds) * time.Second)
	if next.After(r.ExpiresAt) {
		next = r.ExpiresAt
	}
	// Clock skew or out-of-order events must never shorten a valid lease.
	if !next.After(r.IdleDeadline) {
		return nil
	}
	result, err := s.DB.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET idle_deadline=?,updated_at=? WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=? AND state='ready' AND external_id=? AND idle_deadline=? AND expires_at=?`), next.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation, r.ExternalID, r.IdleDeadline.UTC().Format(time.RFC3339Nano), r.ExpiresAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrTransitionConflict
	}
	return nil
}
