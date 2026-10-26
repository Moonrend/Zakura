// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"strings"
	"sync"
	"testing"
)

type acpHomeFixture struct {
	mu              sync.Mutex
	files           map[string]string
	dirs            map[string]bool
	modes           map[string]string
	capability      bool
	writes, removes int
	failPath        string
}

func newACPHomeFixture() *acpHomeFixture {
	return &acpHomeFixture{files: map[string]string{}, dirs: map[string]bool{"/": true}, modes: map[string]string{}, capability: true}
}
func (f *acpHomeFixture) put(name, content string) {
	f.files[name] = content
	for parent := path.Dir(name); ; parent = path.Dir(parent) {
		f.dirs[parent] = true
		if parent == "/" {
			break
		}
	}
}
func (f *acpHomeFixture) call(_ context.Context, method string, raw, out any) error {
	data, _ := json.Marshal(raw)
	var params map[string]any
	_ = json.Unmarshal(data, &params)
	result, err := f.run(method, params)
	if err != nil || out == nil {
		return err
	}
	data, _ = json.Marshal(result)
	return json.Unmarshal(data, out)
}
func (f *acpHomeFixture) run(method string, params map[string]any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	target, _ := params["path"].(string)
	target = path.Clean("/" + strings.TrimPrefix(target, "/workspace"))
	switch method {
	case "sys.info":
		return map[string]any{"capabilities": map[string]bool{"privateAtomicFS": true, "filesystemNoFollowStat": f.capability}}, nil
	case "host.fs.list":
		if !f.dirs[target] {
			return nil, errors.New("directory absent")
		}
		children := map[string]bool{}
		for name := range f.files {
			if path.Dir(name) == target {
				children[path.Base(name)] = true
			}
		}
		for name := range f.dirs {
			if name != target && path.Dir(name) == target {
				children[path.Base(name)] = true
			}
		}
		entries := []runnerFSEntry{}
		for name := range children {
			entries = append(entries, runnerFSEntry{Name: name})
		}
		return map[string]any{"entries": entries}, nil
	case "host.fs.stat":
		if params["noFollow"] != true {
			return nil, errors.New("noFollow required")
		}
		mode := f.modes[target]
		if f.dirs[target] {
			if mode == "" {
				mode = "drwx------"
			}
			return runnerFSEntry{Name: path.Base(target), Path: target, IsDir: true, Mode: mode}, nil
		}
		content, ok := f.files[target]
		if !ok {
			return nil, errors.New("file absent")
		}
		if mode == "" {
			mode = "-rw-------"
		}
		return runnerFSEntry{Name: path.Base(target), Path: target, Mode: mode, Size: int64(len(content)), ModTime: "fixture"}, nil
	case "host.fs.read":
		content, ok := f.files[target]
		if !ok {
			return nil, errors.New("file absent")
		}
		return map[string]any{"content": content}, nil
	case "host.fs.mkdir":
		for parent := target; ; parent = path.Dir(parent) {
			f.dirs[parent] = true
			if parent == "/" {
				break
			}
		}
		return map[string]any{"ok": true}, nil
	case "host.fs.write":
		if gwInt(params["mode"]) != 0o600 || params["atomic"] != true {
			return nil, errors.New("insecure write")
		}
		content, _ := params["content"].(string)
		if encoded, ok := params["base64"].(string); ok {
			raw, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return nil, err
			}
			content = string(raw)
		}
		f.put(target, content)
		f.writes++
		if target == f.failPath {
			f.failPath = ""
			return nil, errors.New("unconfirmed response")
		}
		return map[string]any{"mode": 384, "atomic": true}, nil
	case "host.fs.remove":
		delete(f.files, target)
		f.removes++
		if target == f.failPath {
			f.failPath = ""
			return nil, errors.New("unconfirmed remove response")
		}
		return map[string]any{"ok": true}, nil
	}
	return nil, errors.New("unexpected fixture method")
}

