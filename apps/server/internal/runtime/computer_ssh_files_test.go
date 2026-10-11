package runtime

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// serveFakeSSHFiles implements an SSH server whose session channels host the real
// pkg/sftp server, rooted at workDir, so the SFTP transport can be exercised
// end-to-end without a remote host.
func serveFakeSSHFiles(conn net.Conn, cfg *ssh.ServerConfig, workDir string) {
	server, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer server.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for req := range chReqs {
				if req.Type != "subsystem" {
					_ = req.Reply(false, nil)
					continue
				}
				var payload struct{ Name string }
				if err := ssh.Unmarshal(req.Payload, &payload); err != nil || payload.Name != "sftp" {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				svr, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(workDir))
				if err != nil {
					return
				}
				_ = svr.Serve()
				return
			}
		}()
	}
}

func startFakeSSHFiles(t *testing.T, signer ssh.Signer, workDir string) (host, port string, conns *int32) {
	t.Helper()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return &ssh.Permissions{}, nil
		},
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var count int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&count, 1)
			go serveFakeSSHFiles(conn, cfg, workDir)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", strconv.Itoa(addr.Port), &count
}

func sshFilesContext(env *sshExecEnv) context.Context {
	return context.WithValue(context.Background(), computerExecKey{}, env.exec)
}

func sshFilesEnable(t *testing.T, env *sshExecEnv) {
	t.Helper()
	env.exec.computer.Capabilities = []computers.Capability{computers.Commands, computers.Files}
}

func TestComputerSSHFilesPathMapping(t *testing.T) {
	cases := map[string]string{
		".":             ".",
		"/note.txt":     "note.txt",
		"sub/notes.txt": "sub/notes.txt",
		"/":             ".",
	}
	for target, want := range cases {
		got, err := sshFilesPath(target)
		if err != nil {
			t.Fatalf("sshFilesPath(%q): %v", target, err)
		}
		if got != want {
			t.Fatalf("sshFilesPath(%q) = %q, want %q", target, got, want)
		}
	}
	if _, err := sshFilesPath("../escape"); err == nil {
		t.Fatal("path escape was accepted")
	}
}

func TestComputerSSHFilesRoundTrip(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	workDir := t.TempDir()
	host, port, _ := startFakeSSHFiles(t, signer, workDir)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, fingerprint, host, port), "ssh:"+host+":"+port)
	sshFilesEnable(t, env)
	ctx := sshFilesContext(env)

	raw, err := env.h.runBuiltinTool(ctx, "tenant", "agent", "fs_write", json.RawMessage(`{"path":"/notes/hello.txt","content":"hello sftp"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeBuiltinResult(t, raw, nil)
	if out["written"] != true || out["path"] != "notes/hello.txt" {
		t.Fatalf("write result = %#v", out)
	}
	onDisk, err := os.ReadFile(filepath.Join(workDir, "notes", "hello.txt"))
	if err != nil || string(onDisk) != "hello sftp" {
		t.Fatalf("file on disk = %q err=%v", onDisk, err)
	}

	raw, err = env.h.runBuiltinTool(ctx, "tenant", "agent", "fs_list", json.RawMessage(`{"path":"/notes"}`))
	if err != nil {
		t.Fatal(err)
	}
	out = decodeBuiltinResult(t, raw, nil)
	if out["path"] != "notes" {
		t.Fatalf("list path = %v", out["path"])
	}
	entries, _ := out["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", out["entries"])
	}
	entry := entries[0].(map[string]any)
	if entry["name"] != "hello.txt" || entry["path"] != "notes/hello.txt" || entry["isDir"] != false {
		t.Fatalf("entry = %#v", entry)
	}

	raw, err = env.h.runBuiltinTool(ctx, "tenant", "agent", "fs_read", json.RawMessage(`{"path":"/notes/hello.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	out = decodeBuiltinResult(t, raw, nil)
	if out["content"] != "hello sftp" || out["size"] != float64(10) || out["path"] != "notes/hello.txt" {
		t.Fatalf("read result = %#v", out)
	}
}

func TestComputerSSHFilesRailwayUsesProviderDefaults(t *testing.T) {
	signer, key, fingerprint := sshTestHostIdentity(t)
	workDir := t.TempDir()
	host, port, _ := startFakeSSHFiles(t, signer, workDir)
	previousHost, previousPort := railwayExecHost, railwayExecPort
	railwayExecHost, railwayExecPort = host, port
	t.Cleanup(func() { railwayExecHost, railwayExecPort = previousHost, previousPort })

	credentials, err := json.Marshal(map[string]string{"privateKey": key, "hostKeyFingerprint": fingerprint})
	if err != nil {
		t.Fatal(err)
	}
	env := sshExecHarness(t, computers.Railway, string(credentials), "box-1")
	sshFilesEnable(t, env)
	ctx := sshFilesContext(env)

	if _, err := env.h.runBuiltinTool(ctx, "tenant", "agent", "fs_write", json.RawMessage(`{"path":"/railway.txt","content":"on railway"}`)); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(workDir, "railway.txt")); err != nil || string(data) != "on railway" {
		t.Fatalf("railway file = %q err=%v", data, err)
	}
}

func TestComputerSSHFilesFingerprintMismatch(t *testing.T) {
	signer, key, _ := sshTestHostIdentity(t)
	_, _, otherFingerprint := sshTestHostIdentity(t)
	workDir := t.TempDir()
	host, port, _ := startFakeSSHFiles(t, signer, workDir)
	env := sshExecHarness(t, computers.SSH, sshCredsJSON(t, key, otherFingerprint, host, port), "ssh:"+host+":"+port)
	sshFilesEnable(t, env)
	ctx := sshFilesContext(env)

	if _, err := env.h.runBuiltinTool(ctx, "tenant", "agent", "fs_write", json.RawMessage(`{"path":"/x.txt","content":"nope"}`)); err == nil {
		t.Fatal("expected a fingerprint mismatch error")
	}
	if _, err := os.Stat(filepath.Join(workDir, "x.txt")); !os.IsNotExist(err) {
		t.Fatalf("file was written despite the fingerprint mismatch: %v", err)
	}
}
