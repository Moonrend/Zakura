// SPDX-License-Identifier: AGPL-3.0-or-later
// Package signoff evaluates independent human approvals of immutable artifacts.
package signoff

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

type Rules struct {
	MinApprovals           int      `json:"minApprovals"`
	EligibleReviewerIDs    []string `json:"eligibleReviewerIds"`
	EligibleRoles          []string `json:"eligibleRoles"`
	DisallowProjectCreator bool     `json:"disallowProjectCreator"`
	ExpirySeconds          int64    `json:"expirySeconds"`
}
type Policy struct {
	Rules
	Revision   int64     `json:"revision"`
	Hash       string    `json:"hash"`
	Configured bool      `json:"configured"`
	UpdatedBy  string    `json:"updatedBy,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt,omitempty"`
}
type Member struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Role   string `json:"role"`
}
type Binding struct {
	PreviewID    string `json:"previewId"`
	RunID        string `json:"runId"`
	SnapshotID   string `json:"snapshotId"`
	EvidenceHash string `json:"evidenceHash"`
}
type Vote struct {
	ID                 string     `json:"id"`
	UserID             string     `json:"userId"`
	Role               string     `json:"role"`
	PolicyHash         string     `json:"policyHash"`
	PolicyRevision     int64      `json:"policyRevision"`
	Binding            Binding    `json:"binding"`
	PreviewRevision    int64      `json:"previewRevision"`
	Decision           string     `json:"decision"`
	Comment            string     `json:"comment"`
	Status             string     `json:"status"`
	Sequence           int64      `json:"sequence"`
	CreatedAt          time.Time  `json:"createdAt"`
	WithdrawnAt        *time.Time `json:"withdrawnAt,omitempty"`
	WithdrawalSequence int64      `json:"withdrawalSequence,omitempty"`
}
type EvaluatedVote struct {
	Vote
	Counted bool   `json:"counted"`
	Reason  string `json:"reason"`
}
type Participant struct {
	UserID     string    `json:"userId"`
	VoteID     string    `json:"voteId"`
	CreatedAt  time.Time `json:"createdAt"`
	SnapshotID string    `json:"snapshotId"`
}
type Evidence struct {
	PolicyRevision int64         `json:"policyRevision"`
	PolicyHash     string        `json:"policyHash"`
	Binding        Binding       `json:"binding"`
	Required       int           `json:"required"`
	Participants   []Participant `json:"participants"`
}
type Summary struct {
	Policy         Policy          `json:"policy"`
	Binding        Binding         `json:"binding"`
	Approvals      int             `json:"approvals"`
	Required       int             `json:"required"`
	EligibleCount  int             `json:"eligibleCount"`
	Quorum         bool            `json:"quorum"`
	Rejected       bool            `json:"rejected"`
	CanReachQuorum bool            `json:"canReachQuorum"`
	Votes          []EvaluatedVote `json:"votes"`
	Evidence       *Evidence       `json:"evidence,omitempty"`
	EvaluatedAt    time.Time       `json:"evaluatedAt"`
	LegacyApproval bool            `json:"legacyApproval,omitempty"`
}