func acpHomeTestFS(fixture *acpHomeFixture, profile string) acpManagedFS {
	return acpManagedFS{call: fixture.call, space: "space", home: "/workspace/.zakura/acp/" + profile + "/home", scope: "tenant/space/" + profile, secret: []byte("fixture-server-secret")}
}

func TestACPManagedFilesModeSwitchPreservesOAuthAndSentinels(t *testing.T) {
	ctx := context.Background()
	fixture := newACPHomeFixture()
	fs := acpHomeTestFS(fixture, "codex")
	root := strings.TrimPrefix(fs.home, "/workspace")
	for name, content := range map[string]string{"sentinel": "user-data", ".codex/extra.pem": "certificate", ".config/custom": "user-settings"} {
		fixture.put(root+"/"+name, content)
	}
	setup := acpSetup{ID: "codex", SetupMode: "api_key", ModelProvider: "native", Managed: map[string]string{"api_key": "api-secret", "base_url": "https://example.invalid/v1", "model": "fixture"}}
	files, _ := acpRuntimeFiles(fs.home, setup, nil, "")
	if len(files) != 2 {
		t.Fatalf("expected auth/config fixture, got %d", len(files))
	}
	if err := fs.reconcile(ctx, setup, files); err != nil {
		t.Fatal(err)
	}
	manifest := fixture.files[root+"/"+acpManagedManifest]
	if strings.Contains(manifest, "api-secret") || strings.Contains(manifest, "example.invalid") {
		t.Fatal("manifest contains credentials/config content")
	}
	setup.SetupMode = "oauth"
	if err := fs.reconcile(ctx, setup, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".codex/auth.json", ".codex/config.toml"} {
		if _, ok := fixture.files[root+"/"+name]; ok {
			t.Fatalf("generated %s not cleared", name)
		}
	}
	oauth := `{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"oauth-sentinel","refresh_token":"refresh-sentinel"}}`
	fixture.put(root+"/.codex/auth.json", oauth)
	fixture.put(root+"/.codex/config.toml", "model = \"user-model\"\n")
	if err := fs.reconcile(ctx, setup, nil); err != nil {
		t.Fatal(err)
	}
	if fixture.files[root+"/.codex/auth.json"] != oauth || fixture.files[root+"/sentinel"] != "user-data" || fixture.files[root+"/.codex/extra.pem"] != "certificate" || fixture.files[root+"/.config/custom"] != "user-settings" {
		t.Fatal("OAuth or user files changed")
	}
	setup.SetupMode = "api_key"
	before := fixture.writes
	if err := fs.reconcile(ctx, setup, files); err == nil || !strings.Contains(err.Error(), "conflict") && !strings.Contains(err.Error(), "unmanaged") {
		t.Fatalf("OAuth overwrite not rejected: %v", err)
	}
	if fixture.writes != before || fixture.files[root+"/.codex/auth.json"] != oauth {
		t.Fatal("existing OAuth overwritten")
	}
}

func TestACPManagedFilesPreservesClaudeOAuthAndCertificates(t *testing.T) {
	fixture := newACPHomeFixture()
	fs := acpHomeTestFS(fixture, "claude-code")
	root := strings.TrimPrefix(fs.home, "/workspace")
	files := map[string]string{
		".claude/.credentials.json": `{"claudeAiOauth":{"accessToken":"user-oauth"}}`,
		".claude/settings.json":     `{"user":"settings"}`,
		".claude/cert.pem":          "user-certificate",
		"sentinel":                  "user-data",
	}
	for name, content := range files {
		fixture.put(root+"/"+name, content)
	}
	if err := fs.reconcile(context.Background(), acpSetup{ID: "claude-code", SetupMode: "oauth", ModelProvider: "native"}, nil); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if fixture.files[root+"/"+name] != content {
			t.Fatalf("user file changed: %s", name)
		}
	}
	if fixture.writes != 0 || fixture.removes != 0 {
		t.Fatal("untracked OAuth HOME mutated")
	}
}

