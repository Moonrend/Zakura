// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestACPDeviceSwitchClearsManagedKeyThenPreservesOAuthOnRestart(t *testing.T) {
	rig := newDeviceTestRig(t)
	home := "/workspace/.zakura/acp/codex/home"
	scope, _ := json.Marshal([]string{"tenant", rig.space.ID, "codex"})
	fs := acpManagedFS{call: rig.fs.call, space: rig.space.ID, home: home, scope: string(scope), secret: rig.h.deps.Secret}
	setup := acpSetup{ID: "codex", SetupMode: "api_key", ModelProvider: "native", Managed: map[string]string{"api_key": "old-key", "base_url": "https://example.invalid", "model": "fixture"}}
	files, _ := acpRuntimeFiles(home, setup, nil, "")
	if err := fs.reconcile(context.Background(), setup, files); err != nil {
		t.Fatal(err)
	}
	root := strings.TrimPrefix(home, "/workspace")
	rig.fs.put(root+"/sentinel.pem", "user-certificate")
	a := rig.start(t)
	rig.advance(6 * time.Second)
	a, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "complete" {
		t.Fatalf("device mode switch: %+v %v", a, err)
	}
	if _, exists := rig.fs.files[root+"/.codex/config.toml"]; exists {
		t.Fatal("managed provider config survived device login")
	}
	oauth := rig.fs.files[root+"/.codex/auth.json"]
	if !strings.Contains(oauth, "access-secret") || rig.fs.files[root+"/sentinel.pem"] != "user-certificate" {
		t.Fatal("OAuth not saved or sentinel lost")
	}
	target, err := rig.h.codexDeviceTarget(context.Background(), "tenant", rig.space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rig.h.prepareACPFiles(context.Background(), target.runner, target.exec, "codex", target.setup, ""); err != nil {
		t.Fatalf("saved OAuth cannot start: %v", err)
	}
	if rig.fs.files[root+"/.codex/auth.json"] != oauth {
		t.Fatal("restart changed OAuth credentials")
	}
}

func TestACPDeviceDoesNotOverwriteExistingUnownedOAuth(t *testing.T) {
	rig := newDeviceTestRig(t)
	root := "/.zakura/acp/codex/home"
	oauth := `{"auth_mode":"chatgpt","tokens":{"access_token":"existing-user-oauth"}}`
	rig.fs.put(root+"/.codex/auth.json", oauth)
	a := rig.start(t)
	rig.advance(6 * time.Second)
	a, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "unknown" {
		t.Fatalf("expected safe conflict: %+v %v", a, err)
	}
	if rig.writes.Load() != 0 || rig.fs.files[root+"/.codex/auth.json"] != oauth {
		t.Fatal("existing OAuth replaced")
	}
	stored, err := rig.h.acpDeviceLoad(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || stored.Status != "unknown" || !strings.Contains(stored.Error, "conflict") || strings.Contains(stored.Error, "existing-user-oauth") {
		t.Fatalf("unsafe conflict status: %+v %v", stored.public(), err)
	}
}
