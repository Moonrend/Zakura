// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPStartFailureReleasesOnlyConfirmedCleanup(t *testing.T) {
	for _, phase := range []string{"initialize", "session/new"} {
		for _, failClose := range []bool{false, true} {
			name := phase + "/cleaned"
			if failClose {
				name = phase + "/unknown"
			}
			t.Run(name, func(t *testing.T) {
				fake := &fakeACPAdapter{failClose: failClose}
				fake.onRPC = func(process string, rpc map[string]any, send func(any)) bool {
					if process == "pty-1" && rpc["method"] == phase {
						send(map[string]any{"jsonrpc": "2.0", "id": rpc["id"], "error": map[string]any{"code": -32603, "message": "fixture startup failed"}})
						return true
					}
					return false
				}
				manager, agent, session := acpAuthHarness(t, fake)
				manager.h.acp = manager
				ctx := context.Background()
				if _, err := manager.ensure(ctx, "tenant", agent.ID, session.ID); err == nil {
					t.Fatal("startup unexpectedly succeeded")
				}
				assertACPInfrastructureClaims(t, manager.h, agent.SpaceID, failClose)
				state, err := manager.snapshot(ctx, "tenant", agent.ID, session.ID)
				if err != nil || state["state"] != "error" || state["processClosed"] != !failClose {
					t.Fatalf("startup lifecycle lost: %+v %v", state, err)
				}
				manager.mu.Lock()
				retained := manager.runtimes["tenant\x00"+session.ID]
				manager.mu.Unlock()
				if retained == nil {
					t.Fatal("startup discarded the original process handle")
				}
				if failClose {
					if _, err = manager.ensure(ctx, "tenant", agent.ID, session.ID); !errors.Is(err, errACPCleanupUnconfirmed) {
						t.Fatalf("uncertain process was retried: %v", err)
					}
					return
				}
				actor := acpMCPUser(t, manager.h)
				if state, err := manager.h.closeACP(ctx, actor, agent.ID, session.ID); err != nil || state["state"] != "closed" || state["error"] != nil {
					t.Fatalf("confirmed cleanup could not close: %+v %v", state, err)
				}
				if rt, err := manager.ensure(ctx, "tenant", agent.ID, session.ID); err != nil || rt.snapshot()["state"] != "idle" {
					t.Fatalf("cleaned startup could not retry: %v", err)
				}
			})
		}
	}
}

func TestACPImagePullFailurePreservesRetryableStatus(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	pulls := 0
	h := builtinToolHarness(t, d, "rnr_acp-pull-failure", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true}}, nil
		case "docker.pull":
			pulls++
			return nil, errors.New("Docker daemon unavailable")
		default:
			t.Errorf("pull failure reached a remote effect: %s", method)
			return nil, errors.New("unexpected RPC")
		}
	})
	node := "node"
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.saveSpaceACP(context.Background(), "tenant", space.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "oauth", "modelProvider": "native"}}}); err != nil {
		t.Fatal(err)
	}
	session, err := h.store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Kind: "acp", Origin: json.RawMessage(`{"acpProfileId":"codex"}`)})
	if err != nil {
		t.Fatal(err)
	}
	h.acp = newACPRuntimeManager(h)
	ctx := context.Background()
	router := chi.NewRouter()
	router.Get("/agents/{id}/sessions/{sid}/acp-runtime", h.getACPRuntime)
	actor := acpMCPUser(t, h)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/agents/"+agent.ID+"/sessions/"+session.ID+"/acp-runtime", nil)
		router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), actor)))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Docker daemon unavailable") {
			t.Fatalf("GET lost original startup failure: %d %s", w.Code, w.Body.String())
		}
	}
	assertACPInfrastructureClaims(t, h, space.ID, false)
	if pulls != 1 {
		t.Fatalf("GET retried failed startup %d times", pulls)
	}
	// No live process was created, so closing is idempotent even after a restart.
	h.acp = newACPRuntimeManager(h)
	if state, err := h.closeACP(ctx, actor, agent.ID, session.ID); err != nil || state["state"] != "closed" {
		t.Fatalf("failed preflight could not close: %+v %v", state, err)
	}
	if _, err = h.reconnectACP(ctx, actor, agent.ID, session.ID); err == nil || !strings.Contains(err.Error(), "Docker daemon unavailable") {
		t.Fatalf("explicit retry was blocked by stale infrastructure: %v", err)
	}
	if pulls != 2 {
		t.Fatalf("explicit retry did not pull again: %d", pulls)
	}
	assertACPInfrastructureClaims(t, h, space.ID, false)
}

func TestACPAttachFailureReleasesClaimsAfterContainerRemoval(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	removed := false
	h := builtinToolHarness(t, d, "rnr_acp-attach-failure", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "privateAtomicFS": true, "filesystemNoFollowStat": true}}, nil
		case "host.fs.list":
			return map[string]any{"entries": []any{}}, nil
		case "host.fs.mkdir":
			return map[string]any{"abs": "/srv/zakura/workspace"}, nil
		case "docker.pull":
			return nil, nil
		case "docker.create":
			return map[string]any{"dockerId": "original-adapter"}, nil
		case "docker.attach":
			return nil, errors.New("attach response lost")
		case "docker.stop":
			if params["id"] != "original-adapter" || params["remove"] != true {
				t.Errorf("cleanup targeted the wrong container: %+v", params)
			}
			removed = true
			return nil, nil
		default:
			t.Errorf("unexpected method: %s", method)
			return nil, errors.New("unexpected RPC")
		}
	})
	node := "node"
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.store.CreateSession(context.Background(), "tenant", "", agent.ID, Session{Kind: "acp"})
	if err != nil {
		t.Fatal(err)
	}
	manager := &acpRuntimeManager{h: h}
	_, err = manager.start(context.Background(), "tenant", agent.ID, session.ID, "codex", "", session, map[string]any{"command": "adapter", "image": "fixture-adapter"})
	var stopped acpStartStoppedError
	if !errors.As(err, &stopped) || !removed {
		t.Fatalf("confirmed container cleanup was lost: removed=%v err=%v", removed, err)
	}
	assertACPInfrastructureClaims(t, h, space.ID, false)
}

func TestACPStatusDuringStartupDoesNotWaitForProcess(t *testing.T) {
	manager, agent, session := acpAuthHarness(t, &fakeACPAdapter{})
	manager.mu.Lock()
	manager.starting["tenant\x00"+session.ID] = &acpRuntimeStart{done: make(chan struct{})}
	manager.mu.Unlock()
	state, err := manager.snapshot(context.Background(), "tenant", agent.ID, session.ID)
	if err != nil || state["state"] != "starting" || state["profileId"] != "codex" {
		t.Fatalf("starting status missing: %+v %v", state, err)
	}
}
