package rpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/host"
)

func statMetadataCall(t *testing.T, h *Handler, params any) Msg {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response Msg
	h.Dispatch(context.Background(), Msg{ID: "stat", Method: "host.fs.stat", Params: raw}, func(m Msg) { response = m })
	return response
}

func TestFilesystemStatNoFollowOptionsAndMode(t *testing.T) {
	h := New("computer", t.TempDir())
	root := host.SpaceWorkspace(h.StorageRoot, "space")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "file"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		present bool
		value   any
		valid   bool
	}{
		{"omitted", false, nil, true},
		{"false", true, false, true},
		{"true", true, true, true},
		{"null", true, nil, false},
		{"string", true, "true", false},
		{"number", true, 1, false},
		{"object", true, map[string]any{}, false},
		{"array", true, []any{true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			params := map[string]any{"spaceId": "space", "path": "/workspace/file"}
			if tc.present {
				params["noFollow"] = tc.value
			}
			response := statMetadataCall(t, h, params)
			if response.OK == nil || *response.OK != tc.valid {
				t.Fatalf("response=%+v", response)
			}
			if !tc.valid {
				if !strings.Contains(response.Error, "noFollow") {
					t.Fatalf("wrong error: %s", response.Error)
				}
				return
			}
			var entry host.Entry
			if err := json.Unmarshal(response.Result, &entry); err != nil || entry.Mode != info.Mode().String() || entry.Path != "/file" || entry.Size != 4 {
				t.Fatalf("response=%s err=%v", response.Result, err)
			}
		})
	}
	// The explicit root alias continues to select the same bounded filesystem.
	response := statMetadataCall(t, h, map[string]any{"root": root, "path": "file", "noFollow": true})
	if response.Error != "" {
		t.Fatal(response.Error)
	}
	for _, raw := range []string{`{"path":"file","noFollow":`, `[]`, `"true"`} {
		var response Msg
		h.Dispatch(context.Background(), Msg{ID: "stat", Method: "host.fs.stat", Params: json.RawMessage(raw)}, func(m Msg) { response = m })
		if response.OK == nil || *response.OK || response.Error == "" {
			t.Fatalf("malformed request accepted: %s %+v", raw, response)
		}
	}
}

func TestFilesystemStatNoFollowRPCLinksAndBoundary(t *testing.T) {
	h := New("computer", t.TempDir())
	root := host.SpaceWorkspace(h.StorageRoot, "space")
	outside := t.TempDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{root, outside} {
		if err := os.WriteFile(filepath.Join(dir, "file"), []byte("data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{"inside": "file", "outside": filepath.Join(outside, "file"), "dangling": "missing", "escape": outside} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("symlinks unavailable: %v", err)
			}
			t.Fatal(err)
		}
	}
	for _, path := range []string{"inside", "outside", "dangling", "escape"} {
		response := statMetadataCall(t, h, map[string]any{"spaceId": "space", "path": path, "noFollow": true})
		var entry host.Entry
		if err := json.Unmarshal(response.Result, &entry); response.Error != "" || err != nil || !strings.Contains(entry.Mode, "L") || entry.IsDir {
			t.Fatalf("link=%s response=%+v entry=%+v err=%v", path, response, entry, err)
		}
	}
	for _, option := range []any{nil, false} {
		params := map[string]any{"spaceId": "space", "path": "inside"}
		if option != nil {
			params["noFollow"] = option
		}
		response := statMetadataCall(t, h, params)
		var entry host.Entry
		if err := json.Unmarshal(response.Result, &entry); response.Error != "" || err != nil || !strings.HasPrefix(entry.Mode, "-") {
			t.Fatalf("default stat no longer follows in-root link: %+v entry=%+v err=%v", response, entry, err)
		}
	}
	for _, tc := range []struct {
		path     string
		noFollow bool
	}{
		{"outside", false}, {"dangling", false},
		{"escape/file", false}, {"escape/file", true}, {"escape/missing", true},
	} {
		response := statMetadataCall(t, h, map[string]any{"spaceId": "space", "path": tc.path, "noFollow": tc.noFollow})
		if response.OK == nil || *response.OK || response.Error == "" || strings.Contains(response.Error, h.StorageRoot) || strings.Contains(response.Error, outside) {
			t.Fatalf("unsafe metadata result for %+v: %+v", tc, response)
		}
	}
}
