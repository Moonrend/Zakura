package computers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

// CleanupSnapshotProvider is implemented only by trusted registered providers.
// Capture must return sealed/non-secret routing data, never credentials in clear
// text. DestroyCleanup receives the original immutable identity after owner rows
// disappear and must not resolve a replacement from the current computer.
type CleanupSnapshotProvider interface {
	CaptureCleanup(context.Context, Runtime) (json.RawMessage, error)
	DestroyCleanup(context.Context, Runtime, json.RawMessage) error
}
type cleanupSnapshot struct {
	Runtime      Runtime         `json:"runtime"`
	ProviderData json.RawMessage `json:"providerData,omitempty"`
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

// ExpireOverdue first durably queues destruction, then makes execution terminal.
// Cleanup is a separate retryable intent, so releasing an expired active slot
// cannot abandon a failed provider removal or redirect it to a replacement.
func (d CleanupDeps) ExpireOverdue(ctx context.Context, limit int) (destroyed, expired int, err error) {
	if limit <= 0 {
		return 0, 0, nil
	}
	now := d.now()
	due, err := d.Store.CollectExpiredRuntimes(ctx, now, limit)
	if err != nil {
		return 0, 0, err
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	for _, r := range due {
		provider, readErr := d.provider(ctx, r)
		if readErr != nil {
			return destroyed, expired, readErr
		}
		target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
		destroyer := d.Destroyers[provider]
		if destroyer == nil {
			if d.Store.Transition(ctx, target, r.State, Expired, stamp) == nil {
				expired++
			}
			continue
		}
		if r.State != Stopping && !CanTransition(r.State, Stopping) {
			// Unapproved/creating instances without a provider identity are not safe to
			// destroy. Unknown owns the slot until provider reconciliation can identify it.
			continue
		}
		var queued int
		if readErr = d.Store.DB.QueryRowContext(ctx, d.Store.query(`SELECT COUNT(*) FROM computer_cleanup_intents WHERE runtime_id=? AND incarnation=?`), r.ID, r.Incarnation).Scan(&queued); readErr != nil {
			return destroyed, expired, readErr
		}
		if queued != 0 {
			continue
		}
		snapshot := cleanupSnapshot{Runtime: r}
		if capturer, ok := destroyer.(CleanupSnapshotProvider); ok {
			snapshot.ProviderData, err = capturer.CaptureCleanup(ctx, r)
			if err != nil {
				return destroyed, expired, err
			}
		}
		raw, encodeErr := json.Marshal(snapshot)
		if encodeErr != nil {
			return destroyed, expired, encodeErr
		}
		tx, beginErr := d.Store.DB.BeginTx(ctx, nil)
		if beginErr != nil {
			return destroyed, expired, beginErr
		}
		result, writeErr := tx.ExecContext(ctx, d.Store.query(`UPDATE computer_runtimes SET state='stopping',updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND computer_id=? AND incarnation=? AND state=?`), stamp, r.ID, r.TenantID, r.SpaceID, r.ComputerID, r.Incarnation, r.State)
		if writeErr == nil {
			writeErr = requireRow(result, nil)
		}
		if writeErr == nil {
			_, writeErr = tx.ExecContext(ctx, d.Store.query(`INSERT INTO computer_cleanup_intents(runtime_id,incarnation,tenant_id,space_id,computer_id,provider,runtime_json,pending,attempts,next_attempt,token,updated_at) VALUES(?,?,?,?,?,?,?,TRUE,0,?,'',?) ON CONFLICT(runtime_id,incarnation) DO NOTHING`), r.ID, r.Incarnation, r.TenantID, r.SpaceID, r.ComputerID, provider, string(raw), now.UnixMilli(), now.UnixMilli())
		}
		if writeErr != nil {
			_ = tx.Rollback()
			if errors.Is(writeErr, sql.ErrNoRows) {
				continue
			}
			return destroyed, expired, writeErr
		}
		if writeErr = tx.Commit(); writeErr != nil {
			return destroyed, expired, writeErr
		}
	}
	removed, ended, retryErr := d.retryCleanup(ctx, now, limit)
	return destroyed + removed, expired + ended, retryErr
}

// QueueCleanup captures an immutable provider-owned destruction intent before
// deleting its owner. It performs no destruction or runtime state change. The
// caller must abort deletion on error; the durable row intentionally has no FK
// back to the owner. Retries keep the first captured identity and route.
func (d CleanupDeps) QueueCleanup(ctx context.Context, r Runtime) error {
	if r.ID == "" || r.Incarnation == "" || r.TenantID == "" || r.SpaceID == "" || r.ComputerID == "" {
		return errors.New("cleanup identity is incomplete")
	}
	var tenant, space, computer string
	err := d.Store.DB.QueryRowContext(ctx, d.Store.query(`SELECT tenant_id,space_id,computer_id FROM computer_cleanup_intents WHERE runtime_id=? AND incarnation=?`), r.ID, r.Incarnation).Scan(&tenant, &space, &computer)
	if err == nil {
		if tenant != r.TenantID || space != r.SpaceID || computer != r.ComputerID {
			return errors.New("cleanup intent identity mismatch")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	actual, err := d.Store.GetRuntime(ctx, target)
	if err != nil {
		return err
	}
	if actual.ExternalID != r.ExternalID || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || actual.RootPath != r.RootPath {
		return ErrTransitionConflict
	}
	provider, err := d.provider(ctx, actual)
	if err != nil {
		return err
	}
	destroyer := d.Destroyers[provider]
	if destroyer == nil {
		return ErrProviderUnavailable
	}
	snapshot := cleanupSnapshot{Runtime: actual}
	if capture, ok := destroyer.(CleanupSnapshotProvider); ok {
		snapshot.ProviderData, err = capture.CaptureCleanup(ctx, actual)
		if err != nil {
			return err
		}
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	now := d.now().UnixMilli()
	_, err = d.Store.DB.ExecContext(ctx, d.Store.query(`INSERT INTO computer_cleanup_intents(runtime_id,incarnation,tenant_id,space_id,computer_id,provider,runtime_json,pending,attempts,next_attempt,token,updated_at) VALUES(?,?,?,?,?,?,?,TRUE,0,?,'',?) ON CONFLICT(runtime_id,incarnation) DO NOTHING`), actual.ID, actual.Incarnation, actual.TenantID, actual.SpaceID, actual.ComputerID, provider, string(raw), now, now)
	return err
}

const cleanupAttemptLease = 2 * time.Minute

func cleanupToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func (d CleanupDeps) retryCleanup(ctx context.Context, now time.Time, limit int) (destroyed, expired int, err error) {
	type intent struct {
		RuntimeID, Incarnation, TenantID, SpaceID, ComputerID, Provider, Raw, Token string
		Next                                                                        int64
		Attempts                                                                    int
	}
	rows, err := d.Store.DB.QueryContext(ctx, d.Store.query(`SELECT runtime_id,incarnation,tenant_id,space_id,computer_id,provider,runtime_json,token,next_attempt,attempts FROM computer_cleanup_intents WHERE pending=TRUE AND next_attempt<=? ORDER BY next_attempt,runtime_id LIMIT ?`), now.UnixMilli(), limit)
	if err != nil {
		return 0, 0, err
	}
	var due []intent
	for rows.Next() {
		var i intent
		if err = rows.Scan(&i.RuntimeID, &i.Incarnation, &i.TenantID, &i.SpaceID, &i.ComputerID, &i.Provider, &i.Raw, &i.Token, &i.Next, &i.Attempts); err != nil {
			rows.Close()
			return 0, 0, err
		}
		due = append(due, i)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, 0, err
	}
	var failures []error
	for _, i := range due {
		destroyer := d.Destroyers[Provider(i.Provider)]
		if destroyer == nil {
			continue
		}
		var snapshot cleanupSnapshot
		if decodeErr := json.Unmarshal([]byte(i.Raw), &snapshot); decodeErr != nil {
			failures = append(failures, decodeErr)
			continue
		}
		r := snapshot.Runtime
		if r.ID != i.RuntimeID || r.Incarnation != i.Incarnation || r.TenantID != i.TenantID || r.SpaceID != i.SpaceID || r.ComputerID != i.ComputerID {
			failures = append(failures, errors.New("cleanup intent identity mismatch"))
			continue
		}
		token, tokenErr := cleanupToken()
		if tokenErr != nil {
			return destroyed, expired, tokenErr
		}
		result, claimErr := d.Store.DB.ExecContext(ctx, d.Store.query(`UPDATE computer_cleanup_intents SET token=?,attempts=attempts+1,next_attempt=?,updated_at=? WHERE runtime_id=? AND incarnation=? AND token=? AND pending=TRUE AND next_attempt=? AND next_attempt<=?`), token, now.Add(cleanupAttemptLease).UnixMilli(), now.UnixMilli(), i.RuntimeID, i.Incarnation, i.Token, i.Next, now.UnixMilli())
		if claimErr != nil {
			failures = append(failures, claimErr)
			continue
		}
		if requireRow(result, nil) != nil {
			continue
		}
		callCtx, cancel := context.WithTimeout(ctx, time.Minute)
		var destroyErr error
		if captured, ok := destroyer.(CleanupSnapshotProvider); ok {
			destroyErr = captured.DestroyCleanup(callCtx, r, snapshot.ProviderData)
		} else {
			destroyErr = destroyer.Destroy(callCtx, r)
		}
		cancel()
		done := d.now()
		stamp := done.UTC().Format(time.RFC3339Nano)
		tx, txErr := d.Store.DB.BeginTx(ctx, nil)
		if txErr != nil {
			return destroyed, expired, txErr
		}
		pending := destroyErr != nil
		var lastError any
		if destroyErr != nil {
			lastError = destroyErr.Error()
		}
		result, txErr = tx.ExecContext(ctx, d.Store.query(`UPDATE computer_cleanup_intents SET pending=?,last_error=?,next_attempt=?,updated_at=? WHERE runtime_id=? AND incarnation=? AND token=? AND pending=TRUE AND next_attempt>?`), pending, lastError, done.Add(time.Minute).UnixMilli(), done.UnixMilli(), i.RuntimeID, i.Incarnation, token, done.UnixMilli())
		if txErr == nil {
			txErr = requireRow(result, nil)
		}
		var terminalRows int64
		if txErr == nil {
			state := Destroyed
			if pending {
				state = Expired
			}
			var runtimeResult sql.Result
			runtimeResult, txErr = tx.ExecContext(ctx, d.Store.query(`UPDATE computer_runtimes SET state=?,last_error=?,updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND computer_id=? AND incarnation=? AND state='stopping'`), state, lastError, stamp, r.ID, r.TenantID, r.SpaceID, r.ComputerID, r.Incarnation)
			if txErr == nil {
				terminalRows, txErr = runtimeResult.RowsAffected()
			}
		}
		if txErr != nil {
			_ = tx.Rollback()
			failures = append(failures, fmt.Errorf("cleanup completion: %w", txErr))
			continue
		}
		if txErr = tx.Commit(); txErr != nil {
			return destroyed, expired, txErr
		}
		if terminalRows > 0 {
			if pending {
				expired++
			} else {
				destroyed++
			}
		}
	}
	return destroyed, expired, errors.Join(failures...)
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
