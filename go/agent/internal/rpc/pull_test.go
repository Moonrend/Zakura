package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"zakura.dev/agent/internal/docker"
)

func TestDockerPullProgressFrames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	bin := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo 28; exit 0; fi\nprintf '0123456789ab: Downloading [==> ] 1MB/4MB\\n0123456789ab: Pull complete\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	handler := New("server", t.TempDir())
	for _, streaming := range []bool{true, false} {
		params := map[string]string{"image": "test:1"}
		if streaming {
			params["progressStream"] = "pull-123"
		}
		raw, _ := json.Marshal(params)
		var frames []Msg
		handler.Dispatch(context.Background(), Msg{Type: "req", ID: "request-1", Method: "docker.pull", Params: raw}, func(msg Msg) {
			frames = append(frames, msg)
		})
		last := frames[len(frames)-1]
		if last.Type != "res" || last.ID != "request-1" || last.OK == nil || !*last.OK {
			t.Fatalf("final response: %+v", last)
		}
		if !streaming {
			if len(frames) != 1 {
				t.Fatalf("legacy caller received progress: %+v", frames)
			}
			continue
		}
		if len(frames) != 3 || frames[0].Type != "stream" || frames[0].Stream != "pull-123" || frames[0].Chan != "progress" {
			t.Fatalf("progress frames: %+v", frames)
		}
		data, err := base64.StdEncoding.DecodeString(frames[0].Data)
		if err != nil {
			t.Fatal(err)
		}
		var event docker.PullEvent
		if err := json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		if event.Status != "Downloading" || event.ProgressDetail == nil || event.ProgressDetail.Total != 4000000 {
			t.Fatalf("decoded progress: %+v", event)
		}
	}
}
