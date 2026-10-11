package computers

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHDialConfig carries everything DialSSH needs for a single host-key-pinned
// connection. PrivateKey and HostKeyFingerprint are secrets: never log them, and
// never surface them in an error.
type SSHDialConfig struct {
	Host               string
	Port               string
	User               string
	PrivateKey         string
	HostKeyFingerprint string
}

// SSHFingerprint renders an OpenSSH SHA256 host key fingerprint, "SHA256:"
// followed by the unpadded standard-base64 SHA-256 digest of the wire key.
func SSHFingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// DialSSH opens an SSH client that trusts only the configured host key. The
// fingerprint is verified against the key offered during the handshake; a
// mismatch aborts before authentication. User, port and the fixed verification
// strategy are chosen by the caller (the provider owns its own defaults).
func DialSSH(ctx context.Context, cfg SSHDialConfig) (*ssh.Client, error) {
	signer, err := ssh.ParsePrivateKey([]byte(cfg.PrivateKey))
	if err != nil {
		// Encrypted or malformed keys both fail here; the message never echoes input.
		return nil, errors.New("ssh private key could not be parsed")
	}
	want := strings.TrimSpace(cfg.HostKeyFingerprint)
	hostKeyCallback := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if SSHFingerprint(key) != want {
			return errors.New("host key fingerprint mismatch")
		}
		return nil
	}
	config := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: hostKeyCallback,
		Timeout:         15 * time.Second,
	}
	address := net.JoinHostPort(cfg.Host, cfg.Port)
	dialer := net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("ssh connection failed")
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return ssh.NewClient(sshConn, chans, reqs), nil
}
