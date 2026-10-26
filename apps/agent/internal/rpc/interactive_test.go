package rpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Moonrend/Zakura/apps/agent/internal/host"
)

func TestSecureWriteOptionsAreExplicitAndValidated(t *testing.T) {
	h := New("computer", t.TempDir())
	for _, tc := range []struct {
		name, options string
		valid         bool
	}{
		{"legacy", "", true}, {"private", `,"mode":384,"atomic":true`, true},
		{"public", `,"mode":420,"atomic":true`, false}, {"partial", `,"mode":384`, false},
		{"atomic-only", `,"atomic":true`, false}, {"not-atomic", `,"mode":384,"atomic":false`, false},
		{"bad-type", `,"mode":"0600","atomic":true`, false},
		{"null-options", `,"mode":null,"atomic":null`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			params := json.RawMessage(`{"spaceId":"space","path":"` + tc.name + `","content":"secret"` + tc.options + `}`)
			var response Msg
			h.Dispatch(context.Background(), Msg{ID: "write", Method: "host.fs.write", Params: params}, func(m Msg) { response = m })
			if (response.Error == "") != tc.valid {
				t.Fatalf("response=%+v", response)
			}
			if !tc.valid {
				return
			}
			info, err := os.Stat(filepath.Join(host.SpaceWorkspace(h.StorageRoot, "space"), tc.name))
			if err != nil {
				t.Fatal(err)
			}
			want := os.FileMode(0o644)
			if tc.name == "private" {
				want = 0o600
			}
			if runtime.GOOS != "windows" && info.Mode().Perm() != want {
				t.Fatalf("mode=%o want=%o", info.Mode().Perm(), want)
			}
		})
	}
}
