// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

func stdioPlatformAdminSession(t *testing.T, d *appdeps.Dependencies, tenant string) string {
	t.Helper()
	nowTime := d.Clock()
	now := nowTime.Format(time.RFC3339Nano)
	userID, email, sessionID := "stdio-admin", "stdio-admin@example.test", "stdio-admin-session"
	if _, err := d.DB.Exec(`INSERT INTO users(id,email,name,password_hash,is_platform_admin,status,created_at,updated_at) VALUES(?,?,?,'unused',TRUE,'active',?,?)`, userID, email, "Stdio Admin", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES('stdio-admin-membership',?,?,'owner','active',?,?)`, tenant, userID, now, now); err != nil {
		t.Fatal(err)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": userID, "tenantId": tenant, "email": email, "role": "owner", "sid": sessionID, "isPlatformAdmin": true, "iat": nowTime.Unix(), "exp": nowTime.Add(time.Hour).Unix()})
	raw, err := token.SignedString(d.Secret)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(raw))
	if _, err = d.DB.Exec(`INSERT INTO user_sessions(id,user_id,tenant_id,email,role,is_platform_admin,token_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,'owner',TRUE,?,?,?,?)`, sessionID, userID, tenant, email, hex.EncodeToString(sum[:]), nowTime.Add(time.Hour).Format(time.RFC3339Nano), now, now); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestStdioOCIAuthorizationRequiresPlatformAdmin(t *testing.T) {
	for _, tc := range []struct {
		name, role, command, packageManager string
		platformAdmin                       bool
		wantApproved, wantDenied            bool
	}{
		{name: "member explicit OCI", role: "member", command: "npx", packageManager: "oci", wantDenied: true},
		{name: "tenant owner explicit OCI", role: "owner", command: "npx", packageManager: " OCI ", wantDenied: true},
		{name: "member inferred Docker", command: "docker", wantDenied: true},
		{name: "member inferred Podman", command: "podman", wantDenied: true},
		{name: "platform admin explicit OCI", command: "npx", packageManager: "oci", platformAdmin: true, wantApproved: true},
		{name: "platform admin inferred Docker", command: "docker", platformAdmin: true, wantApproved: true},
		{name: "ordinary npm", command: "npx"},
		{name: "ordinary binary", command: "server", packageManager: "binary"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			approved, err := authorizeStdioOCI(httpx.Principal{Role: tc.role, IsPlatformAdmin: tc.platformAdmin}, tc.command, tc.packageManager)
			if approved != tc.wantApproved || errors.Is(err, errStdioOCIPlatformAdminRequired) != tc.wantDenied {
				t.Fatalf("approved=%v err=%v", approved, err)
			}
		})
	}
}

func TestStdioOCIStoredApprovalRequired(t *testing.T) {
	for _, tc := range []struct {
		name, config string
		wantDenied   bool
	}{
		{name: "legacy explicit OCI", config: `{"command":"npx","packageManager":"oci"}`, wantDenied: true},
		{name: "legacy inferred Docker", config: `{"command":"docker"}`, wantDenied: true},
		{name: "legacy inferred Podman", config: `{"command":"podman"}`, wantDenied: true},
		{name: "approved OCI", config: `{"command":"docker","ociPlatformApproved":true}`},
		{name: "ordinary npm", config: `{"command":"npx"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, ok := stdioBodyFromConfig(json.RawMessage(tc.config))
			if !ok {
				t.Fatal("stdio config was not recognized")
			}
			if err := requireStdioOCIApproval(body); errors.Is(err, errStdioOCIPlatformAdminRequired) != tc.wantDenied {
				t.Fatalf("approval error=%v", err)
			}
		})
	}
}

func TestStdioOCIControlAliasesAreRejected(t *testing.T) {
	for _, config := range []string{
		`{"command":"npx","PackageManager":"oci","OCIPlatformApproved":true}`,
		`{"Command":"docker","ociPlatformApproved":true}`,
		`{"command":"npx","packageManager":["oci"]}`,
		`{"command":"docker","ociPlatformApproved":"true"}`,
	} {
		if err := requireStdioOCIConfigApproval(json.RawMessage(config)); err == nil {
			t.Fatalf("non-canonical OCI control accepted: %s", config)
		}
	}
}

