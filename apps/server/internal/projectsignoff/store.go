// SPDX-License-Identifier: AGPL-3.0-or-later
package projectsignoff

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/signoff"
)

var ErrNotFound = projectexec.ErrNotFound
var ErrConflict = projectexec.ErrConflict
var ErrInvalid = projectexec.ErrInvalidState

const MaxVotes = 2000

type Store struct {
	db      *sql.DB
	dialect string
	rebind  func(string) string
	now     func() time.Time
}
type Reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func NewStore(db *sql.DB, dialect string, rebind func(string) string, clocks ...func() time.Time) *Store {
	if rebind == nil {
		rebind = func(q string) string { return q }
	}
	now := func() time.Time { return time.Now().UTC() }
	if len(clocks) > 0 && clocks[0] != nil {
		now = clocks[0]
	}
	return &Store{db: db, dialect: dialect, rebind: rebind, now: now}
}
func invalid(s string) error       { return fmt.Errorf("%w: %s", ErrInvalid, s) }
func stamp(t time.Time) string     { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func encode(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
func newID() (string, error) {
	var b [16]byte
	_, e := rand.Read(b[:])
	return hex.EncodeToString(b[:]), e
}

func (s *Store) GetPolicy(ctx context.Context, p mission.Project) (signoff.Policy, error) {
	return s.GetPolicyTx(ctx, s.db, p)
}
func (s *Store) GetPolicyTx(ctx context.Context, q Reader, p mission.Project) (signoff.Policy, error) {
	var raw string
	err := q.QueryRowContext(ctx, s.rebind(`SELECT policy_json FROM execution_signoff_policies WHERE tenant_id=? AND project_id=?`), p.TenantID, p.ID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return signoff.DefaultPolicy(), nil
	}
	if err != nil {
		return signoff.Policy{}, err
	}
	var out signoff.Policy
	if err = json.Unmarshal([]byte(raw), &out); err != nil {
		return out, err
	}
	canonical, err := signoff.NewPolicy(out.Rules, out.Revision)
	if err != nil || out.Revision < 1 || !out.Configured || canonical.Hash != out.Hash {
		return out, invalid("stored signoff policy is invalid")
	}
	return out, nil
}
func (s *Store) Member(ctx context.Context, q Reader, tenant, user string) (signoff.Member, error) {
	var m signoff.Member
	err := q.QueryRowContext(ctx, s.rebind(`SELECT m.user_id,COALESCE(u.name,''),m.role FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND u.suspended_at IS NULL`), tenant, user).Scan(&m.UserID, &m.Name, &m.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}
func (s *Store) Members(ctx context.Context, p mission.Project) ([]signoff.Member, bool, error) {
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT m.user_id,COALESCE(u.name,''),m.role FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.status='active' AND u.status='active' AND u.suspended_at IS NULL ORDER BY m.user_id LIMIT 501`), p.TenantID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []signoff.Member{}
	for rows.Next() {
		var m signoff.Member
		if err = rows.Scan(&m.UserID, &m.Name, &m.Role); err != nil {
			return nil, false, err
		}
		out = append(out, m)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(out) > 500
	if truncated {
		out = out[:500]
	}
	return out, truncated, nil
}
func (s *Store) eligibleCount(ctx context.Context, q Reader, p mission.Project, policy signoff.Policy) (int, error) {
	query := `SELECT COUNT(*) FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.status='active' AND u.status='active' AND u.suspended_at IS NULL AND m.role IN (`
	args := []any{p.TenantID}
	for i, role := range policy.EligibleRoles {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, role)
	}
	query += ")"
	if len(policy.EligibleReviewerIDs) > 0 {
		query += ` AND m.user_id IN (`
		for i, id := range policy.EligibleReviewerIDs {
			if i > 0 {
				query += ","
			}
			query += "?"
			args = append(args, id)
		}
		query += ")"
	}
	if policy.DisallowProjectCreator {
		query += ` AND m.user_id<>?`
		args = append(args, p.CreatedBy)
	}
	var n int
	err := q.QueryRowContext(ctx, s.rebind(query), args...).Scan(&n)
	return n, err
}

// SetPolicyTx requires the caller's project mutation lock and active-tenant check.
// This method never takes a tenant write lock: publication uses the same order.
func (s *Store) SetPolicyTx(ctx context.Context, tx *sql.Tx, p mission.Project, expected int64, rules signoff.Rules, author string) (signoff.Policy, error) {
	member, err := s.Member(ctx, tx, p.TenantID, author)
	if err != nil {
		return signoff.Policy{}, err
	}
	if member.Role != "owner" && member.Role != "admin" {
		return signoff.Policy{}, invalid("policy configuration requires current owner/admin membership")
	}
	old, err := s.GetPolicyTx(ctx, tx, p)
	if err != nil {
		return old, err
	}
	if old.Revision != expected {
		return old, ErrConflict
	}
	if old.Revision >= 10000 {
		return old, invalid("policy revision limit reached")
	}
	out, err := signoff.NewPolicy(rules, old.Revision+1)
	if err != nil {
		return out, invalid(err.Error())
	}
	for _, id := range out.EligibleReviewerIDs {
		if _, err = s.Member(ctx, tx, p.TenantID, id); err != nil {
			return out, invalid("eligible reviewers must be active tenant members")
		}
	}
	n, err := s.eligibleCount(ctx, tx, p, out)
	if err != nil {
		return out, err
	}
	if n < out.MinApprovals {
		return out, invalid("not enough currently eligible independent reviewers")
	}
	out.UpdatedBy = author
	out.UpdatedAt = s.now()
	raw, err := encode(out)
	if err != nil {
		return out, err
	}
	if old.Configured {
		var result sql.Result
		result, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_signoff_policies SET revision=?,policy_json=? WHERE tenant_id=? AND project_id=? AND revision=?`), out.Revision, raw, p.TenantID, p.ID, old.Revision)
		if err == nil {
			var affected int64
			affected, err = result.RowsAffected()
			if err == nil && affected != 1 {
				err = ErrConflict
			}
		}
	} else {
		_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_signoff_policies(tenant_id,project_id,revision,policy_json) VALUES(?,?,?,?)`), p.TenantID, p.ID, out.Revision, raw)
	}
	if err != nil {
		return out, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_signoff_policy_revisions(tenant_id,project_id,revision,policy_json) VALUES(?,?,?,?)`), p.TenantID, p.ID, out.Revision, raw)
	if err != nil {
		return out, err
	}
	_, err = s.event(ctx, tx, p, "", "signoff.policy_updated", map[string]any{"policyRevision": out.Revision, "policyHash": out.Hash, "authorId": author})
	return out, err
}
func (s *Store) History(ctx context.Context, p mission.Project) ([]signoff.Policy, error) {
	rows, err := s.db.QueryContext(ctx, s.rebind(`SELECT policy_json FROM execution_signoff_policy_revisions WHERE tenant_id=? AND project_id=? ORDER BY revision DESC LIMIT 100`), p.TenantID, p.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []signoff.Policy{}
	for rows.Next() {
		var raw string
		var policy signoff.Policy
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &policy); err != nil {
			return nil, err
		}
		out = append(out, policy)
	}
	return out, rows.Err()
}
func (s *Store) SummaryTx(ctx context.Context, q Reader, p mission.Project, b signoff.Binding) (signoff.Summary, error) {
	policy, err := s.GetPolicyTx(ctx, q, p)
	if err != nil {
		return signoff.Summary{}, err
	}
	rows, err := q.QueryContext(ctx, s.rebind(`SELECT vote_json FROM execution_signoff_votes WHERE tenant_id=? AND project_id=? AND run_id=? AND preview_id=? ORDER BY sequence,id LIMIT 2001`), p.TenantID, p.ID, b.RunID, b.PreviewID)
	if err != nil {
		return signoff.Summary{}, err
	}
	votes := []signoff.Vote{}
	for rows.Next() {
		var raw string
		var v signoff.Vote
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return signoff.Summary{}, err
		}
		if err = json.Unmarshal([]byte(raw), &v); err != nil {
			rows.Close()
			return signoff.Summary{}, err
		}
		votes = append(votes, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return signoff.Summary{}, err
	}
	if len(votes) > MaxVotes {
		return signoff.Summary{}, invalid("signoff audit limit exceeded")
	}
	rows, err = q.QueryContext(ctx, s.rebind(`SELECT DISTINCT m.user_id,COALESCE(u.name,''),m.role FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN execution_signoff_votes v ON v.tenant_id=m.tenant_id AND v.user_id=m.user_id WHERE v.tenant_id=? AND v.project_id=? AND v.run_id=? AND v.preview_id=? AND m.status='active' AND u.status='active' AND u.suspended_at IS NULL`), p.TenantID, p.ID, b.RunID, b.PreviewID)
	if err != nil {
		return signoff.Summary{}, err
	}
	members := map[string]signoff.Member{}
	for rows.Next() {
		var m signoff.Member
		if err = rows.Scan(&m.UserID, &m.Name, &m.Role); err != nil {
			rows.Close()
			return signoff.Summary{}, err
		}
		members[m.UserID] = m
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return signoff.Summary{}, err
	}
	n, err := s.eligibleCount(ctx, q, p, policy)
	if err != nil {
		return signoff.Summary{}, err
	}
	return signoff.Evaluate(policy, b, votes, members, p.CreatedBy, n, s.now()), nil
}
func (s *Store) RecordTx(ctx context.Context, tx *sql.Tx, p mission.Project, b signoff.Binding, previewRevision int64, reviewer, role, decision, comment string) (signoff.Summary, error) {
	if reviewer == "" || (decision != "approved" && decision != "rejected") || strings.TrimSpace(comment) == "" || len(comment) > 16000 || !utf8.ValidString(comment) {
		return signoff.Summary{}, invalid("human review decision and comment required")
	}
	summary, err := s.SummaryTx(ctx, tx, p, b)
	if err != nil {
		return summary, err
	}
	if len(summary.Votes) >= MaxVotes {
		return summary, invalid("signoff audit limit reached")
	}
	member, err := s.Member(ctx, tx, p.TenantID, reviewer)
	if err != nil {
		return summary, invalid("reviewer membership is inactive")
	}
	if member.Role != role {
		return summary, ErrConflict
	}
	if !signoff.Eligible(summary.Policy, member, p.CreatedBy) {
		return summary, invalid("reviewer is not eligible under current policy")
	}
	if !summary.CanReachQuorum {
		return summary, invalid("policy has too few eligible reviewers")
	}
	for _, v := range summary.Votes {
		if v.UserID == reviewer && v.Status == "active" && v.PolicyHash == summary.Policy.Hash && v.Binding == b {
			return summary, ErrConflict
		}
	}
	id, err := newID()
	if err != nil {
		return summary, err
	}
	v := signoff.Vote{ID: id, UserID: reviewer, Role: member.Role, PolicyHash: summary.Policy.Hash, PolicyRevision: summary.Policy.Revision, Binding: b, PreviewRevision: previewRevision, Decision: decision, Comment: comment, Status: "active", CreatedAt: s.now()}
	v.Sequence, err = s.event(ctx, tx, p, b.RunID, "signoff.vote_recorded", map[string]any{"voteId": v.ID, "previewId": b.PreviewID, "snapshotId": b.SnapshotID, "policyHash": v.PolicyHash, "reviewerId": reviewer, "decision": decision})
	if err != nil {
		return summary, err
	}
	raw, err := encode(v)
	if err != nil {
		return summary, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_signoff_votes(id,tenant_id,project_id,run_id,preview_id,user_id,policy_hash,evidence_hash,status,sequence,vote_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`), id, p.TenantID, p.ID, b.RunID, b.PreviewID, reviewer, v.PolicyHash, b.EvidenceHash, v.Status, v.Sequence, raw)
	if err != nil {
		return summary, err
	}
	return s.SummaryTx(ctx, tx, p, b)
}
func (s *Store) WithdrawTx(ctx context.Context, tx *sql.Tx, p mission.Project, b signoff.Binding, voteID, author string) (signoff.Summary, error) {
	if _, err := s.Member(ctx, tx, p.TenantID, author); err != nil {
		return signoff.Summary{}, invalid("withdrawal requires active human membership")
	}
	var raw string
	err := tx.QueryRowContext(ctx, s.rebind(`SELECT vote_json FROM execution_signoff_votes WHERE tenant_id=? AND project_id=? AND run_id=? AND preview_id=? AND id=? AND user_id=? AND status='active'`), p.TenantID, p.ID, b.RunID, b.PreviewID, voteID, author).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return signoff.Summary{}, ErrNotFound
	}
	if err != nil {
		return signoff.Summary{}, err
	}
	var v signoff.Vote
	if err = json.Unmarshal([]byte(raw), &v); err != nil {
		return signoff.Summary{}, err
	}
	if v.Binding != b {
		return signoff.Summary{}, ErrConflict
	}
	now := s.now()
	v.Status = "withdrawn"
	v.WithdrawnAt = &now
	v.WithdrawalSequence, err = s.event(ctx, tx, p, b.RunID, "signoff.vote_withdrawn", map[string]any{"voteId": v.ID, "previewId": b.PreviewID, "reviewerId": author})
	if err != nil {
		return signoff.Summary{}, err
	}
	raw, err = encode(v)
	if err != nil {
		return signoff.Summary{}, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`UPDATE execution_signoff_votes SET status='withdrawn',vote_json=? WHERE tenant_id=? AND project_id=? AND id=? AND user_id=? AND status='active'`), raw, p.TenantID, p.ID, v.ID, author)
	if err != nil {
		return signoff.Summary{}, err
	}
	return s.SummaryTx(ctx, tx, p, b)
}
func (s *Store) event(ctx context.Context, tx *sql.Tx, p mission.Project, runID, kind string, payload any) (int64, error) {
	_, err := tx.ExecContext(ctx, s.rebind(`UPDATE execution_projects SET event_sequence=event_sequence+1 WHERE tenant_id=? AND id=?`), p.TenantID, p.ID)
	if err != nil {
		return 0, err
	}
	var sequence int64
	if err = tx.QueryRowContext(ctx, s.rebind(`SELECT event_sequence FROM execution_projects WHERE tenant_id=? AND id=?`), p.TenantID, p.ID).Scan(&sequence); err != nil {
		return 0, err
	}
	id, err := newID()
	if err != nil {
		return 0, err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	event := mission.Event{ID: id, ProjectID: p.ID, RunID: runID, Sequence: sequence, Kind: kind, Payload: data, CreatedAt: s.now()}
	raw, err := encode(event)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(ctx, s.rebind(`INSERT INTO execution_events(id,tenant_id,project_id,run_id,task_id,sequence,event_json,created_at) VALUES(?,?,?,?,'',?,?,?)`), id, p.TenantID, p.ID, runID, sequence, raw, stamp(event.CreatedAt))
	return sequence, err
}
