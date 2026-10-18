package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
)

// This process is a shell-free fake Docker CLI, not a Docker/node dependency.
func TestMain(m *testing.M) {
	log := os.Getenv("ZAKURA_TEST_RECEIPT_RPC_LOG")
	if log == "" {
		os.Exit(m.Run())
	}
	file, err := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(90)
	}
	_ = json.NewEncoder(file).Encode(os.Args[1:])
	file.Close()
	if len(os.Args) < 2 {
		os.Exit(91)
	}
	state := log + ".container"
	switch os.Args[1] {
	case "version":
		fmt.Println("28.0.0")
	case "run":
		container := docker.ContainerInfo{DockerID: "receipt-rpc-id", Status: "running", Labels: map[string]string{}, Image: "workspace:1"}
		for i := 2; i < len(os.Args); i++ {
			switch os.Args[i] {
			case "--name":
				i++
				container.Name = os.Args[i]
			case "--label":
				i++
				key, value, _ := strings.Cut(os.Args[i], "=")
				container.Labels[key] = value
			}
		}
		raw, _ := json.Marshal(container)
		if err := os.WriteFile(state, raw, 0600); err != nil {
			os.Exit(92)
		}
		fmt.Println(container.DockerID)
	case "inspect":
		raw, err := os.ReadFile(state)
		if err != nil {
			os.Exit(93)
		}
		var container docker.ContainerInfo
		_ = json.Unmarshal(raw, &container)
		raw, _ = json.Marshal([]any{map[string]any{"Id": container.DockerID, "Name": "/" + container.Name,
			"State": map[string]any{"Status": container.Status}, "Config": map[string]any{"Image": container.Image, "Labels": container.Labels}}})
		fmt.Println(string(raw))
	default:
		os.Exit(94)
	}
	os.Exit(0)
}

func createReceiptRPCCall(t *testing.T, h *Handler, method string, params any) Msg {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "create", Method: method, Params: raw}, func(msg Msg) { response = msg })
	return response
}

func TestDockerCreateReceiptRPCAndLegacyShape(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "docker.jsonl")
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_RECEIPT_RPC_LOG", log)
	h := New("computer", t.TempDir())
	request := map[string]any{"name": "stable-workspace", "image": "workspace:1", "env": map[string]string{"TOKEN": "secret"},
		"labels":    map[string]string{"zakura.tenant": "tenant", "zakura.space": "space", "zakura.computer": "computer", "zakura.purpose": "workspace"},
		"operation": map[string]string{"id": "op", "tenantId": "tenant", "spaceId": "space", "computerId": "computer"}}
	for i := 0; i < 2; i++ {
		response := createReceiptRPCCall(t, h, "docker.create", request)
		var flat map[string]any
		if err := json.Unmarshal(response.Result, &flat); err != nil || response.Error != "" || flat["dockerId"] != "receipt-rpc-id" || flat["container"] != nil {
			t.Fatalf("not flat legacy response: %+v %v", response, err)
		}
		h = New("computer", h.StorageRoot)
	}
	statusParams := map[string]string{"operationId": "op", "tenantId": "tenant", "spaceId": "space", "computerId": "computer"}
	response := createReceiptRPCCall(t, h, "docker.create.status", statusParams)
	var status docker.CreateStatus
	if err := json.Unmarshal(response.Result, &status); err != nil || response.Error != "" || status.State != "committed" || len(status.ConfigDigest) != 64 || status.Name != "stable-workspace" || status.Container == nil {
		t.Fatalf("status wrapper: %+v %v", response, err)
	}
	statusParams["name"] = "wrong-name"
	if response := createReceiptRPCCall(t, h, "docker.create.status", statusParams); response.Error == "" {
		t.Fatal("changed name accepted")
	}
	delete(statusParams, "name")
	statusParams["operationId"] = "missing-op"
	response = createReceiptRPCCall(t, h, "docker.create.status", statusParams)
	if err := json.Unmarshal(response.Result, &status); err != nil || response.Error != "" || status.State != "unknown" {
		t.Fatalf("missing receipt: %+v %v", response, err)
	}
	request["image"] = "workspace:2"
	if response := createReceiptRPCCall(t, h, "docker.create", request); response.Error == "" {
		t.Fatal("changed spec accepted")
	}
	// Calls without operation still invoke the old create path on every request.
	legacy := map[string]any{"name": "legacy-workspace", "image": "workspace:1"}
	for i := 0; i < 2; i++ {
		response := createReceiptRPCCall(t, h, "docker.create", legacy)
		if response.Error != "" || !strings.Contains(string(response.Result), `"dockerId":"receipt-rpc-id"`) {
			t.Fatalf("legacy create: %+v", response)
		}
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	runs := 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		switch args[0] {
		case "run":
			runs++
		case "inspect", "version":
		default:
			t.Fatalf("unexpected Docker mutation: %v", args)
		}
	}
	if runs != 3 {
		t.Fatalf("receipt replay changed effects: got %d want 1 receipt + 2 legacy", runs)
	}
}

func TestDockerCreateReceiptRPCStrictValidation(t *testing.T) {
	h := New("computer", t.TempDir())
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "must-not-run"))
	for _, method := range []string{"docker.create", "docker.create.status"} {
		for _, raw := range []string{`{"unknown":true}`, `{} {}`, `[]`, `"object"`, `{"operation":{"unknown":true}}`} {
			var response Msg
			h.Dispatch(context.Background(), Msg{ID: "bad", Method: method, Params: json.RawMessage(raw)}, func(msg Msg) { response = msg })
			if response.Error == "" || strings.Contains(response.Error, "本机未检测") {
				t.Fatalf("bad request reached Docker: %s %s %+v", method, raw, response)
			}
		}
	}
}

func TestDockerCreateReceiptsCapability(t *testing.T) {
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "missing-docker"))
	response := createReceiptRPCCall(t, New("computer", t.TempDir()), "sys.info", map[string]any{})
	var info struct {
		Capabilities map[string]bool `json:"capabilities"`
	}
	if err := json.Unmarshal(response.Result, &info); err != nil || response.Error != "" || !info.Capabilities["dockerCreateReceipts"] || info.Capabilities["docker"] {
		t.Fatalf("capability unavailable without Docker: %+v %v", response, err)
	}
}
