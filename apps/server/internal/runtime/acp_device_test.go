// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

type deviceRoundTripper func(*http.Request) (*http.Response, error)

func (f deviceRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func deviceResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

type deviceTestRig struct {
	h         *handler
	space     Space
	tick      atomic.Int64
	writes    atomic.Int64
	polls     atomic.Int64
	exchanges atomic.Int64
	private   atomic.Bool
	failWrite atomic.Bool
	mu        sync.Mutex
	auth      map[string]any
	poll      func(*http.Request) (*http.Response, error)
	fs        *acpHomeFixture
}

func newDeviceTestRig(t *testing.T) *deviceTestRig {
	t.Helper()
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	rig := &deviceTestRig{fs: newACPHomeFixture()}
	rig.tick.Store(time.Now().UTC().Truncate(time.Second).UnixMilli())
	rig.private.Store(true)
	d.Clock = func() time.Time { return time.UnixMilli(rig.tick.Load()).UTC() }
	node := "node"
	space, err := NewStore(d).CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &node, WorkspaceKind: "host", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	rig.space = space
	rig.h = builtinToolHarness(t, d, "rnr_device-codex", func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"storageRoot": "/srv/zakura", "version": "test", "kind": "computer", "capabilities": map[string]any{"host": true, "privateAtomicFS": rig.private.Load(), "filesystemNoFollowStat": true}}, nil
		case "host.fs.list", "host.fs.stat", "host.fs.read", "host.fs.mkdir", "host.fs.remove":
			return rig.fs.run(method, params)
		case "host.fs.write":
			if _, credentialWrite := params["base64"]; !credentialWrite {
				return rig.fs.run(method, params)
			}
			rig.writes.Add(1)
			if params["spaceId"] != space.ID || params["path"] != "/.zakura/acp/codex/home/.codex/auth.json" || params["mode"] != float64(384) || params["atomic"] != true {
				return nil, fmt.Errorf("unsafe write target")
			}
			raw, _ := base64.StdEncoding.DecodeString(params["base64"].(string))
			var auth map[string]any
			_ = json.Unmarshal(raw, &auth)
			rig.mu.Lock()
			rig.auth = auth
			rig.mu.Unlock()
			if rig.failWrite.Load() {
				return nil, fmt.Errorf("unconfirmed fixture write")
			}
			return rig.fs.run(method, params)
		default:
			return nil, fmt.Errorf("unexpected runner method %s", method)
		}
	})
	if err = rig.h.saveSpaceACP(context.Background(), "tenant", space.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "oauth", "modelProvider": "native"}}}); err != nil {
		t.Fatal(err)
	}
	d.HTTPClient = &http.Client{Transport: deviceRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "auth.openai.com" {
			return nil, fmt.Errorf("untrusted auth endpoint")
		}
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client_id"] != codexDeviceClientID || r.Header.Get("Content-Type") != "application/json" {
				return nil, fmt.Errorf("invalid usercode contract")
			}
			return deviceResponse(200, `{"device_auth_id":"server-device-secret","user_code":"ABCD-EFGH","interval":"5"}`), nil
		case "/api/accounts/deviceauth/token":
			rig.polls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["device_auth_id"] != "server-device-secret" || body["user_code"] != "ABCD-EFGH" {
				return nil, fmt.Errorf("invalid token poll contract")
			}
			if rig.poll != nil {
				return rig.poll(r)
			}
			return deviceResponse(200, `{"authorization_code":"authorization-secret","code_verifier":"verifier-secret","code_challenge":"challenge"}`), nil
		case "/oauth/token":
			rig.exchanges.Add(1)
			_ = r.ParseForm()
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("client_id") != codexDeviceClientID || r.Form.Get("code") != "authorization-secret" || r.Form.Get("code_verifier") != "verifier-secret" || r.Form.Get("redirect_uri") != codexDeviceIssuer+"/deviceauth/callback" {
				return nil, fmt.Errorf("invalid OAuth exchange contract")
			}
			jwt := "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"account-1"}}`)) + ".signature"
			body, _ := json.Marshal(map[string]any{"id_token": jwt, "access_token": "access-secret", "refresh_token": "refresh-secret"})
			return deviceResponse(200, string(body)), nil
		default:
			return nil, fmt.Errorf("unexpected auth path %s", r.URL.Path)
		}
	})}
	return rig
}
func (r *deviceTestRig) advance(d time.Duration) { r.tick.Add(d.Milliseconds()) }
func (r *deviceTestRig) start(t *testing.T) acpDevicePublic {
	t.Helper()
	a, err := r.h.startACPDeviceAttempt(context.Background(), "user", "tenant", r.space.ID, "codex")
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestCodexDeviceFlowKeepsSecretsServerSideAndSavesPrivateHOME(t *testing.T) {
	rig := newDeviceTestRig(t)
	a := rig.start(t)
	raw, _ := json.Marshal(a)
	if strings.Contains(string(raw), "server-device-secret") || a.UserCode != "ABCD-EFGH" || a.VerificationURI != codexDeviceIssuer+"/codex/device" {
		t.Fatalf("public attempt %#v", a)
	}
	stored, err := rig.h.acpDeviceLoad(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.EncryptedPayload == "" || strings.Contains(stored.EncryptedPayload, "server-device-secret") {
		t.Fatal("device code not encrypted")
	}
	if _, err = computers.OpenCredentials(rig.h.deps.Secret, "tenant", rig.space.ID, "acp-device:other", stored.EncryptedPayload); err == nil {
		t.Fatal("envelope identity not bound")
	}
	if _, err = rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID); err != nil {
		t.Fatal(err)
	}
	if rig.polls.Load() != 0 {
		t.Fatal("interval not enforced")
	}
	rig.advance(6 * time.Second)
	// Reconstructed handler over the same DB can resume pending encrypted attempts.
	fresh := &handler{deps: rig.h.deps, store: rig.h.store, hub: rig.h.hub}
	a, err = fresh.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != "complete" || rig.writes.Load() != 1 || rig.exchanges.Load() != 1 {
		t.Fatalf("flow %#v writes %d", a, rig.writes.Load())
	}
	rig.mu.Lock()
	auth := rig.auth
	rig.mu.Unlock()
	tokens := auth["tokens"].(map[string]any)
	if auth["auth_mode"] != "chatgpt" || auth["OPENAI_API_KEY"] != nil || tokens["account_id"] != "account-1" || tokens["access_token"] != "access-secret" {
		t.Fatalf("wrong auth.json schema %#v", auth)
	}
	stored, err = rig.h.acpDeviceLoad(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || stored.EncryptedPayload != "" {
		t.Fatal("terminal attempt retains code", err)
	}
	raw, _ = json.Marshal(a)
	if strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "token") {
		t.Fatalf("token leaked %s", raw)
	}
}

func TestCodexDeviceCancelFencesInFlightPoll(t *testing.T) {
	rig := newDeviceTestRig(t)
	entered, release := make(chan struct{}), make(chan struct{})
	rig.poll = func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return deviceResponse(200, `{"authorization_code":"authorization-secret","code_verifier":"verifier-secret"}`), nil
	}
	a := rig.start(t)
	rig.advance(6 * time.Second)
	finished := make(chan error, 1)
	go func() {
		_, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
		finished <- err
	}()
	<-entered
	if err := rig.h.cancelACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-finished
	if rig.writes.Load() != 0 || rig.exchanges.Load() != 0 {
		t.Fatal("cancelled poll redeemed or wrote credentials")
	}
	stored, err := rig.h.acpDeviceLoad(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || stored.Status != "cancelled" || stored.EncryptedPayload != "" {
		t.Fatal(stored, err)
	}
}

func TestCodexDeviceAttemptsScopeExpiryPolicyAndSecureWritePreflight(t *testing.T) {
	rig := newDeviceTestRig(t)
	ctx := context.Background()
	if _, err := rig.h.startACPDeviceAttempt(ctx, "user", "tenant", rig.space.ID, "claude"); err == nil {
		t.Fatal("non-Codex profile accepted")
	}
	a := rig.start(t)
	if _, err := rig.h.startACPDeviceAttempt(ctx, "user", "tenant", rig.space.ID, "codex"); err == nil {
		t.Fatal("parallel profile attempt accepted")
	}
	if _, err := rig.h.pollACPDeviceAttempt(ctx, "other-user", "tenant", rig.space.ID, "codex", a.AttemptID); err == nil {
		t.Fatal("cross-user poll accepted")
	}
	if err := rig.h.cancelACPDeviceAttempt(ctx, "other-user", "tenant", rig.space.ID, "codex", a.AttemptID); err == nil {
		t.Fatal("cross-user cancel accepted")
	}
	rig.advance(16 * time.Minute)
	a, err := rig.h.pollACPDeviceAttempt(ctx, "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "expired" || rig.polls.Load() != 0 {
		t.Fatal(a, err)
	}
	a = rig.start(t)
	rig.private.Store(false)
	rig.advance(6 * time.Second)
	a, err = rig.h.pollACPDeviceAttempt(ctx, "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "failed" || rig.writes.Load() != 0 {
		t.Fatal("old runner received tokens", a, err)
	}
}

func TestCodexDeviceUnknownWriteNeverReplays(t *testing.T) {
	rig := newDeviceTestRig(t)
	a := rig.start(t)
	rig.failWrite.Store(true)
	rig.advance(6 * time.Second)
	a, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "unknown" {
		t.Fatal(a, err)
	}
	rig.failWrite.Store(false)
	rig.advance(time.Hour)
	a, err = rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "unknown" || rig.writes.Load() != 1 {
		t.Fatal("unknown replayed", a, err)
	}
	if _, err = rig.h.startACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex"); err == nil {
		t.Fatal("quarantined profile accepted new device login")
	}
	if err = rig.h.acquireACPAuthLock(context.Background(), "tenant", rig.space.ID, "codex", "terminal-pending", "new-terminal", time.Minute); err == nil {
		t.Fatal("quarantined profile accepted terminal login")
	}
}

