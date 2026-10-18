package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestRunnerBinaryAuthorizationAndArtifactLayouts(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	token := "rnr_binary-fixture"
	sum := sha256.Sum256([]byte(token))
	if err := d.Gorm.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,storage_root,created_at,updated_at) VALUES('node','tenant','node','node','computer','offline',?,'/tmp','before','before')`, hex.EncodeToString(sum[:])).Error; err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: NewStore(d)}
	dir := t.TempDir()
	t.Setenv("ZAKURA_AGENT_BINARIES_DIR", dir)
	t.Setenv("ZAKURA_AGENT_BINARY_DIR", t.TempDir())
	call := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/runtime-nodes/agent-binaries/linux/amd64", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		route := chi.NewRouteContext()
		route.URLParams.Add("os", "linux")
		route.URLParams.Add("arch", "amd64")
		r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route))
		w := httptest.NewRecorder()
		h.runtimeAgentBinary(w, r)
		return w
	}
	if err := os.WriteFile(filepath.Join(dir, "zakura-agent_linux_amd64"), []byte("flat-artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := call(token); w.Code != 200 || w.Body.String() != "flat-artifact" {
		t.Fatalf("valid token flat: %d %s", w.Code, w.Body.String())
	}
	if w := call("rnr_invalid"); w.Code != 401 {
		t.Fatalf("invalid token accepted: %d", w.Code)
	}
	legacy := t.TempDir()
	t.Setenv("ZAKURA_AGENT_BINARIES_DIR", "")
	t.Setenv("ZAKURA_AGENT_BINARY_DIR", legacy)
	if err := os.Mkdir(filepath.Join(legacy, "linux-amd64"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "linux-amd64", "zakura-agent"), []byte("legacy-artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := call(token); w.Code != 200 || w.Body.String() != "legacy-artifact" {
		t.Fatalf("legacy artifact: %d %s", w.Code, w.Body.String())
	}
}

func TestRunnerInstallerUsesOfficialScriptsAndSupportedFlags(t *testing.T) {
	d := testDeps(t)
	h := &handler{deps: d}
	pkg := h.runnerInstallPackage(map[string]any{"id": "node", "slug": "runner", "kind": "computer"}, "rnr_fixture", "")
	script := pkg["script"].(string)
	if strings.Contains(script, "--node-id") {
		t.Fatal("unsupported node id flag")
	}
	for _, required := range []string{"systemctl enable --now zakura-agent", "launchctl bootstrap", "Authorization: Bearer $TOKEN", "-server $SERVER -token $TOKEN -kind $KIND"} {
		if !strings.Contains(script, required) {
			t.Fatalf("official installer missing %q", required)
		}
	}
	quoted := runnerShellInstaller("https://example.test/$(touch nope)", "rnr_x", "computer", "")
	if !strings.Contains(quoted, "export ZAKURA_AGENT_SERVER='https://example.test/$(touch nope)'") {
		t.Fatal("server address is not shell quoted")
	}
}
