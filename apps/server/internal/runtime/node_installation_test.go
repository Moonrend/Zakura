package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/bootstrap"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/identity"
)

func installationHandler(t *testing.T) *handler {
	t.Helper()
	d := testDeps(t)
	i, err := bootstrap.Initialize(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &handler{deps: d, store: NewStore(d), nodeInstallation: &i}
}

func setupInstallation(t *testing.T, h *handler) string {
	t.Helper()
	result, err := identity.New(h.deps).Setup(context.Background(), "owner@example.com", "test-installation-password", "Owner", "Installation", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return result.Tenant.ID
}

func TestComposeEnrollmentWaitsForAdministratorSetup(t *testing.T) {
	h := installationHandler(t)
	h.deps.Edition = "saas"
	if _, err := identity.New(h.deps).Register(context.Background(), "member@example.com", "test-member-password", "Member", "Other tenant", "", "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.provisionComposeNode(context.Background(), *h.nodeInstallation, "node-incarnation"); !errors.Is(err, errInstallationWaiting) {
		t.Fatalf("before setup: %v", err)
	}
	tenant := setupInstallation(t, h)
	credential, err := h.provisionComposeNode(context.Background(), *h.nodeInstallation, "node-incarnation")
	if err != nil {
		t.Fatal(err)
	}
	var actual string
	var shared bool
	if err := h.deps.DB.QueryRow(`SELECT tenant_id,is_shared FROM runtime_nodes WHERE id=?`, credential.NodeID).Scan(&actual, &shared); err != nil {
		t.Fatal(err)
	}
	if actual != tenant || shared {
		t.Fatal("installation node assigned to the wrong tenant or shared")
	}
	if _, err := h.deps.DB.Exec(`UPDATE users SET is_platform_admin=FALSE`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.provisionComposeNode(context.Background(), *h.nodeInstallation, "node-incarnation"); !errors.Is(err, errInstallationWaiting) {
		t.Fatalf("without admin owner: %v", err)
	}
}

func TestComposeEnrollmentConcurrentAndRestart(t *testing.T) {
	checkEnrollmentConcurrency(t, installationHandler(t))
}

func TestPostgresComposeEnrollmentConcurrentAndRestart(t *testing.T) {
	d := runtimePostgresDeps(t)
	i, err := bootstrap.Initialize(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	checkEnrollmentConcurrency(t, &handler{deps: d, store: NewStore(d), nodeInstallation: &i})
}

func checkEnrollmentConcurrency(t *testing.T, h *handler) {
	t.Helper()
	setupInstallation(t, h)
	const count = 8
	credentials := make([]bootstrap.Credential, count)
	errorsSeen := make([]error, count)
	var wg sync.WaitGroup
	for i := range count {
		wg.Go(func() {
			credentials[i], errorsSeen[i] = h.provisionComposeNode(context.Background(), *h.nodeInstallation, "node-incarnation")
		})
	}
	wg.Wait()
	for i, err := range errorsSeen {
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		if credentials[i] != credentials[0] {
			t.Fatal("retries changed enrollment")
		}
	}
	restarted := &handler{deps: h.deps, store: NewStore(h.deps), nodeInstallation: h.nodeInstallation}
	again, err := restarted.provisionComposeNode(context.Background(), *h.nodeInstallation, "node-incarnation")
	if err != nil || again != credentials[0] {
		t.Fatalf("restart changed enrollment: %v", err)
	}
	var nodes, installations int
	if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM runtime_nodes`).Scan(&nodes); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.DB.QueryRow(`SELECT COUNT(*) FROM node_installations`).Scan(&installations); err != nil {
		t.Fatal(err)
	}
	if nodes != 1 || installations != 1 {
		t.Fatalf("nodes=%d installations=%d", nodes, installations)
	}
	var hash string
	if err := h.deps.DB.QueryRow(h.deps.Rebind(`SELECT token_hash FROM runtime_nodes WHERE id=?`), again.NodeID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(again.Token))
	if hash != hex.EncodeToString(digest[:]) {
		t.Fatal("node credential hash mismatch")
	}
	runnerTokenCache.Store(again.NodeID, "stale-cache-value")
	incarnation, err := h.cacheRuntimeNodeToken(context.Background(), again.NodeID, again.Token)
	if err != nil || incarnation != "node-incarnation" {
		t.Fatalf("hub enrollment: %v", err)
	}
	if _, exists := runnerTokenCache.Load(again.NodeID); exists {
		t.Fatal("Compose credential entered manual-install cache")
	}
	if _, err := h.deps.DB.Exec(`UPDATE node_installations SET revoked=TRUE`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.cacheRuntimeNodeToken(context.Background(), again.NodeID, again.Token); !errors.Is(err, errInstallationRevoked) {
		t.Fatalf("revoked hub enrollment: %v", err)
	}
}

func TestComposeEnrollmentCannotRestoreRevokedIdentity(t *testing.T) {
	for _, change := range []string{"incarnation", "bootstrap", "node-deleted", "token-rotated", "revoked", "server-secret"} {
		t.Run(change, func(t *testing.T) {
			h := installationHandler(t)
			setupInstallation(t, h)
			i, incarnation := *h.nodeInstallation, "node-incarnation"
			credential, err := h.provisionComposeNode(context.Background(), i, incarnation)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "incarnation":
				incarnation = "replacement"
			case "bootstrap":
				i.Secret = strings.Repeat("x", 52)
			case "server-secret":
				h.deps.Secret = []byte(strings.Repeat("x", 32))
			case "node-deleted":
				_, err = h.deps.DB.Exec(`DELETE FROM runtime_nodes WHERE id=?`, credential.NodeID)
			case "token-rotated":
				_, err = h.deps.DB.Exec(`UPDATE runtime_nodes SET token_hash='revoked' WHERE id=?`, credential.NodeID)
			case "revoked":
				_, err = h.deps.DB.Exec(`UPDATE node_installations SET revoked=TRUE`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.provisionComposeNode(context.Background(), i, incarnation); !errors.Is(err, errInstallationRevoked) {
				t.Fatalf("revoked enrollment: %v", err)
			}
		})
	}
}

func TestComposeEnrollmentHTTP(t *testing.T) {
	h := installationHandler(t)
	i := h.nodeInstallation
	body := `{"installationId":"` + i.ID + `","nodeIncarnation":"node-incarnation"}`
	call := func(auth, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/runtime-nodes/installation/enroll", strings.NewReader(body))
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		h.enrollComposeNode(w, r)
		if strings.Contains(w.Body.String(), i.Secret) {
			t.Fatal("bootstrap secret exposed")
		}
		return w
	}
	for _, auth := range []string{"", "Bearer incorrect", i.Secret} {
		if w := call(auth, body); w.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized status %d", w.Code)
		}
	}
	if w := call("Bearer "+i.Secret, body); w.Code != http.StatusConflict {
		t.Fatalf("before setup status %d", w.Code)
	}
	setupInstallation(t, h)
	if w := call("Bearer "+i.Secret, strings.TrimSuffix(body, "}")+`,"tenantId":"another"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("tenant override status %d", w.Code)
	}
	w := call("Bearer "+i.Secret, body)
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("enrollment status %d", w.Code)
	}
	var credential bootstrap.Credential
	if err := json.Unmarshal(w.Body.Bytes(), &credential); err != nil || credential.NodeID == "" || credential.Token == "" {
		t.Fatal("missing credential")
	}
}