func TestCodexDeviceInterruptedPersistingQuarantinesWithoutReplay(t *testing.T) {
	rig := newDeviceTestRig(t)
	a := rig.start(t)
	if err := rig.h.deps.Gorm.Table(acpDeviceTable).Where("id=?", a.AttemptID).Updates(map[string]any{"status": "persisting", "next_poll_at": runtimeTimeString(rig.h.store.now().Add(time.Minute))}).Error; err != nil {
		t.Fatal(err)
	}
	rig.advance(2 * time.Minute)
	a, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "unknown" || rig.writes.Load() != 0 {
		t.Fatal(a, err)
	}
	stored, err := rig.h.acpDeviceLoad(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || stored.EncryptedPayload != "" {
		t.Fatal("interrupted write retained secret", err)
	}
}

func TestCodexDevicePollPendingAndProfileChanges(t *testing.T) {
	rig := newDeviceTestRig(t)
	rig.poll = func(*http.Request) (*http.Response, error) {
		return deviceResponse(403, `{"error":"private upstream diagnostic"}`), nil
	}
	a := rig.start(t)
	rig.advance(6 * time.Second)
	a, err := rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "pending" {
		t.Fatal(a, err)
	}
	if err = rig.h.saveSpaceACP(context.Background(), "tenant", rig.space.ID, map[string]any{"agents": map[string]any{"codex": map[string]any{"enabled": true, "setupMode": "oauth", "modelProvider": "native", "pinnedVersion": "changed"}}}); err != nil {
		t.Fatal(err)
	}
	rig.advance(6 * time.Second)
	a, err = rig.h.pollACPDeviceAttempt(context.Background(), "user", "tenant", rig.space.ID, "codex", a.AttemptID)
	if err != nil || a.Status != "failed" || rig.writes.Load() != 0 {
		t.Fatal("changed profile used", a, err)
	}
}
