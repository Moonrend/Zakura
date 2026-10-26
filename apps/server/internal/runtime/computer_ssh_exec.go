package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"golang.org/x/crypto/ssh"
)

const (
	sshExecDefaultMS   = 30_000
	sshExecMaxMS       = 300_000
	sshExecOutputLimit = 64 * 1024
)

// railwayExecHost and railwayExecPort redirect the railway SSH channel at an
// in-process server in tests. Empty in production, where the railway provider
// defaults (host/port/user) apply because a railway computer's configuration
// carries only the private key and pinned host key.
var (
	railwayExecHost string
	railwayExecPort string
)

// sshExecDialConfig reads and decrypts the computer's SSH configuration. SSH
// computers carry host/user/privateKey/fingerprint with an optional port; railway
// computers carry only privateKey/fingerprint and dial the provider constants.
func (h *handler) sshExecDialConfig(ctx context.Context, exec *resolvedExecution) (computers.SSHDialConfig, error) {
	c := exec.computer
	var envelope string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(secret_ref,'') FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), c.TenantID, c.SpaceID, c.ID).Scan(&envelope)
	if err != nil || strings.TrimSpace(envelope) == "" {
		return computers.SSHDialConfig{}, errors.New("computer has no SSH configuration")
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, c.TenantID, c.SpaceID, c.ID, envelope)
	if err != nil {
		return computers.SSHDialConfig{}, errors.New("computer SSH configuration could not be opened")
	}
	switch c.Provider {
	case computers.SSH:
		var creds sshCredentials
		if err := json.Unmarshal(plain, &creds); err != nil {
			return computers.SSHDialConfig{}, errors.New("computer SSH configuration is invalid")
		}
		if strings.TrimSpace(creds.Host) == "" || strings.TrimSpace(creds.User) == "" || strings.TrimSpace(creds.PrivateKey) == "" || strings.TrimSpace(creds.HostKeyFingerprint) == "" {
			return computers.SSHDialConfig{}, errors.New("computer SSH configuration is incomplete")
		}
		return creds.dialConfig(), nil
	case computers.Railway:
		var creds railwayCredentials
		if err := json.Unmarshal(plain, &creds); err != nil {
			return computers.SSHDialConfig{}, errors.New("computer Railway configuration is invalid")
		}
		if strings.TrimSpace(creds.PrivateKey) == "" || strings.TrimSpace(creds.HostKeyFingerprint) == "" {
			return computers.SSHDialConfig{}, errors.New("computer Railway configuration is incomplete")
		}
		host, port := defaultRailwayHost, defaultRailwayPort
		if strings.TrimSpace(railwayExecHost) != "" {
			host = railwayExecHost
		}
		if strings.TrimSpace(railwayExecPort) != "" {
			port = railwayExecPort
		}
		return computers.SSHDialConfig{Host: host, Port: port, User: defaultRailwayUser, PrivateKey: creds.PrivateKey, HostKeyFingerprint: creds.HostKeyFingerprint}, nil
	}
	return computers.SSHDialConfig{}, errors.New("computer provider does not support ssh execution")
}

// computerSSHExec runs one command on a dedicated SSH host. It returns the same
// result shape as the container transport so the tool layer is provider-agnostic.
// SSH is honest about what it is: a real remote machine, not a sandbox, so it
// reports isolated=false and never claims a restricted policy was applied.
func (h *handler) computerSSHExec(ctx context.Context, exec *resolvedExecution, executionTimeoutMS int64, command string, args ...string) (map[string]any, error) {
	if exec == nil || strings.TrimSpace(exec.containerID) == "" {
		return nil, errors.New("computer runtime has no verified host")
	}
	if exec.computer.Provider != computers.SSH && exec.computer.Provider != computers.Railway {
		return nil, errors.New("computer provider does not support ssh execution")
	}
	dial, err := h.sshExecDialConfig(ctx, exec)
	if err != nil {
		return nil, err
	}
	timeoutMS := executionTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = sshExecDefaultMS
	}
	if timeoutMS > sshExecMaxMS {
		timeoutMS = sshExecMaxMS
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline).Milliseconds()
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if remaining < timeoutMS {
			timeoutMS = remaining
		}
	}
	client, err := computers.DialSSH(ctx, dial)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return nil, errors.New("ssh session could not be opened")
	}
	defer session.Close()
	stdout := &sshExecOutput{limit: sshExecOutputLimit}
	stderr := &sshExecOutput{limit: sshExecOutputLimit}
	session.Stdout = stdout
	session.Stderr = stderr

	// An SSH session has no context: the only way to bound it is to close the
	// client, which tears the channel down and unblocks Wait.
	var timedOut atomic.Bool
	timer := time.AfterFunc(time.Duration(timeoutMS)*time.Millisecond, func() {
		timedOut.Store(true)
		_ = client.Close()
	})
	defer timer.Stop()

	runErr := session.Run(sshRemoteCommand(command, args))
	if timedOut.Load() {
		return nil, context.DeadlineExceeded
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	exitCode := 0
	if runErr != nil {
		var exitErr *ssh.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitStatus()
		} else {
			return nil, errors.New("ssh command failed")
		}
	}
	result := map[string]any{
		"exitCode":                float64(exitCode),
		"stdout":                  stdout.String(),
		"stderr":                  stderr.String(),
		"executionMode":           "remote-ssh",
		"isolated":                false,
		"restrictedPolicyApplied": false,
	}
	if stdout.Truncated() || stderr.Truncated() {
		result["truncated"] = true
	}
	if exitCode != 0 {
		return result, fmt.Errorf("command exited %d: %v", exitCode, stderr.String())
	}
	return result, nil
}

// sshRemoteCommand renders the argv the transport received as a single remote
// shell command. The caller always passes a shell invocation ("bash"/"sh",
// "-lc", script); simple tokens stay bare and anything else is single-quoted, so
// "bash -lc <script>" round-trips as bash -lc '<script>'.
func sshRemoteCommand(command string, args []string) string {
	parts := append([]string{command}, args...)
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = sshShellQuote(part)
	}
	return strings.Join(quoted, " ")
}

func sshShellQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-./:=@%+,", r))
	}) == -1 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// sshExecOutput is a bounded, concurrency-safe io.Writer for one session stream.
// Excess bytes are discarded while Write still reports success, so the SSH copy
// loops never fail on truncation, and the fact of truncation is retained.
type sshExecOutput struct {
	mu        sync.Mutex
	data      []byte
	limit     int
	truncated bool
}

func (o *sshExecOutput) Write(p []byte) (int, error) {
	n := len(p)
	o.mu.Lock()
	defer o.mu.Unlock()
	if room := o.limit - len(o.data); room > 0 {
		if n > room {
			p = p[:room]
			o.truncated = true
		}
		o.data = append(o.data, p...)
	} else {
		o.truncated = true
	}
	return n, nil
}

func (o *sshExecOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return string(o.data)
}

func (o *sshExecOutput) Truncated() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.truncated
}
