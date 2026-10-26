package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// sshComputerProvider is the control-plane adapter for a user-supplied SSH host.
// The host already exists: its identity is the key pair plus the pinned host key,
// there is no provisioning API, and the operator owns the machine, so this adapter
// implements only CreationProvider. Creation verifies the host is reachable with
// the stored credentials; the ExternalID pins the runtime to host:port. A runtime
// whose credentials still work always reconnects to the same box.
type sshComputerProvider struct {
	h *handler
}

var _ computers.CreationProvider = sshComputerProvider{}

const sshDefaultPort = "22"

// sshCredentials is a computer's decrypted SSH configuration. PrivateKey and
// HostKeyFingerprint are secrets: never log them and never echo them in an error.
type sshCredentials struct {
	Host               string `json:"host"`
	User               string `json:"user"`
	Port               string `json:"port"`
	PrivateKey         string `json:"privateKey"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

func (c sshCredentials) dialPort() string {
	if strings.TrimSpace(c.Port) != "" {
		return c.Port
	}
	return sshDefaultPort
}

func (c sshCredentials) externalID() string {
	return "ssh:" + c.Host + ":" + c.dialPort()
}

func (c sshCredentials) dialConfig() computers.SSHDialConfig {
	return computers.SSHDialConfig{Host: c.Host, Port: c.dialPort(), User: c.User, PrivateKey: c.PrivateKey, HostKeyFingerprint: c.HostKeyFingerprint}
}

func (p sshComputerProvider) pinnedRuntime(ctx context.Context, r computers.Runtime) (computers.Runtime, error) {
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	return p.h.computerStore().GetRuntime(ctx, target)
}

// configuration decrypts the computer's own SSH envelope. Secrets never reach a
// log, error or response surface: every failure returns a generic message.
func (p sshComputerProvider) configuration(ctx context.Context, r computers.Runtime) (sshCredentials, error) {
	var envelope string
	err := p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT COALESCE(secret_ref,'') FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&envelope)
	if err != nil {
		return sshCredentials{}, err
	}
	if strings.TrimSpace(envelope) == "" {
		return sshCredentials{}, errors.New("computer has no SSH configuration")
	}
	plain, err := computers.OpenCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope)
	if err != nil {
		return sshCredentials{}, errors.New("computer SSH configuration could not be opened")
	}
	var creds sshCredentials
	if err := json.Unmarshal(plain, &creds); err != nil {
		return sshCredentials{}, errors.New("computer SSH configuration is invalid")
	}
	if strings.TrimSpace(creds.Host) == "" || strings.TrimSpace(creds.User) == "" || strings.TrimSpace(creds.PrivateKey) == "" || strings.TrimSpace(creds.HostKeyFingerprint) == "" {
		return sshCredentials{}, errors.New("computer SSH configuration is incomplete")
	}
	return creds, nil
}

// authorize enforces the Provisioner contract before connecting: the runtime must
// still be the pinned, unbound record this call was dispatched for and its
// creation must be durably approved. SSH is not session-scoped, so SessionScope is
// empty for both Create and Find and is not compared.
func (p sshComputerProvider) authorize(ctx context.Context, r computers.Runtime, create bool) (sshCredentials, error) {
	actual, err := p.pinnedRuntime(ctx, r)
	if err != nil {
		return sshCredentials{}, err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.ExternalID != "" ||
		(actual.State != computers.Creating && (create || actual.State != computers.Unknown)) {
		return sshCredentials{}, computers.ErrTransitionConflict
	}
	var approved int
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT 1 FROM computer_creation_approvals WHERE runtime_id=? AND create_operation_id=?`), r.ID, r.CreateOperationID).Scan(&approved)
	if errors.Is(err, sql.ErrNoRows) {
		return sshCredentials{}, computers.ErrTransitionConflict
	}
	if err != nil {
		return sshCredentials{}, err
	}
	return p.configuration(ctx, r)
}

// Create verifies the host is reachable with the stored key and pinned host key,
// then pins the runtime to the host:port identity. It provisions nothing: the box
// already exists, and the connection is closed immediately after the handshake.
func (p sshComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	creds, err := p.authorize(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	client, err := computers.DialSSH(ctx, creds.dialConfig())
	if err != nil {
		return computers.CreationResult{}, err
	}
	_ = client.Close()
	return computers.CreationResult{ExternalID: creds.externalID()}, nil
}

// Find reconnects and returns the same identity. The credentials are immutable, so
// a reachable host always yields the pinned ExternalID and reconciliation is
// idempotent. A persisted ExternalID naming a different host is a hard error,
// never a silent replacement.
func (p sshComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	creds, err := p.authorize(ctx, r, false)
	if err != nil {
		return computers.CreationResult{}, err
	}
	client, err := computers.DialSSH(ctx, creds.dialConfig())
	if err != nil {
		return computers.CreationResult{}, err
	}
	_ = client.Close()
	id := creds.externalID()
	if r.ExternalID != "" && r.ExternalID != id {
		return computers.CreationResult{}, errors.New("reconnected to a different ssh host")
	}
	return computers.CreationResult{ExternalID: id}, nil
}
