// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func TestACPApprovalPolicyTransitionStopsActivePrompt(t *testing.T) {
	for _, scenario := range []string{"cloud", "agent", "space-fallback", "watcher", "mode-update", "config-update", "cleanup-failure", "allow-all"} {
		t.Run(scenario, func(t *testing.T) {
			entered := make(chan struct{}, 1)
			fake := &fakeACPAdapter{onRPC: func(_ string, rpc map[string]any, _ func(any)) bool {
				if rpc["method"] == "session/prompt" {
					select {
					case entered <- struct{}{}:
					default:
					}
					return true
				}
				return false
			}}
			manager, agent, session := acpAuthHarness(t, fake)
			h := manager.h
			h.acp = manager
			actor := acpMCPUser(t, h)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if err := h.saveSpaceACP(ctx, "tenant", agent.SpaceID, map[string]any{"permissionPolicy": "allow", "agents": map[string]any{"codex": map[string]any{"enabled": true, "command": "fake-adapter"}}}); err != nil {
				t.Fatal(err)
			}
			rt, err := manager.ensure(ctx, "tenant", agent.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			rt.profileID, rt.adapterImage = "claude-code", "ghcr.io/moonrend/acp-registry/claude-acp:0.75.1"
			run, err := h.store.StartRun(ctx, "tenant", agent.ID, session.ID, "test", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			promptCtx, stopPrompt := context.WithCancel(ctx)
			defer stopPrompt()
			result := make(chan error, 1)
			go func() { result <- rt.prompt(promptCtx, run.ID, "wait for policy change") }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("prompt not started")
			}
			policy := "always_ask"
			if scenario == "agent" || scenario == "config-update" {
				policy = "ai"
			}
			if scenario == "allow-all" {
				policy = "allow_all"
			}
			if scenario == "cleanup-failure" {
				fake.mu.Lock()
				fake.failClose = true
				fake.mu.Unlock()
			}
			switch scenario {
			case "cloud", "agent", "space-fallback", "cleanup-failure":
				router := chi.NewRouter()
				router.Put("/agents/{id}/cloud", h.updateCloudConfig)
				router.Patch("/agents/{id}", h.patchAgent)
				router.Put("/spaces/{spaceId}/acp/config", h.putACPConfig)
				method, path := http.MethodPut, "/agents/"+agent.ID+"/cloud"
				body := `{"approvals":{"policy":"` + policy + `"}}`
				if scenario == "agent" {
					method, path = http.MethodPatch, "/agents/"+agent.ID
					body = `{"config":{"cloud":{"approvals":{"policy":"ai"}}}}`
				}
				if scenario == "space-fallback" {
					path = "/spaces/" + agent.SpaceID + "/acp/config"
					body = `{"permissionPolicy":"ask"}`
				}
				w := httptest.NewRecorder()
				r := httptest.NewRequest(method, path, strings.NewReader(body))
				router.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), actor)))
				if scenario == "cleanup-failure" {
					if w.Code == http.StatusOK {
						t.Fatal("policy save reported confirmed cleanup")
					}
				} else if w.Code != http.StatusOK {
					t.Fatalf("policy save=%d %s", w.Code, w.Body.String())
				}
			default:
				_, err = h.store.updateAgentConfig(ctx, "tenant", agent.ID, nil, func(cfg map[string]any) error {
					cfg["cloud"] = map[string]any{"approvals": map[string]any{"policy": policy}}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "mode-update" || scenario == "config-update" {
					update := map[string]any{"sessionUpdate": "current_mode_update", "currentModeId": "bypassPermissions"}
					if scenario == "config-update" {
						update = map[string]any{"sessionUpdate": "config_option_update", "configOptions": []any{map[string]any{"id": "mode", "currentValue": "auto", "options": []any{map[string]any{"value": "auto", "name": "Auto"}}}}}
					}
					rt.handleUpdate(map[string]any{"sessionId": rt.acpSessionID, "update": update})
				} else {
					ticks := make(chan time.Time, 1)
					ticks <- time.Now()
					close(ticks)
					rt.watchApprovalPolicy(ctx, ticks, make(chan struct{}))
				}
			}
			if scenario == "allow-all" {
				select {
				case <-rt.done:
					t.Fatal("explicit allow_all prompt was stopped")
				default:
				}
				stopPrompt()
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("active prompt completed after incompatible policy change")
				}
			case <-ctx.Done():
				t.Fatal("prompt did not stop")
			}
			if scenario != "allow-all" {
				if err := rt.close(nil); (err != nil) != (scenario == "cleanup-failure") {
					t.Fatalf("close outcome=%v", err)
				}
				if scenario == "cleanup-failure" {
					for _, table := range []string{"computer_workspace_leases", "acp_profile_auth_locks"} {
						var claims int64
						if err := h.deps.Gorm.Table(table).Where("tenant_id=? AND space_id=?", "tenant", agent.SpaceID).Count(&claims).Error; err != nil || claims != 1 {
							t.Fatalf("%s cleanup fence=%d err=%v", table, claims, err)
						}
					}
					if _, err := manager.ensure(ctx, "tenant", agent.ID, session.ID); err == nil {
						t.Fatal("unconfirmed process was replaced")
					}
				}
			}
		})
	}
}

func TestACPApprovalIdentityUsesResolvedProfile(t *testing.T) {
	for _, custom := range []bool{false, true} {
		setup := map[string]any{"enabled": true, "setupMode": "self"}
		if custom {
			setup["command"] = "custom-claude"
		}
		profile, err := acpRuntimeProfile(map[string]any{"agents": map[string]any{"claude-code": setup}}, "claude-code")
		if err != nil {
			t.Fatal(err)
		}
		image, _ := profile["image"].(string)
		rt := &acpLiveRuntime{profileID: "claude-code", adapterImage: image}
		if rt.auditedClaudeACP() == custom {
			t.Fatalf("custom=%v resolved image=%q", custom, image)
		}
	}
}
