// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestACPTerminalAuthBridgeFinalizationOrder(t *testing.T) {
	zero, nonzero := 0, 7
	for _, tc := range []struct {
		name                                string
		started, known                      bool
		code                                *int
		cleanupErr, releaseErr, completeErr error
		want                                []string
		fail                                bool
	}{
		{name: "success", started: true, known: true, code: &zero, want: []string{"cleanup", "release", "reconnect"}},
		{name: "nonzero", started: true, known: true, code: &nonzero, want: []string{"cleanup", "release"}},
		{name: "unknown-exit", started: true, known: true, want: []string{"cleanup", "release"}},
		{name: "preflight-no-remote", known: true, want: []string{"release"}},
		{name: "unknown-create", started: true, code: &zero, want: []string{"cleanup"}, fail: true},
		{name: "cleanup-failed", started: true, known: true, code: &zero, cleanupErr: errors.New("offline"), want: []string{"cleanup"}, fail: true},
		{name: "release-failed", started: true, known: true, code: &zero, releaseErr: errors.New("db unavailable"), want: []string{"cleanup", "release"}, fail: true},
		{name: "reconnect-failed", started: true, known: true, code: &zero, completeErr: errors.New("auth required"), want: []string{"cleanup", "release", "reconnect"}, fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			err := finishACPTerminalAuthBridge(tc.started, tc.known, tc.code, func() error { order = append(order, "cleanup"); return tc.cleanupErr }, func() error { order = append(order, "release"); return tc.releaseErr }, func() error { order = append(order, "reconnect"); return tc.completeErr })
			if (err != nil) != tc.fail || !reflect.DeepEqual(order, tc.want) {
				t.Fatalf("order=%v want=%v error=%v", order, tc.want, err)
			}
		})
	}
}

func TestACPTerminalAuthDescriptorCannotRedirectProfileHome(t *testing.T) {
	attempt := &acpTerminalAuthAttempt{ticket: acpTerminalAuthTicket{acpLoginTicket: acpLoginTicket{Profile: "codex"}}, descriptor: acpTerminalAuthDescriptor{Env: map[string]string{"HOME": "/tmp/other", "XDG_CONFIG_HOME": "/etc", "XDG_DATA_HOME": "/outside", "LOGIN_MODE": "interactive"}}}
	env := acpTerminalAuthEnvironment(attempt)
	if env["HOME"] != "/workspace/.zakura/acp/codex/home" || env["XDG_CONFIG_HOME"] != "/workspace/.zakura/acp/codex/home/.config" || env["XDG_DATA_HOME"] != "/workspace/.zakura/acp/codex/home/.local/share" || env["LOGIN_MODE"] != "interactive" {
		t.Fatalf("credential storage redirected: %#v", env)
	}
	if attempt.descriptor.Env["HOME"] != "/tmp/other" {
		t.Fatal("mutated hashed descriptor")
	}
}

func TestACPTerminalAuthUnstartedReleaseIsExactNonce(t *testing.T) {
	h, _, agent, session, _ := terminalAuthHarness(t)
	attempt, err := h.resolveACPTerminalAuth(context.Background(), "tenant", agent.ID, session.ID, "tty")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.issueACPTerminalAuth(context.Background(), attempt, acpLoginPrincipal()); err != nil {
		t.Fatal(err)
	}
	if err = h.releaseUnstartedACPTerminalAuth(attempt); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE tenant_id='tenant' AND space_id=? AND profile_id='codex'`, agent.SpaceID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unstarted lock retained: count=%d %v", count, err)
	}
	// A stale request must not release a newer replacement lease.
	_, err = h.deps.DB.Exec(`INSERT INTO acp_profile_auth_locks(tenant_id,space_id,profile_id,token,kind,expires_at,updated_at) VALUES('tenant',?,'codex','replacement','terminal',9999999999999,0)`, agent.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.releaseUnstartedACPTerminalAuth(attempt); err != nil {
		t.Fatal(err)
	}
	if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM acp_profile_auth_locks WHERE token='replacement'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("stale release removed replacement: count=%d %v", count, err)
	}
}
