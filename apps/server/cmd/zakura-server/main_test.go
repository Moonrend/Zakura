package main

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServerRejectsOccupiedPortBeforeDatabaseInitialization(t *testing.T) {
	if os.Getenv("ZAKURA_TEST_OCCUPIED_PORT") == "1" {
		main()
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	dbPath := filepath.Join(t.TempDir(), "must-not-create.db")
	t.Setenv("ZAKURA_TEST_OCCUPIED_PORT", "1")
	t.Setenv("LISTEN_ADDR", listener.Addr().String())
	t.Setenv("DATABASE_URL", "file:"+filepath.ToSlash(dbPath))
	t.Setenv("ZAKURA_SECRET", strings.Repeat("local-test-only-", 3))
	t.Setenv("PUBLIC_BASE_URL", "http://127.0.0.1:8787")
	t.Setenv("WEB_PUBLIC_URL", "http://127.0.0.1:3001")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestServerRejectsOccupiedPortBeforeDatabaseInitialization$")
	out, err := cmd.CombinedOutput()
	if err == nil || ctx.Err() != nil {
		t.Fatalf("occupied port did not fail promptly: %s %v", out, err)
	}
	if !strings.Contains(string(out), "server listen failed") || strings.Contains(string(out), "server listening") {
		t.Fatalf("misleading startup log: %s", out)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("occupied-port startup initialized database: %v", err)
	}
}
