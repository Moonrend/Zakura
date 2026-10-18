package sys

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestFilesystemNoFollowStatCapability(t *testing.T) {
	root := t.TempDir()
	// Capability advertisement must not depend on a functioning Docker daemon.
	t.Setenv("ZAKURA_DOCKER", filepath.Join(root, "missing-docker"))
	info := Collect("computer", root)
	for _, name := range []string{"host", "privateAtomicFS", "boundedExecOutput", "filesystemNoFollowStat"} {
		if info.Capabilities[name] != true {
			t.Fatalf("capability %q=%v", name, info.Capabilities[name])
		}
	}
	if info.Capabilities["docker"] != false {
		t.Fatalf("unexpected Docker capability: %+v", info.Capabilities)
	}
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Capabilities map[string]bool `json:"capabilities"`
	}
	if err := json.Unmarshal(data, &wire); err != nil || !wire.Capabilities["filesystemNoFollowStat"] {
		t.Fatalf("wire capability missing: %s err=%v", data, err)
	}
}
