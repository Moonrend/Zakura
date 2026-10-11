package computers

import (
	"context"
	"sort"
	"strings"
	"time"
)

// DestructionProvider removes a provisioned instance and any node-local storage
// that belongs to it. It is only invoked by deadline reclamation, never by an
// execution tool, and never resolved from caller input.
type DestructionProvider interface {
	Destroy(context.Context, Runtime) error
}

// CollectExpiredRuntimes streams active runtimes whose lease has elapsed on the
// maximum-lifetime or idle deadline. Deadlines are stored as RFC3339Nano strings
// whose trailing-zero trimming makes lexicographic comparison unreliable, so rows
// are parsed and compared in Go. Results are ordered by the earliest elapsed
// deadline so the oldest endings are reclaimed first.
func (s Store) CollectExpiredRuntimes(ctx context.Context, now time.Time, limit int) ([]Runtime, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.DB.QueryContext(ctx, s.query(`SELECT id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,external_id,root_path,access_token_enc,manifest_json,expires_at,idle_deadline FROM computer_runtimes WHERE state IN ('pending_approval','creating','ready','disconnected','stopping','unknown') AND (expires_at IS NOT NULL OR idle_deadline IS NOT NULL)`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type overdueRuntime struct {
		runtime Runtime
		at      time.Time
	}
	var due []overdueRuntime
	for rows.Next() {
		r, scanErr := scanRuntime(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		at, overdue := runtimeOverdueAt(r, now)
		if !overdue {
			continue
		}
		due = append(due, overdueRuntime{runtime: r, at: at})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(due, func(i, j int) bool {
		if due[i].at.Equal(due[j].at) {
			return due[i].runtime.ID < due[j].runtime.ID
		}
		return due[i].at.Before(due[j].at)
	})
	if len(due) > limit {
		due = due[:limit]
	}
	result := make([]Runtime, 0, len(due))
	for _, item := range due {
		result = append(result, item.runtime)
	}
	return result, nil
}

// runtimeOverdueAt reports whether either lease deadline has elapsed and returns
// the earliest elapsed deadline for deterministic ordering. A zero deadline is
// unset, not immediate.
func runtimeOverdueAt(r Runtime, now time.Time) (time.Time, bool) {
	var at time.Time
	overdue := false
	if !r.ExpiresAt.IsZero() && !now.Before(r.ExpiresAt) {
		at, overdue = r.ExpiresAt, true
	}
	if !r.IdleDeadline.IsZero() && !now.Before(r.IdleDeadline) {
		if !overdue || r.IdleDeadline.Before(at) {
			at, overdue = r.IdleDeadline, true
		}
	}
	return at, overdue
}

// CleanupDeps coordinates deadline reclamation with provider destruction. It only
// acts on runtimes the store still reports as active, so losing a race is a no-op
// rather than a second effect.
type CleanupDeps struct {
	Store      Store
	Destroyers map[Provider]DestructionProvider
	Now        func() time.Time
}

func (d CleanupDeps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// ExpireOverdue reclaims overdue runtimes. When a destroyer exists the runtime is
// parked in stopping before the provider call, so a crash between the destructive
// effect and the terminal transition stays observable. Destroyed counts confirmed
// provider removals; expired counts runtimes ended without one, including
// providers that own no destroyer. State races are skipped, never retried blindly.
func (d CleanupDeps) ExpireOverdue(ctx context.Context, limit int) (destroyed, expired int, err error) {
	now := d.now()
	due, err := d.Store.CollectExpiredRuntimes(ctx, now, limit)
	if err != nil {
		return 0, 0, err
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	for _, r := range due {
		provider, readErr := d.provider(ctx, r)
		if readErr != nil {
			continue
		}
		target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
		destroyer := d.Destroyers[provider]
		if destroyer == nil {
			if d.Store.Transition(ctx, target, r.State, Expired, stamp) == nil {
				expired++
			}
			continue
		}
		from := r.State
		if from != Stopping {
			if d.Store.Transition(ctx, target, from, Stopping, stamp) != nil {
				continue
			}
			from = Stopping
		}
		if destroyErr := destroyer.Destroy(ctx, r); destroyErr != nil {
			d.Store.markRuntimeError(ctx, target, now, destroyErr.Error())
			if d.Store.Transition(ctx, target, from, Expired, stamp) == nil {
				expired++
			}
			continue
		}
		if d.Store.Transition(ctx, target, from, Destroyed, stamp) == nil {
			destroyed++
		}
	}
	return destroyed, expired, nil
}

func (d CleanupDeps) provider(ctx context.Context, r Runtime) (Provider, error) {
	var provider Provider
	err := d.Store.DB.QueryRowContext(ctx, d.Store.query(`SELECT provider FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&provider)
	return provider, err
}

// markRuntimeError records why a reclamation failed without adding a store method.
// It targets the exact pinned identity, so it can never annotate a replacement.
func (s Store) markRuntimeError(ctx context.Context, t Target, now time.Time, reason string) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "computer destruction failed"
	}
	_, _ = s.DB.ExecContext(ctx, s.query(`UPDATE computer_runtimes SET last_error=?,updated_at=? WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=?`), reason, now.UTC().Format(time.RFC3339Nano), t.TenantID, t.SpaceID, t.ComputerID, t.RuntimeID, t.Incarnation)
}
