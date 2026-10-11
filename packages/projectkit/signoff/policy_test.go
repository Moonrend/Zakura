// SPDX-License-Identifier: AGPL-3.0-or-later
package signoff

import "testing"

func TestPolicyCanonicalOrderDoesNotChangeAuthorizationButRevisionDoes(t *testing.T) {
	rules := Rules{MinApprovals: 2, EligibleReviewerIDs: []string{"bob", "alice"}, EligibleRoles: []string{"member", "admin"}, ExpirySeconds: 3600}
	a, err := NewPolicy(rules, 1)
	if err != nil {
		t.Fatal(err)
	}
	other := rules
	other.EligibleReviewerIDs = []string{"alice", "bob"}
	other.EligibleRoles = []string{"admin", "member"}
	b, err := NewPolicy(other, 1)
	if err != nil || a.Hash != b.Hash {
		t.Fatal("equivalent set order changed policy", a, b, err)
	}
	if rules.EligibleReviewerIDs[0] != "bob" || rules.EligibleRoles[0] != "member" {
		t.Fatal("normalization modified caller configuration")
	}
	b, err = NewPolicy(other, 2)
	if err != nil || a.Hash == b.Hash {
		t.Fatal("new version reused old signature authority", err)
	}
	other.DisallowProjectCreator = true
	b, err = NewPolicy(other, 1)
	if err != nil || a.Hash == b.Hash {
		t.Fatal("creator exclusion not bound to policy", err)
	}
	for _, bad := range []Rules{{MinApprovals: 0, EligibleRoles: []string{"member"}}, {MinApprovals: 11, EligibleRoles: []string{"member"}}, {MinApprovals: 1, EligibleRoles: []string{}}, {MinApprovals: 1, EligibleRoles: []string{"platform_admin"}}, {MinApprovals: 1, EligibleRoles: []string{"member", "member"}}, {MinApprovals: 1, EligibleRoles: []string{"member"}, EligibleReviewerIDs: []string{"alice", "alice"}}, {MinApprovals: 1, EligibleRoles: []string{"member"}, ExpirySeconds: -1}, {MinApprovals: 1, EligibleRoles: []string{"member"}, ExpirySeconds: 604801}} {
		if _, err = NewPolicy(bad, 1); err == nil {
			t.Fatalf("unsafe/unbounded policy accepted %+v", bad)
		}
	}
	if p := DefaultPolicy(); p.Configured || p.Revision != 0 || p.MinApprovals != 1 || !Eligible(p, Member{UserID: "human", Role: "member"}, "human") {
		t.Fatal("default policy changed existing human-review semantics", p)
	}
}
