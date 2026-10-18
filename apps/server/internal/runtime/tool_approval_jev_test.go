// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestToolApprovalJevDecisionMatrix(t *testing.T) {
	for _, source := range []string{"standard", "acp", "acp_callback"} {
		for _, scenario := range []string{"allow", "deny", "escalate-deny", "low-confidence", "malformed", "deleted-route", "disabled-upstream", "broken-credential"} {
			t.Run(source+"/"+scenario, func(t *testing.T) {
				answer := strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":0.95`, 1)
				if scenario == "deny" || scenario == "escalate-deny" {
					answer = strings.Replace(answer, `"choice":"allow"`, `"choice":"deny"`, 1)
				}
				if scenario == "low-confidence" {
					answer = validJevAnswer
				}
				if scenario == "malformed" {
					answer = `{"answers":{"approval":{"choice":"allow"}}}`
				}
				store, _, upstream, route, calls := jevFixture(t, answer)
				ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancel()
				space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Jev approval"})
				if err != nil {
					t.Fatal(err)
				}
				gate := map[string]any{"provider": "jev", "routeId": route.ID, "escalateOnDeny": scenario == "escalate-deny"}
				a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": "ai", "aiGate": gate}}})})
				if err != nil {
					t.Fatal(err)
				}
				session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{})
				if err != nil {
					t.Fatal(err)
				}
				switch scenario {
				case "deleted-route":
					err = store.deps.Gorm.Table("model_routes").Where("id=?", route.ID).Delete(nil).Error
				case "disabled-upstream":
					err = store.deps.Gorm.Table("model_upstreams").Where("id=?", upstream.ID).Update("status", "disabled").Error
				case "broken-credential":
					err = store.deps.Gorm.Table("model_upstreams").Where("id=?", upstream.ID).Update("config_json", `{"credentialEnc":"broken"}`).Error
				}
				if err != nil {
					t.Fatal(err)
				}
				s := NewService(store)
				done := make(chan error, 1)
				go func() {
					done <- s.approveTool(ctx, "tenant", a.ID, session.ID, "", "call", "fs_read", json.RawMessage(`{"path":"/workspace/note"}`), "always_ask", source, "protocol-call")
				}()
				if scenario != "allow" && scenario != "deny" {
					id := waitApproval(t, store, session.ID)
					if err := store.settleApproval(ctx, "tenant", a.ID, session.ID, id, "denied", "user", false); err != nil {
						t.Fatal(err)
					}
				}
				select {
				case err := <-done:
					if (err == nil) != (scenario == "allow") {
						t.Fatalf("decision=%v", err)
					}
				case <-ctx.Done():
					t.Fatal("approval did not settle")
				}
				var rows []approvalRecord
				if err := store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Find(&rows).Error; err != nil || len(rows) != 1 {
					t.Fatalf("audit=%+v err=%v", rows, err)
				}
				want := "denied"
				if scenario == "allow" {
					want = "approved"
				}
				if rows[0].Status != want {
					t.Fatalf("status=%s want=%s", rows[0].Status, want)
				}
				wantCalls := int32(1)
				if scenario == "deleted-route" || scenario == "disabled-upstream" || scenario == "broken-credential" {
					wantCalls = 0
				}
				if calls.Load() != wantCalls {
					t.Fatalf("native requests=%d want=%d", calls.Load(), wantCalls)
				}
			})
		}
	}
}

func TestToolApprovalJevPolicyChangeDuringEvaluation(t *testing.T) {
	store, gateway, _, route, _ := jevFixture(t, strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":0.95`, 1))
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Policy change"})
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"approvals": map[string]any{"policy": "ai", "aiGate": map[string]any{"provider": "jev", "routeId": route.ID}}}})})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(context.Background(), "tenant", "", a.ID, Session{})
	if err != nil {
		t.Fatal(err)
	}
	// Change the persisted policy after the provider has returned but before the
	// shared gate can authorize execution. No external side effect lives in CAS.
	base := gateway.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	gateway.client = &http.Client{Transport: approvalRoundTripper(func(req *http.Request) (*http.Response, error) {
		response, err := base.RoundTrip(req)
		if err != nil {
			return nil, err
		}
		_, updateErr := store.updateAgentConfig(req.Context(), "tenant", a.ID, nil, func(cfg map[string]any) error {
			cfg["cloud"].(map[string]any)["approvals"].(map[string]any)["policy"] = "always_ask"
			return nil
		})
		if updateErr != nil {
			_ = response.Body.Close()
			return nil, fmt.Errorf("fixture policy update: %w", updateErr)
		}
		return response, nil
	})}
	s := NewService(store)
	s.gateway = gateway
	if err := s.approveTool(context.Background(), "tenant", a.ID, session.ID, "", "call", "fs_read", json.RawMessage(`{}`), "allow_all", "standard", ""); err == nil {
		t.Fatal("AI result authorized execution after policy changed")
	}
	var audits int64
	if err := store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Count(&audits).Error; err != nil || audits != 0 {
		t.Fatalf("obsolete AI decision recorded: count=%d err=%v", audits, err)
	}
}

