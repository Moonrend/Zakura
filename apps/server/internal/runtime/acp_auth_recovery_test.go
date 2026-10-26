// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPAuthRecoveryRequiresExpiryOriginalObservationAndFreshToken(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	var mu sync.Mutex
	present := false
	h := codemodeToolHarness(t, d, "rnr_auth_recovery", func(method string, params map[string]any, _ func(string, string, any)) (any, func()) {
		switch method {
		case "sys.info":
			return map[string]any{"kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}}, nil
		case "docker.list":
			mu.Lock()
			defer mu.Unlock()
			if present {
				return []acpSidecarContainer{{DockerID: "original-login", Labels: map[string]string{"zakura.tenant": "tenant", "zakura.space": params["label"].(string)[len("zakura.space="):], "zakura.purpose": "acp-login"}}}, nil
			}
			return []acpSidecarContainer{}, nil
		default:
			t.Errorf("recovery must not alter remote files or processes: %s", method)
			return map[string]any{}, nil
		}
	})
	node := "node"
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Recovery", RuntimeNodeID: &node, WorkspaceKind: "host"})
	if err != nil {
		t.Fatal(err)
	}
	_, exec, err := h.acpSpaceRunner(context.Background(), "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.acquireACPAuthLock(context.Background(), "tenant", space.ID, "codex", "terminal", "original-owner", time.Minute, exec); err != nil {
		t.Fatal(err)
	}
	load := func() acpAuthRecoveryState {
		t.Helper()
		state, err := h.loadACPAuthRecovery(context.Background(), "tenant", space.ID, "codex")
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	state := load()
	if state.NodeID != "node" || state.ComputerID != exec.computer.ID {
		t.Fatalf("original target was not persisted: %#v", state)
	}
	if err = h.reconcileACPAuthentication(context.Background(), "tenant", space.ID, "codex", state.recoveryToken()); err == nil {
		t.Fatal("active lock was reconciled")
	}
	if _, err = d.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0 WHERE space_id=?`, space.ID); err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceInfrastructure(context.Background(), "tenant", space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = lease.bindSharedProfile(context.Background(), "codex"); err != nil {
		t.Fatal(err)
	}
	_ = lease.uncertain(errors.New("credential effect unconfirmed"))
	lease.release()
	state = load()
	stale := state.recoveryToken()
	mu.Lock()
	present = true
	mu.Unlock()
	if err = h.reconcileACPAuthentication(context.Background(), "tenant", space.ID, "codex", stale); err == nil {
		t.Fatal("existing login container was ignored")
	}
	state = load()
	if state.Kind != "recovering" || state.Token == "original-owner" || state.WorkspaceToken == lease.Token {
		t.Fatal("failed observation did not fence both old owners")
	}
	if err = lease.finish(context.Background(), "running", nil); !errors.Is(err, errWorkspaceLeaseLost) {
		t.Fatalf("late infrastructure completion was not fenced: %v", err)
	}
	if err = h.recoverSpaceWorkspaces(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	if current := load(); current.recoveryToken() != state.recoveryToken() {
		t.Fatal("generic sweep rotated a profile recovery owner")
	}
	if err = h.releaseACPAuthLock(context.Background(), "tenant", space.ID, "codex", "original-owner"); err != nil {
		t.Fatal(err)
	}
	if err = h.reconcileACPAuthentication(context.Background(), "tenant", space.ID, "codex", stale); err == nil {
		t.Fatal("stale recovery token accepted")
	}
	mu.Lock()
	present = false
	mu.Unlock()
	if err = h.reconcileACPAuthentication(context.Background(), "tenant", space.ID, "codex", state.recoveryToken()); err != nil {
		t.Fatal(err)
	}
	if _, err = h.loadACPAuthRecovery(context.Background(), "tenant", space.ID, "codex"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lock remains: %v", err)
	}
	var claims int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM computer_workspace_leases WHERE space_id=?`, space.ID).Scan(&claims); err != nil || claims != 0 {
		t.Fatalf("infrastructure quarantine remains: %d %v", claims, err)
	}
	if current, err := h.store.GetSpace(context.Background(), "tenant", space.ID); err != nil || current.WorkspaceStatus != lease.Intent.PreviousStatus {
		t.Fatalf("previous workspace status was not restored: %+v %v", current, err)
	}
}

func TestACPAuthRecoveryScopeAndExplicitConfirmation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	space, err := h.store.CreateSpace(context.Background(), "tenant", Space{Name: "Recovery"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		p    httpx.Principal
		body string
		want int
	}{
		{"member", httpx.Principal{TenantID: "tenant", Role: "member"}, `{}`, 403},
		{"agent-key", httpx.Principal{TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["computers:manage"]`, AgentID: "bound"}, `{}`, 404},
		{"wrong-space", httpx.Principal{TenantID: "tenant", Role: "owner", APIKey: true, APIKeyScopes: `["computers:manage"]`, SpaceID: "other"}, `{}`, 404},
		{"missing-confirmation", httpx.Principal{TenantID: "tenant", Role: "owner"}, `{"recoveryToken":"x"}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), tc.p)))
				})
			})
			router.Post("/spaces/{spaceId}/acp/agents/{profileId}/auth-recovery/acknowledge", h.acknowledgeACPAuthRecovery)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/spaces/"+space.ID+"/acp/agents/codex/auth-recovery/acknowledge", strings.NewReader(tc.body)))
			if w.Code != tc.want {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
		})
	}
}