func readRunnerServerText(r *bufio.Reader) (string, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return "", err
	}
	n := uint64(head[1] & 0x7f)
	if n == 126 {
		var value [2]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return "", err
		}
		n = uint64(binary.BigEndian.Uint16(value[:]))
	} else if n == 127 {
		var value [8]byte
		if _, err := io.ReadFull(r, value[:]); err != nil {
			return "", err
		}
		n = binary.BigEndian.Uint64(value[:])
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return "", err
	}
	return string(payload), nil
}

func TestMCPRPCNegotiatesStreamableHTTPSession(t *testing.T) {
	var initialized, notified, deleted int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleted++
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&request)
		sid := r.Header.Get("Mcp-Session-Id")
		switch request.Method {
		case "initialize":
			initialized++
			w.Header().Set("Mcp-Session-Id", "session-1")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}}})
		case "notifications/initialized":
			if sid != "session-1" {
				t.Errorf("notification session: %q", sid)
			}
			notified++
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			if sid == "" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid or missing session ID"},"id":null}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"tools": []map[string]any{{"name": "echo"}}}})
		}
	}))
	defer upstream.Close()
	d := testDeps(t)
	store := NewStore(d)
	h := &handler{deps: d, store: store}
	h.service = NewService(store)
	config, _ := json.Marshal(map[string]any{"url": upstream.URL})
	result, err := h.mcpRPC(context.Background(), mcpInstance{ID: "mcp", TenantID: "tenant", Config: config, Secret: json.RawMessage(`{}`)}, "tools/list", map[string]any{})
	if err != nil || !strings.Contains(string(result), `"name":"echo"`) || initialized != 1 || notified != 1 || deleted != 1 {
		t.Fatalf("streamable HTTP negotiation: result=%s err=%v init=%d notified=%d deleted=%d", result, err, initialized, notified, deleted)
	}
}