func TestACPManagedFilesRefusesUnownedModifiedForgedOrLinked(t *testing.T) {
	for _, mode := range []string{"legacy-key", "legacy-provider", "modified", "scope-replay", "tampered-manifest", "link", "parent-link", "special", "old-runner"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newACPHomeFixture()
			fs := acpHomeTestFS(fixture, "codex")
			root := strings.TrimPrefix(fs.home, "/workspace")
			setup := acpSetup{ID: "codex", SetupMode: "api_key", Managed: map[string]string{"api_key": "must-not-leak", "base_url": "https://invalid", "model": "test"}}
			files, _ := acpRuntimeFiles(fs.home, setup, nil, "")
			if mode == "legacy-key" {
				fixture.put(root+"/.codex/auth.json", `{"OPENAI_API_KEY":"must-not-leak"}`)
			} else if mode == "legacy-provider" {
				fixture.put(root+"/.codex/config.toml", `model_provider = "custom"`)
			} else if mode != "old-runner" {
				if err := fs.reconcile(context.Background(), setup, files); err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "modified":
				fixture.files[root+"/.codex/auth.json"] = `{"tokens":{"access_token":"user-oauth"}}`
			case "scope-replay":
				fs.scope = "another-space"
			case "tampered-manifest":
				fixture.files[root+"/"+acpManagedManifest] = `{"version":1,"files":{},"mac":"fake"}`
			case "link":
				fixture.modes[root+"/.codex/auth.json"] = "Lrwxrwxrwx"
			case "parent-link":
				fixture.modes[root+"/.codex"] = "Lrwxrwxrwx"
			case "special":
				fixture.modes[root+"/.codex/auth.json"] = "prw-------"
			case "old-runner":
				fixture.capability = false
			}
			setup.SetupMode = "oauth"
			beforeWrites, beforeRemoves := fixture.writes, fixture.removes
			err := fs.reconcile(context.Background(), setup, nil)
			if err == nil || strings.Contains(err.Error(), "must-not-leak") || strings.Contains(err.Error(), "user-oauth") {
				t.Fatalf("unsafe or secret-bearing error: %v", err)
			}
			if fixture.writes != beforeWrites || fixture.removes != beforeRemoves {
				t.Fatal("conflict caused mutations")
			}
		})
	}
}

func TestACPManagedFilesIntentRecoversUnknownWrite(t *testing.T) {
	fixture := newACPHomeFixture()
	fs := acpHomeTestFS(fixture, "codex")
	root := strings.TrimPrefix(fs.home, "/workspace")
	setup := acpSetup{ID: "codex", SetupMode: "api_key"}
	files := []acpRuntimeFile{{Path: fs.home + "/.codex/auth.json", Content: "first"}}
	if err := fs.reconcile(context.Background(), setup, files); err != nil {
		t.Fatal(err)
	}
	files[0].Content = "second"
	fixture.failPath = root + "/.codex/auth.json"
	if err := fs.reconcile(context.Background(), setup, files); err == nil {
		t.Fatal("expected uncertain RPC error")
	}
	if err := fs.reconcile(context.Background(), setup, files); err != nil {
		t.Fatalf("intent did not retain provenance after write uncertainty: %v", err)
	}
	if fixture.files[root+"/.codex/auth.json"] != "second" {
		t.Fatal("wrong resumed content")
	}
}

