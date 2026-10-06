package docker

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPullOutputParsesChunkedTerminalProgress(t *testing.T) {
	var events []PullEvent
	out := &pullOutput{onProgress: func(event PullEvent) { events = append(events, event) }}
	for _, chunk := range []string{
		"\x1b[2K\r0123456789ab: Pulling fs layer\r\n\x1b[1A\x1b[2K0123456789ab: Down",
		"loading [====>    ] 1.25MB/5MB\r\n0123456789ab: Extracting 2MiB/8MiB\r",
		"0123456789ab: Pull complete\nStatus: Downloaded newer image for test:1\n",
	} {
		_, _ = out.Write([]byte(chunk))
	}
	if len(events) != 5 {
		t.Fatalf("events: %+v", events)
	}
	if got := events[1]; got.ID != "0123456789ab" || got.Status != "Downloading" || got.ProgressDetail == nil || got.ProgressDetail.Current != 1250000 || got.ProgressDetail.Total != 5000000 {
		t.Fatalf("download: %+v", got)
	}
	if got := events[2]; got.Status != "Extracting" || got.ProgressDetail.Current != 2*1024*1024 {
		t.Fatalf("extract: %+v", got)
	}
	if events[3].Status != "Pull complete" || events[4].ID != "" {
		t.Fatalf("completion: %+v", events[3:])
	}
}

func TestPullStreamsBeforeExitAndPreservesErrors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell and terminal")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "docker")
	release := filepath.Join(dir, "release")
	script := `#!/bin/sh
if [ "$1" = version ]; then echo 28.0.0; exit 0; fi
if [ "$2" = denied ]; then echo 'pull access denied' >&2; exit 1; fi
if ! [ -t 1 ]; then echo 'expected a terminal' >&2; exit 2; fi
printf '\033[2K\r0123456789ab: Downloading [==> ] 1MB/4MB\r\n' >&2
while [ ! -f "$ZAKURA_TEST_PULL_RELEASE" ]; do sleep 0.01; done
printf '0123456789ab: Download complete\n0123456789ab: Pull complete\n'
`
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	t.Setenv("ZAKURA_TEST_PULL_RELEASE", release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := make(chan PullEvent, 8)
	done := make(chan error, 1)
	go func() { done <- PullWithProgress(ctx, "test:1", func(event PullEvent) { events <- event }) }()
	select {
	case event := <-events:
		if event.ProgressDetail == nil || event.ProgressDetail.Current != 1000000 || event.ProgressDetail.Total != 4000000 {
			t.Fatalf("first progress: %+v", event)
		}
	case err := <-done:
		t.Fatalf("pull finished before any progress: %v", err)
	case <-ctx.Done():
		t.Fatal("no streaming progress")
	}
	select {
	case err := <-done:
		t.Fatalf("pull must still be running: %v", err)
	default:
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := PullWithProgress(ctx, "denied", func(PullEvent) {}); err == nil || !strings.Contains(err.Error(), "pull access denied") {
		t.Fatalf("lost Docker error: %v", err)
	}
	// Legacy callers still use the same CLI and receive its failure.
	if err := Pull(ctx, "denied"); err == nil || !strings.Contains(err.Error(), "pull access denied") {
		t.Fatalf("legacy error: %v", err)
	}
}
