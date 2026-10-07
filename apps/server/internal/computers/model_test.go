package computers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestTargetIsolation(t *testing.T) {
	now := time.Now()
	c := Computer{ID: "c", TenantID: "t", SpaceID: "s", Provider: E2B, Capabilities: []Capability{Commands, Files, PTY, RestrictedCommands}}
	r := Runtime{ID: "r", ComputerID: "c", TenantID: "t", SpaceID: "s", SessionScope: "chat", Incarnation: "generation1", State: Ready, ExpiresAt: now.Add(time.Hour), IdleDeadline: now.Add(15 * time.Minute)}
	target := Target{TenantID: "t", SpaceID: "s", ComputerID: "c", RuntimeID: "r", Incarnation: "generation1"}
	if err := CheckTarget(target, c, r, "chat", Commands, false, now); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		mutate     func(*Target, *Computer, *Runtime)
		session    string
		cap        Capability
		restricted bool
	}{
		{"tenant", func(v *Target, _ *Computer, _ *Runtime) { v.TenantID = "other" }, "chat", Commands, false},
		{"space", func(v *Target, _ *Computer, _ *Runtime) { v.SpaceID = "other" }, "chat", Commands, false},
		{"incarnation", func(_ *Target, _ *Computer, v *Runtime) { v.Incarnation = "replacement" }, "chat", Commands, false},
		{"chat", func(_ *Target, _ *Computer, _ *Runtime) {}, "other", Commands, false},
		{"expired", func(_ *Target, _ *Computer, v *Runtime) { v.ExpiresAt = now }, "chat", Commands, false},
		{"missing max deadline", func(_ *Target, _ *Computer, v *Runtime) { v.ExpiresAt = time.Time{} }, "chat", Commands, false},
		{"missing idle deadline", func(_ *Target, _ *Computer, v *Runtime) { v.IdleDeadline = time.Time{} }, "chat", Commands, false},
		{"idle exceeds maximum", func(_ *Target, _ *Computer, v *Runtime) { v.IdleDeadline = v.ExpiresAt.Add(time.Second) }, "chat", Commands, false},
		{"idle", func(_ *Target, _ *Computer, v *Runtime) { v.IdleDeadline = now }, "chat", Commands, false},
		{"disconnected", func(_ *Target, _ *Computer, v *Runtime) { v.State = Disconnected }, "chat", Commands, false},
		{"capability", func(_ *Target, _ *Computer, _ *Runtime) {}, "chat", Desktop, false},
		{"restriction cannot be bypassed", func(_ *Target, _ *Computer, _ *Runtime) {}, "chat", Commands, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v, comp, rt := target, c, r
			tt.mutate(&v, &comp, &rt)
			if CheckTarget(v, comp, rt, tt.session, tt.cap, tt.restricted, now) == nil {
				t.Fatal("unsafe target accepted")
			}
		})
	}
}
func TestProviderScopingAndACP(t *testing.T) {
	for _, p := range []Provider{Server, RemoteAgent, SSH, Temporary, E2B, Railway} {
		c := Computer{Provider: p, RuntimeNodeID: "node", Capabilities: []Capability{Docker}}
		if c.SupportsACP() != (p == Server) {
			t.Fatalf("ACP allowed for %s", p)
		}
		scope, err := c.Scope("chat")
		if err != nil {
			t.Fatal(err)
		}
		if (scope == "chat") != (p == Temporary || p == E2B) {
			t.Fatalf("incorrect session scope for %s", p)
		}
	}
}
func TestTerminalStatesCannotRestart(t *testing.T) {
	for _, from := range []State{Expired, Destroyed, Failed} {
		for _, to := range []State{Creating, Ready, PendingApproval} {
			if CanTransition(from, to) {
				t.Fatalf("%s resurrected as %s", from, to)
			}
		}
	}
	if CanTransition(Unknown, Creating) {
		t.Fatal("ambiguous create may duplicate paid instances")
	}
	if CanTransition(Disconnected, Destroyed) {
		t.Fatal("disconnect is not destruction confirmation")
	}
}
func TestComputerDoesNotSerializeSecretReference(t *testing.T) {
	b, err := json.Marshal(Computer{SecretRef: "secret-canary"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "secret-canary") {
		t.Fatal("secret ref exposed")
	}
}

func TestFollowUpIdentitySurvivesLifecycleButNeverRebinds(t *testing.T) {
	c := Computer{ID: "c", TenantID: "t", SpaceID: "s", Provider: E2B, Capabilities: []Capability{Commands}}
	r := Runtime{ID: "r", ComputerID: "c", TenantID: "t", SpaceID: "s", SessionScope: "chat", Incarnation: "inc"}
	target := Target{TenantID: "t", SpaceID: "s", ComputerID: "c", RuntimeID: "r", Incarnation: "inc"}
	for _, state := range []State{Disconnected, Stopping, Expired, Destroyed, Unknown} {
		r.State = state
		if err := CheckIdentity(target, c, r, "chat"); err != nil {
			t.Fatalf("follow-up %s: %v", state, err)
		}
		if err := CheckTarget(target, c, r, "chat", Commands, false, time.Now()); err == nil {
			t.Fatalf("new execution allowed in %s", state)
		}
		replacement := r
		replacement.Incarnation = "replacement"
		if err := CheckIdentity(target, c, replacement, "chat"); err == nil {
			t.Fatal("follow-up rebound to replacement")
		}
	}
}