func TestACPManagedFilesManifestAndRemoveRetry(t *testing.T) {
	for _, failure := range []string{"manifest", "remove"} {
		t.Run(failure, func(t *testing.T) {
			fixture := newACPHomeFixture()
			fs := acpHomeTestFS(fixture, "codex")
			root := strings.TrimPrefix(fs.home, "/workspace")
			setup := acpSetup{ID: "codex", SetupMode: "api_key"}
			files := []acpRuntimeFile{{Path: fs.home + "/.codex/auth.json", Content: "managed"}}
			if failure == "manifest" {
				fixture.failPath = root + "/" + acpManagedManifest
				if err := fs.reconcile(context.Background(), setup, files); err == nil {
					t.Fatal("expected lost manifest reply")
				}
			} else {
				if err := fs.reconcile(context.Background(), setup, files); err != nil {
					t.Fatal(err)
				}
				fixture.failPath = root + "/.codex/auth.json"
				setup.SetupMode = "oauth"
				files = nil
				if err := fs.reconcile(context.Background(), setup, files); err == nil {
					t.Fatal("expected lost remove reply")
				}
			}
			if err := fs.reconcile(context.Background(), setup, files); err != nil {
				t.Fatalf("retry failed: %v", err)
			}
			_, present := fixture.files[root+"/.codex/auth.json"]
			if present != (failure == "manifest") {
				t.Fatal("retry produced wrong final state")
			}
		})
	}
}

func TestACPManagedFilesNeverAdoptsUnknownIdenticalFile(t *testing.T) {
	fixture := newACPHomeFixture()
	fs := acpHomeTestFS(fixture, "codex")
	file := acpRuntimeFile{Path: fs.home + "/.codex/auth.json", Content: "same-content"}
	fixture.put(strings.TrimPrefix(file.Path, "/workspace"), file.Content)
	if err := fs.reconcile(context.Background(), acpSetup{ID: "codex", SetupMode: "api_key"}, []acpRuntimeFile{file}); err == nil {
		t.Fatal("untracked identical file was adopted")
	}
	if fixture.writes != 0 || fixture.removes != 0 {
		t.Fatal("unowned file changed")
	}
}

func TestACPProfileStorageIdentityAndOAuthEnvironment(t *testing.T) {
	for _, tc := range []struct{ profile, key, suffix string }{{"codex", "CODEX_HOME", "/.codex"}, {"codex", "CODEX_SQLITE_HOME", "/.codex"}, {"claude-code", "CLAUDE_CONFIG_DIR", "/.claude"}} {
		home := "/workspace/.zakura/acp/" + tc.profile + "/home"
		env := acpProfileStorageEnv(tc.profile, home)
		if env[tc.key] != home+tc.suffix {
			t.Fatalf("%s storage=%v", tc.profile, env)
		}
		attempt := &acpTerminalAuthAttempt{ticket: acpTerminalAuthTicket{acpLoginTicket: acpLoginTicket{Profile: tc.profile}}, descriptor: acpTerminalAuthDescriptor{Env: map[string]string{tc.key: "/outside", "HOME": "/tmp", "LOGIN_MODE": "interactive"}}}
		terminal := acpTerminalAuthEnvironment(attempt)
		if terminal[tc.key] != env[tc.key] || terminal["HOME"] != home || terminal["LOGIN_MODE"] != "interactive" || attempt.descriptor.Env[tc.key] != "/outside" {
			t.Fatal("descriptor redirected identity or was mutated")
		}
	}
	for _, profile := range []string{"codex", "claude-code"} {
		setup := acpSetup{ID: profile, SetupMode: "oauth", ModelProvider: "native", Managed: map[string]string{"api_key": "old-managed-secret", "oauth_token": "oauth-token"}, Env: map[string]string{"SSL_CERT_FILE": "/user.pem"}}
		env, err := acpNativeOAuthEnv(setup)
		if err != nil {
			t.Fatal(err)
		}
		keys := []string{}
		for key, value := range env {
			if value != "" {
				t.Fatal("OAuth inherited a credential")
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if len(keys) == 0 {
			t.Fatal("auth defaults not shadowed")
		}
		if _, exists := env["SSL_CERT_FILE"]; exists {
			t.Fatal("certificate override erased")
		}
		key := "OPENAI_API_KEY"
		if profile == "claude-code" {
			key = "ANTHROPIC_API_KEY"
		}
		setup.Env[key] = "explicit-secret"
		if _, err := acpNativeOAuthEnv(setup); err == nil || strings.Contains(err.Error(), "explicit-secret") {
			t.Fatalf("missing safe auth-env conflict: %v", err)
		}
	}
}
