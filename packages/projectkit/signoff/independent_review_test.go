// SPDX-License-Identifier: AGPL-3.0-or-later
package signoff

import (
	"testing"
	"time"
)

func independentSignoffFixture(t *testing.T) (Policy, Binding, map[string]Member, []Vote, time.Time) {
	t.Helper()
	p, err := NewPolicy(Rules{MinApprovals: 2, EligibleRoles: []string{"owner", "admin", "member"}, ExpirySeconds: 60}, 1)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	b := Binding{PreviewID: "preview", RunID: "run", SnapshotID: "snapshot", EvidenceHash: "exact-artifact-proof"}
	members := map[string]Member{"a": {UserID: "a", Role: "admin"}, "b": {UserID: "b", Role: "member"}}
	votes := []Vote{
		{ID: "vote-a", UserID: "a", Role: "owner", PolicyHash: p.Hash, PolicyRevision: p.Revision, Binding: b, PreviewRevision: 1, Decision: "approved", Status: "active", Sequence: 10, CreatedAt: now.Add(-10 * time.Second)},
		{ID: "vote-b", UserID: "b", Role: "owner", PolicyHash: p.Hash, PolicyRevision: p.Revision, Binding: b, PreviewRevision: 2, Decision: "approved", Status: "active", Sequence: 11, CreatedAt: now.Add(-5 * time.Second)},
	}
	return p, b, members, votes, now
}

func TestIndependentSignoffCurrentAuthorityAndArtifactBinding(t *testing.T) {
	p, b, members, votes, now := independentSignoffFixture(t)
	s := Evaluate(p, b, votes, members, "creator", 2, now)
	if !s.Quorum || s.Evidence == nil || len(s.Evidence.Participants) != 2 {
		t.Fatalf("two distinct current members must satisfy quorum: %+v", s)
	}
	// Each vote advanced the mutable preview revision. Its artifact evidence did
	// not change, so the first reviewer must remain in the published proof.
	if s.Evidence.Participants[0].VoteID != "vote-a" || s.Evidence.Binding != b {
		t.Fatalf("approval provenance lost: %+v", s.Evidence)
	}
	for _, tc := range []struct {
		name   string
		change func(*Policy, *Binding, map[string]Member, []Vote)
		reason string
	}{
		{"removed member", func(_ *Policy, _ *Binding, m map[string]Member, _ []Vote) { delete(m, "a") }, "inactive_member"},
		{"current role overrides vote role", func(p *Policy, _ *Binding, m map[string]Member, _ []Vote) {
			p.EligibleRoles = []string{"admin"}
			m["a"] = Member{UserID: "a", Role: "member"}
		}, "ineligible_member"},
		{"policy hash", func(p *Policy, _ *Binding, _ map[string]Member, _ []Vote) { p.Hash = "new-policy" }, "policy_changed"},
		{"policy revision", func(p *Policy, _ *Binding, _ map[string]Member, _ []Vote) { p.Revision++ }, "policy_changed"},
		{"snapshot", func(_ *Policy, b *Binding, _ map[string]Member, _ []Vote) { b.SnapshotID = "other-snapshot" }, "artifact_changed"},
		{"run", func(_ *Policy, b *Binding, _ map[string]Member, _ []Vote) { b.RunID = "other-run" }, "artifact_changed"},
		{"preview", func(_ *Policy, b *Binding, _ map[string]Member, _ []Vote) { b.PreviewID = "other-preview" }, "artifact_changed"},
		{"verification evidence", func(_ *Policy, b *Binding, _ map[string]Member, _ []Vote) { b.EvidenceHash = "other-proof" }, "artifact_changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, b, members, votes, now := independentSignoffFixture(t)
			tc.change(&p, &b, members, votes)
			s := Evaluate(p, b, votes, members, "creator", 2, now)
			if s.Quorum || s.Evidence != nil || s.Votes[0].Counted || s.Votes[0].Reason != tc.reason {
				t.Fatalf("stale authority or artifact must not release: %+v", s)
			}
		})
	}
	// A configured quorum cannot remain usable after its eligible set shrinks,
	// even if a caller supplies the historical votes separately.
	s = Evaluate(p, b, votes, members, "creator", 1, now)
	if s.Quorum || s.CanReachQuorum || s.Evidence != nil {
		t.Fatalf("unreachable quorum released: %+v", s)
	}
}

