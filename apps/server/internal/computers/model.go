// Package computers defines execution identities independently of Space identity.
// Provider implementations must never resolve an unavailable target to another host.
package computers

import (
	"errors"
	"fmt"
	"time"
)

type Provider string

const (
	Server      Provider = "server"
	RemoteAgent Provider = "remote_agent"
	SSH         Provider = "ssh"
	Temporary   Provider = "temporary"
	E2B         Provider = "e2b"
	Railway     Provider = "railway"
)

type Capability string

const (
	Commands           Capability = "commands"
	Files              Capability = "files"
	PTY                Capability = "pty"
	Browser            Capability = "browser"
	Desktop            Capability = "desktop"
	Docker             Capability = "docker"
	RestrictedCommands Capability = "restricted_commands"
)

type Computer struct {
	ID                 string       `json:"id"`
	TenantID           string       `json:"-"`
	SpaceID            string       `json:"spaceId"`
	Name               string       `json:"name"`
	Provider           Provider     `json:"provider"`
	RuntimeNodeID      string       `json:"runtimeNodeId,omitempty"`
	SecretRef          string       `json:"-"`
	Capabilities       []Capability `json:"capabilities"`
	IdleSeconds        int          `json:"idleSeconds"`
	MaxLifetimeSeconds int          `json:"maxLifetimeSeconds"`
}

func (c Computer) Has(cap Capability) bool {
	for _, v := range c.Capabilities {
		if v == cap {
			return true
		}
	}
	return false
}
func (c Computer) SupportsACP() bool {
	return c.Provider == Server && c.RuntimeNodeID != "" && c.Has(Docker)
}
func (c Computer) SessionScoped() bool { return c.Provider == Temporary || c.Provider == E2B }
func (c Computer) Scope(sessionID string) (string, error) {
	if !c.SessionScoped() {
		return "", nil
	}
	if sessionID == "" {
		return "", errors.New("temporary computer requires a session")
	}
	return sessionID, nil
}
func (c Computer) Validate() error {
	if c.ID == "" || c.TenantID == "" || c.SpaceID == "" || c.Name == "" {
		return errors.New("computer identity is incomplete")
	}
	switch c.Provider {
	case Server, RemoteAgent:
		if c.RuntimeNodeID == "" {
			return errors.New("agent computer requires a runtime node")
		}
	case Temporary, E2B, SSH, Railway:
	default:
		return errors.New("unsupported computer provider")
	}
	if c.IdleSeconds <= 0 || c.MaxLifetimeSeconds < c.IdleSeconds {
		return errors.New("invalid computer lifetime policy")
	}
	return nil
}

type State string

const (
	PendingApproval State = "pending_approval"
	Creating        State = "creating"
	Ready           State = "ready"
	Disconnected    State = "disconnected"
	Stopping        State = "stopping"
	Expired         State = "expired"
	Destroyed       State = "destroyed"
	Failed          State = "failed"
	Unknown         State = "unknown"
)

// Unknown retains the active slot: an ambiguous create/delete response is NOT
// permission to retry provisioning. Reconcile using CreateOperationID first.
func CanTransition(from, to State) bool {
	switch from {
	case PendingApproval:
		return to == Creating || to == Failed
	case Creating:
		return to == Ready || to == Failed || to == Unknown
	case Ready:
		return to == Disconnected || to == Stopping || to == Expired || to == Unknown
	case Disconnected:
		return to == Ready || to == Stopping || to == Expired || to == Unknown
	case Stopping:
		return to == Destroyed || to == Expired || to == Unknown
	case Unknown:
		return to == Ready || to == Disconnected || to == Stopping || to == Destroyed || to == Expired || to == Failed
	default:
		return false
	}
}

type Runtime struct {
	ID                string
	ComputerID        string
	TenantID          string
	SpaceID           string
	SessionScope      string
	Incarnation       string
	CreateOperationID string
	ExternalID        string
	State             State
	ExpiresAt         time.Time
	IdleDeadline      time.Time
}

type Target struct {
	TenantID    string `json:"-"`
	SpaceID     string `json:"spaceId"`
	ComputerID  string `json:"computerId"`
	RuntimeID   string `json:"runtimeId"`
	Incarnation string `json:"incarnation"`
}

// CheckIdentity validates a pinned target even after disconnection or expiration.
// Follow-up job reads/cancellation must use the persisted target, never a new default.
// This is not execution authorization: callers must also check membership and job ownership.
func CheckIdentity(t Target, c Computer, r Runtime, sessionID string) error {
	if t.TenantID == "" || t.SpaceID == "" || t.ComputerID == "" || t.RuntimeID == "" || t.Incarnation == "" {
		return errors.New("execution target is incomplete")
	}
	if t.TenantID != c.TenantID || t.SpaceID != c.SpaceID || t.ComputerID != c.ID ||
		t.TenantID != r.TenantID || t.SpaceID != r.SpaceID || t.ComputerID != r.ComputerID || t.RuntimeID != r.ID || t.Incarnation != r.Incarnation {
		return errors.New("execution target mismatch")
	}
	scope, err := c.Scope(sessionID)
	if err != nil {
		return err
	}
	if scope != r.SessionScope {
		return errors.New("runtime belongs to a different session")
	}
	return nil
}

// CheckTarget additionally gates new execution, including files and PTY access.
func CheckTarget(t Target, c Computer, r Runtime, sessionID string, cap Capability, restricted bool, now time.Time) error {
	if err := CheckIdentity(t, c, r, sessionID); err != nil {
		return err
	}
	if r.State != Ready {
		return fmt.Errorf("computer runtime is %s", r.State)
	}
	if c.SessionScoped() && (r.ExpiresAt.IsZero() || r.IdleDeadline.IsZero() || r.IdleDeadline.After(r.ExpiresAt)) {
		return errors.New("temporary runtime has invalid lifetime")
	}
	if (!r.ExpiresAt.IsZero() && !now.Before(r.ExpiresAt)) || (!r.IdleDeadline.IsZero() && !now.Before(r.IdleDeadline)) {
		return errors.New("computer runtime expired")
	}
	if !c.Has(cap) {
		return fmt.Errorf("computer does not support %s", cap)
	}
	if restricted && (cap != Commands || !c.Has(RestrictedCommands) || (c.Provider != Server && c.Provider != RemoteAgent)) {
		return errors.New("computer cannot enforce restricted execution")
	}
	return nil
}
