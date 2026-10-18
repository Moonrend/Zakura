package runtime

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestMCPOAuthOwnAgentCanonicalAndAliasScope(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	own, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Own"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "Own Agent", SpaceID: own.ID})
	if err != nil {
		t.Fatal(err)
	}
	peer, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "Peer Agent", SpaceID: own.ID})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "Other Agent", SpaceID: other.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []struct {
		name string
		p    httpx.Principal
	}{
		{"legacy-aid", httpx.Principal{TenantID: "tenant", OAuth: true, AgentID: agent.ID}},
		{"signed-space-agent", httpx.Principal{TenantID: "tenant", OAuth: true, SpaceID: own.ID, AgentID: agent.ID}},
		{"space-resource", httpx.Principal{TenantID: "tenant", OAuth: true, SpaceID: own.ID}},
		{"tenant-unbound", httpx.Principal{TenantID: "tenant", OAuth: true}},
	} {
		t.Run(binding.name, func(t *testing.T) {
			for _, target := range []struct {
				path string
				want bool
			}{
				{"/mcp/spaces/" + own.Slug, binding.name != "tenant-unbound"},
				{"/mcp/agents/" + agent.Slug, binding.name != "tenant-unbound"},
				{"/mcp/agents/" + peer.Slug, binding.name == "space-resource"},
				{"/mcp/spaces/" + other.Slug, false},
				{"/mcp/agents/" + foreign.Slug, false},
			} {
				space, _, _, err := h.mcpSpaceForRequest(httptest.NewRequest("POST", target.path, nil), binding.p)
				if (err == nil) != target.want || target.want && space != own.ID {
					t.Errorf("%s => %q, %v; allowed=%v", target.path, space, err, target.want)
				}
			}
			if binding.p.AgentID != "" {
				space, routedAgent, err := h.authorizeMCPScope(ctx, binding.p, own.ID, "")
				if err != nil || space != own.ID || routedAgent != agent.ID {
					t.Fatalf("canonical endpoint lost Agent policy narrowing: %q %q %v", space, routedAgent, err)
				}
				for _, bodyAgent := range []string{peer.ID, foreign.ID} {
					if _, _, err := h.authorizeMCPScope(ctx, binding.p, "", bodyAgent); err == nil {
						t.Errorf("explicit body Agent %q escaped OAuth binding", bodyAgent)
					}
				}
			}
		})
	}
}