func TestToolApprovalJevReceivesBoundedContext(t *testing.T) {
	for _, source := range []string{"standard", "acp", "acp_callback"} {
		t.Run(source, func(t *testing.T) {
			store, gateway, _, route, _ := jevFixture(t, strings.Replace(validJevAnswer, `"confidence":0.61`, `"confidence":0.95`, 1))
			ctx := context.Background()
			node := "workspace-node"
			space, err := store.CreateSpace(ctx, "tenant", Space{Name: "Review", RuntimeNodeID: &node, WorkspaceKind: "host"})
			if err != nil {
				t.Fatal(err)
			}
			a, err := store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: space.ID, Config: rawJSON(map[string]any{"cloud": map[string]any{"systemPrompt": "private-system-sentinel", "approvals": map[string]any{"policy": "ai", "aiGate": map[string]any{"provider": "jev", "routeId": route.ID}}}})})
			if err != nil {
				t.Fatal(err)
			}
			project := "project"
			session, err := store.CreateSession(ctx, "tenant", "", a.ID, Session{Project: &project})
			if err != nil {
				t.Fatal(err)
			}
			run, err := store.StartRun(ctx, "tenant", a.ID, session.ID, "test", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.AppendEvent(ctx, "tenant", a.ID, session.ID, "user_message", nil, map[string]any{"content": "private-history-sentinel"})
			if err != nil {
				t.Fatal(err)
			}
			request := "Read this project note; Bearer request-secret-sentinel " + strings.Repeat("界", 6000)
			_, err = store.AppendEvent(ctx, "tenant", a.ID, session.ID, "user_message", &run.ID, map[string]any{"content": request, "attachments": []any{map[string]any{"content": "private-attachment-sentinel"}}})
			if err != nil {
				t.Fatal(err)
			}
			args := json.RawMessage(`{"path":"/workspace/project/note","apiKey":"private-argument-sentinel"}`)
			if source == "standard" {
				seedTerminalComputer(t, store.deps, space.ID, "attached", `["commands","files","pty"]`)
				if err := store.deps.Gorm.Table("computers").Where("id=?", "attached").Updates(map[string]any{"runtime_node_id": "execution-node", "settings_json": `{"privateConfig":"private-settings-sentinel"}`}).Error; err != nil {
					t.Fatal(err)
				}
				args = json.RawMessage(`{"computerId":"attached","path":"/workspace/project/note","apiKey":"private-argument-sentinel"}`)
			}
			base := gateway.client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			var captured []byte
			gateway.client = &http.Client{Transport: approvalRoundTripper(func(req *http.Request) (*http.Response, error) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				captured = append([]byte(nil), body...)
				req.Body = io.NopCloser(bytes.NewReader(body))
				return base.RoundTrip(req)
			})}
			s := NewService(store)
			s.gateway = gateway
			if err := s.approveTool(ctx, "tenant", a.ID, session.ID, run.ID, "call", "fs_read", args, "always_ask", source, "protocol-call"); err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"private-history-sentinel", "private-system-sentinel", "private-attachment-sentinel", "private-settings-sentinel", "private-argument-sentinel", "request-secret-sentinel"} {
				if bytes.Contains(captured, []byte(secret)) {
					t.Fatalf("provider received excluded data: %s", secret)
				}
			}
			var body struct {
				State struct {
					Context struct {
						Source           string         `json:"source"`
						Project          string         `json:"project"`
						Request          string         `json:"request"`
						RequestTruncated bool           `json:"requestTruncated"`
						Target           map[string]any `json:"target"`
					} `json:"context"`
				} `json:"state"`
			}
			if err := json.Unmarshal(captured, &body); err != nil {
				t.Fatal(err)
			}
			review := body.State.Context
			if review.Source != source || review.Project != project || !strings.HasPrefix(review.Request, "Read this project note;") || !review.RequestTruncated || len(review.Request) > 16<<10 || review.Target["workspaceNodeId"] != node {
				t.Fatalf("missing or unbounded review context: %#v", review)
			}
			want := "space_workspace"
			if source == "standard" {
				want = "attached_computer"
				if review.Target["computerId"] != "attached" || review.Target["nodeId"] != "execution-node" || review.Target["runtimes"] == nil {
					t.Fatalf("missing explicit execution target: %#v", review.Target)
				}
			}
			if review.Target["kind"] != want {
				t.Fatalf("target kind=%v want=%s", review.Target["kind"], want)
			}
		})
	}
}

type approvalRoundTripper func(*http.Request) (*http.Response, error)

func (f approvalRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
