// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestACPCloseWithoutAttachedProcessDoesNotClaimAbsence(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp = manager
	actor := acpMCPUser(t, h)
	if _, err := h.closeACP(context.Background(), actor, agent.ID, session.ID); err == nil || !strings.Contains(err.Error(), "not attached") {
		t.Fatalf("unknown original process was reported closed: %v", err)
	}
	fake.mu.Lock()
	processes := fake.process
	fake.mu.Unlock()
	if processes != 0 {
		t.Fatal("close started a process to stop it")
	}
	state, err := manager.snapshot(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil || state != nil {
		t.Fatalf("absence was fabricated: %+v %v", state, err)
	}
}

func TestACPCloseRejectsBusyProtocolAndRetainsGrant(t *testing.T) {
	fake := &fakeACPAdapter{}
	manager, agent, session := acpAuthHarness(t, fake)
	h := manager.h
	h.acp = manager
	actor := acpMCPUser(t, h)
	rt, err := manager.ensure(httpx.WithPrincipal(context.Background(), actor), "tenant", agent.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	rt.authMu.Lock()
	_, err = h.closeACP(context.Background(), actor, agent.ID, session.ID)
	rt.authMu.Unlock()
	if err == nil {
		t.Fatal("busy protocol was closed")
	}
	select {
	case <-rt.done:
		t.Fatal("busy close changed process state")
	default:
	}
	var count int
	if err = h.deps.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?`, agent.SpaceID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("busy preflight retained an unrelated claim: %d %v", count, err)
	}
}
