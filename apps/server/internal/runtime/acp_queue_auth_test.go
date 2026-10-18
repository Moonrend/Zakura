// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func acpQueueFixture(t *testing.T) (*handler, *acpLiveRuntime, httpx.Principal) {
	t.Helper()
	h, rt, _ := acpMCPFixture(t)
	rt.mcpActor = &httpx.Principal{TenantID: "tenant", APIKey: true, APIKeyID: "key-tenant"}
	acpMCPDescriptor(t, rt)
	h.acp.runtimes[rt.tenantID+"\x00"+rt.sid] = rt
	h.service.acpQueueAdmission = h.admitACPQueue
	h.service.acpQueueRequired = h.requiresACPQueueReceipt
	if _, err := h.store.StartRunWith(context.Background(), rt.tenantID, rt.agentID, rt.sid, runStartSpec{Content: "active"}); err != nil {
		t.Fatal(err)
	}
	return h, rt, *rt.mcpActor
}
func TestACPQueueRejectsDifferentActorBeforeEnqueue(t *testing.T) {
	h, rt, actor := acpQueueFixture(t)
	other := httpx.Principal{TenantID: "tenant", UserID: "acp-user"}
	req := TurnRequest{Tenant: rt.tenantID, Agent: rt.agentID, Session: rt.sid, Content: "borrow tools", QueueOnConflict: true, UserID: actor.UserID}
	if _, _, err := h.service.Start(httpx.WithPrincipal(context.Background(), other), req); err == nil {
		t.Fatal("other actor queued using spoofed UserID")
	}
	pending, err := h.store.PendingQueue(context.Background(), rt.tenantID, rt.agentID, rt.sid)
	if err != nil || len(pending) != 0 {
		t.Fatalf("denied queue persisted %#v %v", pending, err)
	}
	if _, _, err := h.service.Start(context.Background(), req); err == nil {
		t.Fatal("actorless admission borrowed original actor")
	}
}
func TestACPQueueReceiptRestoresActorAndFencesReplay(t *testing.T) {
	for _, change := range []string{"none", "revoked", "edited", "rotation", "restart"} {
		t.Run(change, func(t *testing.T) {
			h, rt, actor := acpQueueFixture(t)
			_, queued, err := h.service.Start(httpx.WithPrincipal(context.Background(), actor), TurnRequest{Tenant: rt.tenantID, Agent: rt.agentID, Session: rt.sid, Content: "trusted followup", QueueOnConflict: true})
			if err != nil || queued == nil {
				t.Fatalf("admission %v %#v", err, queued)
			}
			switch change {
			case "revoked":
				_, _ = h.deps.DB.Exec(`UPDATE api_keys SET revoked_at=? WHERE id='key-tenant'`, runtimeTimeString(h.store.now()))
			case "edited":
				queued.Content = "edited by other actor"
			case "rotation":
				rt.revokeMCPGrant()
			case "restart":
				h.service.acpQueueReceipts = nil
			}
			other := httpx.WithPrincipal(context.Background(), httpx.Principal{TenantID: "tenant", UserID: "acp-user"})
			trusted, err := h.service.acpQueuedContext(other, rt.tenantID, rt.agentID, rt.sid, *queued)
			if change == "none" {
				if err != nil {
					t.Fatal(err)
				}
				p, _ := httpx.PrincipalFrom(trusted)
				if !sameACPMCPActor(p, actor) {
					t.Fatal("dequeue borrowed preceding run actor")
				}
				h.service.forgetACPQueueReceipt(rt.tenantID, rt.agentID, rt.sid, queued.ID)
				if len(h.service.acpQueueReceipts) != 0 {
					t.Fatal("delete/execution receipt release failed")
				}
			} else if err == nil {
				t.Fatalf("%s message reused original grant", change)
			}
		})
	}
}
func TestACPQueueReceiptExecutionGenerationAndCleanup(t *testing.T) {
	h, rt, actor := acpQueueFixture(t)
	_, queued, err := h.service.Start(httpx.WithPrincipal(context.Background(), actor), TurnRequest{Tenant: rt.tenantID, Agent: rt.agentID, Session: rt.sid, Content: "trusted followup", QueueOnConflict: true})
	if err != nil || queued == nil {
		t.Fatalf("admission %v %#v", err, queued)
	}
	trusted, err := h.service.acpQueuedContext(context.Background(), rt.tenantID, rt.agentID, rt.sid, *queued)
	if err != nil || validateACPQueueExecution(trusted, rt) != nil {
		t.Fatalf("valid execution failed: %v", err)
	}
	receipt := h.service.acpQueueReceipts[acpQueueKey(rt.tenantID, rt.agentID, rt.sid, queued.ID)]
	h.service.forgetACPQueueReceipt(rt.tenantID, rt.agentID, rt.sid, queued.ID)
	if receipt.timer.Stop() {
		t.Fatal("receipt timer retained runtime after release")
	}
	// Simulate reconnect after dequeue: even the same actor on a fresh grant
	// cannot turn an old queued message into a newly authorized message.
	acpMCPDescriptor(t, rt)
	if validateACPQueueExecution(trusted, rt) == nil {
		t.Fatal("old queue receipt accepted new grant generation")
	}
}