func Normalize(r Rules) (Rules, error) {
	if r.MinApprovals < 1 || r.MinApprovals > 10 || len(r.EligibleReviewerIDs) > 32 || len(r.EligibleRoles) == 0 || len(r.EligibleRoles) > 3 || r.ExpirySeconds < 0 || r.ExpirySeconds > 7*24*60*60 {
		return Rules{}, errors.New("invalid approval policy bounds")
	}
	r.EligibleReviewerIDs = append([]string{}, r.EligibleReviewerIDs...)
	r.EligibleRoles = append([]string{}, r.EligibleRoles...)
	for _, values := range [][]string{r.EligibleReviewerIDs, r.EligibleRoles} {
		seen := map[string]bool{}
		for _, v := range values {
			if v == "" || len(v) > 128 || strings.TrimSpace(v) != v || seen[v] {
				return Rules{}, errors.New("empty, duplicate or invalid reviewer/role")
			}
			seen[v] = true
		}
		sort.Strings(values)
	}
	for _, v := range r.EligibleRoles {
		if v != "owner" && v != "admin" && v != "member" {
			return Rules{}, errors.New("invalid eligible member role")
		}
	}
	return r, nil
}
func NewPolicy(r Rules, revision int64) (Policy, error) {
	n, err := Normalize(r)
	if err != nil || revision < 0 {
		if err == nil {
			err = errors.New("invalid policy revision")
		}
		return Policy{}, err
	}
	raw, _ := json.Marshal(struct {
		Rules
		Revision int64 `json:"revision"`
	}{n, revision})
	h := sha256.Sum256(raw)
	return Policy{Rules: n, Revision: revision, Hash: hex.EncodeToString(h[:]), Configured: revision > 0}, nil
}
func DefaultPolicy() Policy {
	p, _ := NewPolicy(Rules{MinApprovals: 1, EligibleReviewerIDs: []string{}, EligibleRoles: []string{"owner", "admin", "member"}}, 0)
	return p
}
func Eligible(p Policy, m Member, creator string) bool {
	if m.UserID == "" || (p.DisallowProjectCreator && m.UserID == creator) {
		return false
	}
	roleOK := false
	for _, role := range p.EligibleRoles {
		if role == m.Role {
			roleOK = true
		}
	}
	if !roleOK {
		return false
	}
	if len(p.EligibleReviewerIDs) == 0 {
		return true
	}
	for _, id := range p.EligibleReviewerIDs {
		if id == m.UserID {
			return true
		}
	}
	return false
}

// Evaluate never trusts the role stored with a vote. Members must reflect current
// active human memberships. Durable sequence, not clock ordering, breaks ties.
func Evaluate(p Policy, b Binding, votes []Vote, members map[string]Member, creator string, eligibleCount int, now time.Time) Summary {
	s := Summary{Policy: p, Binding: b, Required: p.MinApprovals, EligibleCount: eligibleCount, CanReachQuorum: eligibleCount >= p.MinApprovals, Votes: []EvaluatedVote{}, EvaluatedAt: now}
	votes = append([]Vote{}, votes...)
	sort.Slice(votes, func(i, j int) bool {
		if votes[i].Sequence != votes[j].Sequence {
			return votes[i].Sequence < votes[j].Sequence
		}
		return votes[i].ID < votes[j].ID
	})
	seen := map[string]bool{}
	participants := []Participant{}
	for _, v := range votes {
		e := EvaluatedVote{Vote: v}
		switch {
		case v.Status != "active":
			e.Reason = "withdrawn"
		case v.PolicyHash != p.Hash || v.PolicyRevision != p.Revision:
			e.Reason = "policy_changed"
		case v.Binding != b:
			e.Reason = "artifact_changed"
		case v.CreatedAt.After(now):
			e.Reason = "future_timestamp"
		case p.ExpirySeconds > 0 && !now.Before(v.CreatedAt.Add(time.Duration(p.ExpirySeconds)*time.Second)):
			e.Reason = "expired"
		case members[v.UserID].UserID == "":
			e.Reason = "inactive_member"
		case !Eligible(p, members[v.UserID], creator):
			e.Reason = "ineligible_member"
		case seen[v.UserID]:
			e.Reason = "duplicate_reviewer"
		case v.Decision == "rejected":
			seen[v.UserID] = true
			s.Rejected = true
			e.Reason = "rejected"
		case v.Decision != "approved":
			e.Reason = "invalid_decision"
		default:
			seen[v.UserID] = true
			s.Approvals++
			e.Counted = true
			e.Reason = "counted"
			participants = append(participants, Participant{v.UserID, v.ID, v.CreatedAt, b.SnapshotID})
		}
		s.Votes = append(s.Votes, e)
	}
	s.Quorum = s.Approvals >= p.MinApprovals && !s.Rejected && s.CanReachQuorum
	if s.Quorum {
		s.Evidence = &Evidence{PolicyRevision: p.Revision, PolicyHash: p.Hash, Binding: b, Required: p.MinApprovals, Participants: participants}
	}
	return s
}
