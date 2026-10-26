package computers

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
)

func sshTestSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func sshTestPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// startSSHTestServer completes the handshake for any client public key and then
// rejects every channel: the dial layer under test never opens one.
func startSSHTestServer(t *testing.T, signer ssh.Signer) (host, port string, auths *int32) {
	t.Helper()
	counter := new(int32)
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			atomic.AddInt32(counter, 1)
			return &ssh.Permissions{}, nil
		},
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				server, chans, reqs, err := ssh.NewServerConn(conn, cfg)
				if err != nil {
					_ = conn.Close()
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					_ = ch.Reject(ssh.UnknownChannelType, "unsupported")
				}
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", strconv.Itoa(addr.Port), counter
}

func TestSSHDialHandshake(t *testing.T) {
	signer := sshTestSigner(t)
	host, port, auths := startSSHTestServer(t, signer)
	client, err := DialSSH(context.Background(), SSHDialConfig{
		Host: host, Port: port, User: "railway",
		PrivateKey:         sshTestPrivateKeyPEM(t),
		HostKeyFingerprint: SSHFingerprint(signer.PublicKey()),
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	if atomic.LoadInt32(auths) != 1 {
		t.Fatalf("public key auth did not succeed: %d", atomic.LoadInt32(auths))
	}
}

func TestSSHDialFingerprintMismatch(t *testing.T) {
	signer := sshTestSigner(t)
	other := sshTestSigner(t)
	host, port, _ := startSSHTestServer(t, signer)
	_, err := DialSSH(context.Background(), SSHDialConfig{
		Host: host, Port: port, User: "railway",
		PrivateKey:         sshTestPrivateKeyPEM(t),
		HostKeyFingerprint: SSHFingerprint(other.PublicKey()),
	})
	if err == nil || !strings.Contains(err.Error(), "host key fingerprint mismatch") {
		t.Fatalf("expected fingerprint mismatch, got %v", err)
	}
}

func TestSSHDialBadPrivateKey(t *testing.T) {
	signer := sshTestSigner(t)
	host, port, _ := startSSHTestServer(t, signer)
	_, err := DialSSH(context.Background(), SSHDialConfig{
		Host: host, Port: port, User: "railway",
		PrivateKey:         "secret-not-a-key",
		HostKeyFingerprint: SSHFingerprint(signer.PublicKey()),
	})
	if err == nil || strings.Contains(err.Error(), "secret-not-a-key") {
		t.Fatalf("bad private key error: %v", err)
	}
}

func TestSSHFingerprintFormat(t *testing.T) {
	signer := sshTestSigner(t)
	got := SSHFingerprint(signer.PublicKey())
	if want := ssh.FingerprintSHA256(signer.PublicKey()); got != want {
		t.Fatalf("fingerprint = %q want %q", got, want)
	}
	if !strings.HasPrefix(got, "SHA256:") {
		t.Fatalf("fingerprint missing prefix: %q", got)
	}
	body := strings.TrimPrefix(got, "SHA256:")
	if len(body) != 43 || strings.ContainsRune(body, '=') {
		t.Fatalf("fingerprint body = %q", body)
	}
}