func TestImportStdioProvisionsNativeBridgeOnRunner(t *testing.T) {
	var bridgeInit, bridgeList, bridgeDelete atomic.Int64
	bridgeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ready": false})
			return
		}
		if r.Method == http.MethodDelete {
			bridgeDelete.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&request)
		switch request.Method {
		case "initialize":
			bridgeInit.Add(1)
			w.Header().Set("Mcp-Session-Id", "warmup")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}}})
		case "notifications/initialized":
			if r.Header.Get("Mcp-Session-Id") != "warmup" {
				t.Errorf("warmup notification session: %q", r.Header.Get("Mcp-Session-Id"))
			}
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			bridgeList.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"tools": []any{}}})
		default:
			http.Error(w, "unexpected MCP method", http.StatusBadRequest)
		}
	}))
	defer bridgeServer.Close()
	bridgeURL, _ := url.Parse(bridgeServer.URL)
	bridgePort, _ := strconv.Atoi(bridgeURL.Port())
	d := testDeps(t)
	memberToken := seedTenant(t, d, "tenant")
	token := stdioPlatformAdminSession(t, d, "tenant")
	runnerToken := "rnr_stdio-runner-token"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	nodeID := "node"
	store := NewStore(d)
	space, _ := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", RuntimeNodeID: &nodeID, WorkspaceKind: "host"})
	agent, _ := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	runRequest := make(chan map[string]any, 1)
	stopRequest := make(chan map[string]any, 1)
	runnerErrors := make(chan error, 1)
	go func() {
		var container map[string]any
		u, _ := url.Parse(server.URL)
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			runnerErrors <- err
			return
		}
		defer conn.Close()
		_, _ = fmt.Fprintf(conn, "GET /api/runtime-nodes/hub HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host, runnerToken)
		reader := bufio.NewReader(conn)
		status, _ := reader.ReadString('\n')
		if !strings.Contains(status, "101") {
			runnerErrors <- fmt.Errorf("upgrade status %q", status)
			return
		}
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		for {
			raw, readErr := readRunnerServerText(reader)
			if readErr != nil {
				return
			}
			var frame struct {
				Type   string         `json:"type"`
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal([]byte(raw), &frame); err != nil {
				runnerErrors <- err
				return
			}
			if frame.Type != "req" {
				continue
			}
			var result any
			switch frame.Method {
			case "sys.info":
				result = map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"docker": true}, "hostInfo": map[string]any{"primaryIp": bridgeURL.Hostname(), "hostname": "runner.local", "platform": "linux"}}
			case "docker.pull":
				result = map[string]any{"ok": true}
			case "host.fs.mkdir":
				if frame.Params["spaceId"] != space.ID || frame.Params["path"] != "/.zakura/components/id-000003" {
					runnerErrors <- fmt.Errorf("component storage escaped bound space: %#v", frame.Params)
					return
				}
				result = map[string]any{"ok": true, "path": frame.Params["path"], "abs": "/srv/zakura/workspaces/" + space.ID + "/.zakura/components/id-000003"}
			case "docker.create":
				runRequest <- frame.Params
				container = map[string]any{"dockerId": "docker-1", "name": frame.Params["name"], "image": frame.Params["image"], "labels": frame.Params["labels"], "status": "running", "ports": []map[string]any{{"containerPort": 3100, "hostPort": bridgePort, "protocol": "tcp"}}}
				result = container
			case "docker.list":
				result = []any{}
				if container != nil {
					result = []any{container}
				}
			case "docker.inspect":
				result = container
			case "docker.stop":
				stopRequest <- frame.Params
				if frame.Params["remove"] == true {
					container = nil
				} else if container != nil {
					container["status"] = "exited"
				}
				result = map[string]any{"ok": true}
			default:
				runnerErrors <- fmt.Errorf("unexpected method %s", frame.Method)
				return
			}
			response, _ := json.Marshal(map[string]any{"type": "res", "id": frame.ID, "ok": true, "result": result})
			writeMaskedText(t, conn, string(response))
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner did not become online")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Setenv("ZAKURA_STDIO_BRIDGE_IMAGE", "bridge:test")
	code, out := doJSON(t, server.Client(), "POST", server.URL+"/api/mcp/import-stdio", token, map[string]any{"name": "Local tools", "command": "docker", "args": []string{"run", "-i", "server"}, "env": map[string]string{"DEMO": "yes"}, "packageManager": "oci", "runtimeNodeId": "node", "agentIds": []string{agent.ID}})
	if code != 201 || out["started"] != true {
		t.Fatalf("import stdio: %d %#v", code, out)
	}
	select {
	case params := <-runRequest:
		command, _ := params["command"].([]any)
		if len(command) != 1 || command[0] != "/usr/local/bin/zakura-stdio-bridge" || params["image"] != "bridge:test" {
			t.Fatalf("native bridge launch: %#v", params)
		}
		env, _ := params["env"].(map[string]any)
		if env["MCP_COMMAND"] != "docker" || env["MCP_ARGS"] != `["run","-i","server"]` || env["DEMO"] != "yes" || env["DOCKER_HOST"] != "unix:///var/run/docker.sock" {
			t.Fatalf("bridge environment: %#v", env)
		}
		volumes, _ := params["volumes"].([]any)
		if len(volumes) != 2 || volumes[0].(map[string]any)["containerPath"] != "/data" || volumes[1].(map[string]any)["hostPath"] != "/var/run/docker.sock" || volumes[1].(map[string]any)["containerPath"] != "/var/run/docker.sock" {
			t.Fatalf("OCI Docker socket mount: %#v", params["volumes"])
		}
	case err := <-runnerErrors:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not receive docker.run")
	}
	var config, status string
	expectedEndpoint := `"url":"` + bridgeServer.URL + `/mcp"`
	if err = d.DB.QueryRow(`SELECT config_json,status FROM component_instances WHERE tenant_id='tenant'`).Scan(&config, &status); err != nil || status != "running" || !strings.Contains(config, expectedEndpoint) || !strings.Contains(config, `"runtimeNodeId":"node"`) || !strings.Contains(config, `"packageManager":"oci"`) || !strings.Contains(config, `"ociPlatformApproved":true`) {
		t.Fatalf("persisted component config/status: err=%v status=%q config=%s", err, status, config)
	}
	instance := out["instance"].(map[string]any)
	instanceID := instance["id"].(string)
	if code, denied := doJSON(t, server.Client(), "PATCH", server.URL+"/api/instances/"+instanceID, memberToken, map[string]any{"config": map[string]any{"args": []string{"run", "--privileged", "server"}}}); code != http.StatusForbidden {
		t.Fatalf("tenant changed approved OCI execution: %d %#v", code, denied)
	}
	if bridgeInit.Load() != 1 || bridgeList.Load() != 1 || bridgeDelete.Load() != 1 {
		t.Fatalf("bridge MCP warmup: initialize=%d list=%d delete=%d", bridgeInit.Load(), bridgeList.Load(), bridgeDelete.Load())
	}
	if strings.Contains(config, `"env"`) || strings.Contains(config, `"DEMO":"yes"`) {
		t.Fatalf("stdio environment leaked into config_json: %s", config)
	}
	var secretStored string
	if err = d.DB.QueryRow(`SELECT secret_json FROM component_instances WHERE id=?`, instanceID).Scan(&secretStored); err != nil || strings.Contains(secretStored, "yes") {
		t.Fatalf("stdio secret storage leak: %s err=%v", secretStored, err)
	}
	var secretEnvelope struct {
		Enc string `json:"enc"`
	}
	_ = json.Unmarshal([]byte(secretStored), &secretEnvelope)
	plain, decryptErr := openSecretBox(d.Secret, "mcp:"+instanceID, secretEnvelope.Enc)
	if decryptErr != nil || !strings.Contains(string(plain), `"DEMO":"yes"`) {
		t.Fatalf("stdio secret round trip: %s err=%v", plain, decryptErr)
	}
	code, detail := doJSON(t, server.Client(), "GET", server.URL+"/api/instances/"+instanceID, token, nil)
	if code != 200 || strings.Contains(fmt.Sprint(detail["config"]), "yes") {
		t.Fatalf("instance DTO leaked secret: %d %#v", code, detail)
	}
	code, _ = doJSON(t, server.Client(), "POST", server.URL+"/api/instances/"+instanceID+"/stop", token, map[string]any{})
	if code != 200 {
		t.Fatalf("stop stdio instance: %d", code)
	}
	select {
	case <-stopRequest:
	case <-time.After(time.Second):
		t.Fatal("stop did not reach runner")
	}
	code, restarted := doJSON(t, server.Client(), "POST", server.URL+"/api/instances/"+instanceID+"/start", token, map[string]any{})
	if code != 200 || restarted["status"] != "running" {
		t.Fatalf("restart stdio instance: %d %#v", code, restarted)
	}
	select {
	case params := <-runRequest:
		env := params["env"].(map[string]any)
		if env["DEMO"] != "yes" {
			t.Fatalf("restart lost encrypted env: %#v", env)
		}
	case <-time.After(time.Second):
		t.Fatal("restart did not reprovision runner container")
	}
	if bridgeInit.Load() != 2 || bridgeList.Load() < 2 || bridgeDelete.Load() != 2 {
		t.Fatalf("restart bridge warmup: initialize=%d list=%d delete=%d", bridgeInit.Load(), bridgeList.Load(), bridgeDelete.Load())
	}
	var count int
	if err = d.DB.QueryRow(`SELECT COUNT(*) FROM managed_containers WHERE tenant_id='tenant' AND runtime_node_id='node' AND docker_id='docker-1'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("managed container not persisted: count=%d err=%v", count, err)
	}
	if d.BeforeTenantDelete == nil || d.AfterMemberRemoved == nil {
		t.Fatal("runtime lifecycle callbacks were not installed")
	}
	if err = d.BeforeTenantDelete(context.Background(), "tenant"); err != nil {
		t.Fatalf("tenant runtime cleanup: %v", err)
	}
	select {
	case params := <-stopRequest:
		if params["id"] != "docker-1" || params["remove"] != true {
			t.Fatalf("container cleanup request: %#v", params)
		}
	case <-time.After(time.Second):
		t.Fatal("tenant cleanup did not stop runtime container")
	}
	if err = d.BeforeTenantDelete(context.Background(), "tenant"); err != nil {
		t.Fatalf("tenant cleanup is not idempotent: %v", err)
	}
}