func TestIndependentSignoffExpiryClockAndDurableWithdrawal(t *testing.T) {
	p, b, members, votes, now := independentSignoffFixture(t)
	for _, tc := range []struct {
		name   string
		time   time.Time
		reason string
	}{
		{"before expiry", votes[0].CreatedAt.Add(60*time.Second - time.Nanosecond), "counted"},
		{"at expiry", votes[0].CreatedAt.Add(60 * time.Second), "expired"},
		{"clock rolled before signing", votes[0].CreatedAt.Add(-time.Nanosecond), "future_timestamp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := Evaluate(p, b, votes, members, "creator", 2, tc.time)
			if s.Votes[0].Reason != tc.reason {
				t.Fatalf("wrong boundary evaluation: %+v", s)
			}
			if tc.reason != "counted" && (s.Quorum || s.Evidence != nil) {
				t.Fatalf("expired/future signature released: %+v", s)
			}
		})
	}
	withdrawn := now.Add(-30 * time.Second) // The wall clock rolled back.
	votes[0].Status = "withdrawn"
	votes[0].WithdrawnAt = &withdrawn
	votes[0].WithdrawalSequence = 12
	s := Evaluate(p, b, votes, members, "creator", 2, now)
	if s.Quorum || s.Votes[0].Reason != "withdrawn" || s.Approvals != 1 {
		t.Fatalf("clock ordering revived withdrawn vote: %+v", s)
	}
	// The reviewer may sign again after withdrawal. Sequence, not the new
	// signature's older wall-clock timestamp, determines audit ordering.
	v := votes[0]
	v.ID, v.Status, v.Sequence = "vote-a-again", "active", 13
	v.CreatedAt, v.WithdrawnAt, v.WithdrawalSequence = now.Add(-20*time.Second), nil, 0
	votes = append(votes, v)
	s = Evaluate(p, b, votes, members, "creator", 2, now)
	if !s.Quorum || s.Evidence == nil || s.Evidence.Participants[1].VoteID != v.ID {
		t.Fatalf("fresh approval missing after durable withdrawal: %+v", s)
	}
}

func TestIndependentSignoffDuplicateRejectionAndUnknownDecision(t *testing.T) {
	p, b, members, votes, now := independentSignoffFixture(t)
	dup := votes[0]
	dup.ID, dup.Sequence = "duplicate-a", 12
	s := Evaluate(p, b, []Vote{votes[0], dup}, members, "creator", 2, now)
	if s.Approvals != 1 || s.Quorum || s.Votes[1].Reason != "duplicate_reviewer" {
		t.Fatalf("one person supplied quorum: %+v", s)
	}
	votes[1].Decision = "rejected"
	s = Evaluate(p, b, votes, members, "creator", 2, now)
	if !s.Rejected || s.Quorum || s.Evidence != nil {
		t.Fatalf("explicit rejection failed to block release: %+v", s)
	}
	votes[1].Decision = "unknown-source-effect"
	s = Evaluate(p, b, votes, members, "creator", 2, now)
	if s.Rejected || s.Quorum || s.Approvals != 1 || s.Votes[1].Reason != "invalid_decision" {
		t.Fatalf("unknown decision interpreted as approval: %+v", s)
	}
	// An unknown decision must not consume a reviewer's future valid signature.
	v := votes[1]
	v.ID, v.Sequence, v.Decision = "valid-b", 14, "approved"
	s = Evaluate(p, b, append(votes, v), members, "creator", 2, now)
	if !s.Quorum || s.Evidence == nil || len(s.Evidence.Participants) != 2 {
		t.Fatalf("invalid decision poisoned later signature: %+v", s)
	}
}
