// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestZakuraBotRunnerExecDesktopFilesAndPendingInteraction(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	runnerToken := "rnr_zakurabot-positive"
	hash := sha256.Sum256([]byte(runnerToken))
	now := d.Clock()
	_, err := d.DB.Exec(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,token_hash,capabilities_json,host_info_json,storage_root,labels_json,is_shared,created_at,updated_at) VALUES('node','tenant','Runner','runner','computer','offline',?,'{}','{}','/srv/zakura','{}',false,?,?)`, hex.EncodeToString(hash[:]), now, now)
	if err != nil {
		t.Fatal(err)
	}
	node := "node"
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Bot Space", RuntimeNodeID: &node, WorkspaceKind: "container", EnableComputer: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB.Exec(`UPDATE spaces SET workspace_status='running' WHERE id=?`, space.ID); err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Bot", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()

	png := []byte("\x89PNG\r\n\x1a\npositive-frame")
	var filesMu sync.Mutex
	files := map[string][]byte{}
	startMigrationRunner(t, server.URL, runnerToken, func(method string, params map[string]any) (any, error) {
		switch method {
		case "sys.info":
			return map[string]any{"version": "test", "kind": "computer", "storageRoot": "/srv/zakura", "capabilities": map[string]any{"host": true, "docker": true}, "hostInfo": map[string]any{}}, nil
		case "docker.list":
			return []map[string]any{{"dockerId": "workspace-container", "labels": map[string]string{"zakura.space": space.ID, "zakura.purpose": "workspace"}}}, nil
		case "docker.exec":
			command, _ := params["command"].([]any)
			if len(command) >= 3 && command[0] == "bash" && command[1] == "-lc" {
				return map[string]any{"exitCode": 0, "stdout": "runner:" + fmt.Sprint(command[2]) + "\n", "stderr": ""}, nil
			}
			if len(command) >= 3 && command[0] == "sh" && command[1] == "-lc" {
				return map[string]any{"exitCode": 0, "stdout": base64.StdEncoding.EncodeToString(png), "stderr": ""}, nil
			}
			return nil, fmt.Errorf("unexpected docker command %#v", command)
		case "host.fs.write":
			path := fmt.Sprint(params["path"])
			data, decodeErr := base64.StdEncoding.DecodeString(fmt.Sprint(params["base64"]))
			if decodeErr != nil || params["spaceId"] != space.ID {
				return nil, fmt.Errorf("invalid jailed upload")
			}
			filesMu.Lock()
			files[path] = append([]byte(nil), data...)
			filesMu.Unlock()
			return map[string]any{"ok": true, "path": path}, nil
		case "host.fs.read":
			path := fmt.Sprint(params["path"])
			filesMu.Lock()
			data := append([]byte(nil), files[path]...)
			filesMu.Unlock()
			if len(data) == 0 || params["spaceId"] != space.ID {
				return nil, fmt.Errorf("missing jailed upload")
			}
			return map[string]any{"path": path, "base64": base64.StdEncoding.EncodeToString(data), "size": len(data)}, nil
		default:
			return nil, fmt.Errorf("unexpected runner method %s", method)
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		_ = d.DB.QueryRow(`SELECT status FROM runtime_nodes WHERE id='node'`).Scan(&status)
		if status == "online" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	client := server.Client()
	code, body := doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents", token, nil)
	if code != 200 || len(body["agents"].([]any)) != 1 {
		t.Fatalf("roster: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/exec", token, map[string]any{"command": "pwd"})
	if code != 200 || body["exitCode"] != float64(0) || !strings.Contains(fmt.Sprint(body["output"]), "runner:pwd") {
		t.Fatalf("runner exec: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/desktop", token, nil)
	if code != 200 || body["enabled"] != true || body["supported"] != true || body["frameUrl"] == nil {
		t.Fatalf("desktop info: %d %#v", code, body)
	}
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/desktop/frame", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	frame, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || !bytes.Equal(frame, png) {
		t.Fatalf("desktop frame: %d %q %#v", resp.StatusCode, resp.Header.Get("Content-Type"), frame)
	}

	var multipartBody bytes.Buffer
	writer := multipart.NewWriter(&multipartBody)
	part, _ := writer.CreateFormFile("file", "../note.txt")
	_, _ = part.Write([]byte("hello from phone"))
	_ = writer.Close()
	req, _ = http.NewRequest(http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/files", &multipartBody)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var uploaded map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&uploaded)
	resp.Body.Close()
	file, _ := uploaded["file"].(map[string]any)
	if resp.StatusCode != http.StatusCreated || file["name"] != "note.txt" {
		t.Fatalf("file upload: %d %#v", resp.StatusCode, uploaded)
	}
	fileID := fmt.Sprint(file["id"])
	req, _ = http.NewRequest(http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/files/"+fileID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	downloaded, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(downloaded) != "hello from phone" || !strings.Contains(resp.Header.Get("Content-Disposition"), "note.txt") {
		t.Fatalf("file download: %d %q %q", resp.StatusCode, downloaded, resp.Header.Get("Content-Disposition"))
	}

	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/sessions/"+agent.ID, token, map[string]any{"action": "start"})
	if code != 200 {
		t.Fatalf("managed session: %d %#v", code, body)
	}
	managed := body["session"].(map[string]any)
	sessionID := fmt.Sprint(managed["sessionId"])
	questionID, err := store.CreateQuestion(context.Background(), "tenant", agent.ID, sessionID, "", "", QuestionRequest{Question: "Continue?", Mode: "async"})
	if err != nil {
		t.Fatal(err)
	}
	code, body = doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/interactions", token, nil)
	if code != 200 || len(body["interactions"].([]any)) != 1 {
		t.Fatalf("pending interactions: %d %#v", code, body)
	}
	interactionID := fmt.Sprint(body["interactions"].([]any)[0].(map[string]any)["messageId"])
	code, body = doJSON(t, client, http.MethodGet, server.URL+"/api/zakurabot/agents/"+agent.ID+"/interactions/"+interactionID, token, nil)
	if code != 200 || body["status"] != "pending" || body["requestId"] != questionID {
		t.Fatalf("interaction detail: %d %#v", code, body)
	}
	code, body = doJSON(t, client, http.MethodPost, server.URL+"/api/zakurabot/agents/"+agent.ID+"/interactions/"+interactionID, token, map[string]any{"text": "yes"})
	if code != 200 || body["ok"] != true || body["status"] != "answered" || body["interaction"].(map[string]any)["status"] != "answered" {
		t.Fatalf("interaction answer: %d %#v", code, body)
	}
	var questionStatus, answerJSON string
	if err = d.DB.QueryRow(`SELECT status,answer_json FROM agent_user_questions WHERE id=?`, questionID).Scan(&questionStatus, &answerJSON); err != nil || questionStatus != "answered" || !strings.Contains(answerJSON, "yes") {
		t.Fatalf("question source not resolved: status=%q answer=%s err=%v", questionStatus, answerJSON, err)
	}
}