func TestACPQueueNoMCPPreservesLegacyQueueAndStorageBound(t *testing.T) {
	h, rt, _ := acpQueueFixture(t)
	rt.revokeMCPGrant()
	if _, err := h.deps.DB.Exec(`DELETE FROM agent_bindings WHERE tenant_id=?`, rt.tenantID); err != nil {
		t.Fatal(err)
	}
	if receipt, err := h.admitACPQueue(context.Background(), rt.tenantID, rt.agentID, rt.sid); receipt != nil || err != nil {
		t.Fatalf("no-MCP queue gained actor requirement %v %v", receipt, err)
	}
	if _, err := h.service.acpQueuedContext(context.Background(), rt.tenantID, rt.agentID, rt.sid, QueueMessage{ID: "legacy"}); err != nil {
		t.Fatalf("no-MCP legacy behavior changed: %v", err)
	}
	h.service.acpQueueReceipts = map[string]*acpQueueReceipt{}
	expires := h.store.now().Add(time.Minute)
	for i := 0; i < 4096; i++ {
		h.service.acpQueueReceipts[string(rune(i))] = &acpQueueReceipt{expires: expires}
	}
	receipt := &acpQueueReceipt{expires: expires}
	h.service.rememberACPQueueReceipt(rt.tenantID, rt.agentID, rt.sid, QueueMessage{ID: "overflow"}, receipt)
	if len(h.service.acpQueueReceipts) != 4096 || receipt.timer != nil {
		t.Fatal("receipt storage/timers exceeded bound")
	}
}

func TestACPQueueLegacySourcePreservedAndReportsResend(t *testing.T) {
	h, rt, _ := acpQueueFixture(t)
	if _, err := h.store.Enqueue(context.Background(), rt.tenantID, rt.agentID, rt.sid, QueueMessage{Content: "legacy unverified", UserID: "acp-user"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.deps.DB.Exec(`UPDATE cloud_agent_sessions SET active_run_id=NULL WHERE id=?`, rt.sid); err != nil {
		t.Fatal(err)
	}
	h.service.startNext(context.Background(), rt.tenantID, rt.agentID, rt.sid)
	pending, err := h.store.PendingQueue(context.Background(), rt.tenantID, rt.agentID, rt.sid)
	if err != nil || len(pending) != 1 {
		t.Fatalf("unverified message not retained %#v %v", pending, err)
	}
	var payload string
	if err := h.deps.DB.QueryRow(`SELECT payload_json FROM cloud_agent_events WHERE session_id=? AND type='queue.authorization_required'`, rt.sid).Scan(&payload); err != nil || !strings.Contains(payload, "resend") {
		t.Fatalf("missing resend event %q %v", payload, err)
	}
	var sess Session
	sess, err = h.store.GetSession(context.Background(), rt.tenantID, rt.agentID, rt.sid)
	if err != nil || sess.ActiveRunID != nil {
		t.Fatal("unverified queue started a run")
	}
}
