package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// railwayComputerProvider is the control-plane adapter for railway.new free SSH
// VMs. railway.new is not a deploy target: there is no service/GraphQL API, the
// SSH private key is the identity, and reconnecting with the same key returns to
// the same box. Because the service exposes no destruction API, this adapter
// deliberately implements only CreationProvider and never pretends to remove a
// box. Railway reclaims the VM (and its files) when the 60min unclaimed or 24h
// claimed window lapses; the cleanup worker then expires the runtate in place.
//
// Protocol assumptions, all adjustable constants below, none of which the
// configuration carries:
//   - host: railway.new is fixed and never read from a computer's configuration.
//   - port: 22.
//   - user: railpack-style containers commonly run as "railway"; ssh railway.new
//     with no user falls back to the local username and the server likely ignores
//     it. We send "railway" and accept that this may need adjustment.
//
// Each connection parses the JSON manifest Railway prints (box identity, preview
// URL, claim link, deadline). The manifest is persisted on the runtime as
// manifest_json for display; only known-safe string fields are ever surfaced.
type railwayComputerProvider struct {
	h    *handler
	host string
	port string
	user string
}

var _ computers.CreationProvider = railwayComputerProvider{}

const (
	defaultRailwayHost  = "railway.new"
	defaultRailwayPort  = "22"
	defaultRailwayUser  = "railway"
	railwayProbeCommand = "true"
	railwayOutputLimit  = 64 * 1024
)

// railwayCredentials is the decrypted computer configuration. ValidateConfiguration
// already guaranteed both fields exist and are well-formed at card creation time.
type railwayCredentials struct {
	PrivateKey         string `json:"privateKey"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

func (p railwayComputerProvider) dialHost() string {
	if strings.TrimSpace(p.host) != "" {
		return p.host
	}
	return defaultRailwayHost
}

func (p railwayComputerProvider) dialPort() string {
	if strings.TrimSpace(p.port) != "" {
		return p.port
	}
	return defaultRailwayPort
}

func (p railwayComputerProvider) dialUser() string {
	if strings.TrimSpace(p.user) != "" {
		return p.user
	}
	return defaultRailwayUser
}

func (p railwayComputerProvider) pinnedRuntime(ctx context.Context, r computers.Runtime) (computers.Runtime, error) {
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	return p.h.computerStore().GetRuntime(ctx, target)
}

// configuration decrypts the computer's own Railway envelope. Secrets never reach
// a log, error or response surface: every failure returns a generic message.
func (p railwayComputerProvider) configuration(ctx context.Context, r computers.Runtime) (railwayCredentials, error) {
	var envelope string
	err := p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT COALESCE(secret_ref,'') FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&envelope)
	if err != nil {
		return railwayCredentials{}, err
	}
	if strings.TrimSpace(envelope) == "" {
		return railwayCredentials{}, errors.New("computer has no Railway configuration")
	}
	plain, err := computers.OpenCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope)
	if err != nil {
		return railwayCredentials{}, errors.New("computer Railway configuration could not be opened")
	}
	var creds railwayCredentials
	if err := json.Unmarshal(plain, &creds); err != nil {
		return railwayCredentials{}, errors.New("computer Railway configuration is invalid")
	}
	if strings.TrimSpace(creds.PrivateKey) == "" {
		return railwayCredentials{}, errors.New("computer Railway configuration is incomplete")
	}
	return creds, nil
}

// authorize enforces the Provisioner contract before connecting: the runtime must
// still be the pinned, unbound record this call was dispatched for and its
// creation must be durably approved. Railway is not session-scoped, so
// SessionScope is empty for both Create and Find and is not compared.
func (p railwayComputerProvider) authorize(ctx context.Context, r computers.Runtime, create bool) (railwayCredentials, error) {
	actual, err := p.pinnedRuntime(ctx, r)
	if err != nil {
		return railwayCredentials{}, err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.ExternalID != "" ||
		(actual.State != computers.Creating && (create || actual.State != computers.Unknown)) {
		return railwayCredentials{}, computers.ErrTransitionConflict
	}
	var approved int
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT 1 FROM computer_creation_approvals WHERE runtime_id=? AND create_operation_id=?`), r.ID, r.CreateOperationID).Scan(&approved)
	if errors.Is(err, sql.ErrNoRows) {
		return railwayCredentials{}, computers.ErrTransitionConflict
	}
	if err != nil {
		return railwayCredentials{}, err
	}
	return p.configuration(ctx, r)
}

// observe dials the box, runs a harmless probe and parses the manifest Railway
// prints. Railway carries no pre-known host key, so the first connection uses
// trust-on-first-use and returns the observed fingerprint for the caller to pin.
// The connection is always closed; SSH output can be arbitrarily large, so only
// the first 64KB are retained.
func (p railwayComputerProvider) observe(ctx context.Context, creds railwayCredentials) (map[string]any, string, error) {
	client, fingerprint, err := computers.DialSSHFirstUse(ctx, computers.SSHDialConfig{
		Host: p.dialHost(), Port: p.dialPort(), User: p.dialUser(),
		PrivateKey: creds.PrivateKey, HostKeyFingerprint: creds.HostKeyFingerprint,
	})
	if err != nil {
		return nil, "", err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return nil, "", errors.New("railway ssh session could not be opened")
	}
	defer session.Close()
	out := &railwayOutput{limit: railwayOutputLimit}
	session.Stdout = out
	session.Stderr = out
	_ = session.Run(railwayProbeCommand)
	manifest, ok := parseRailwayManifest(out.String())
	if !ok {
		return nil, "", errors.New("railway connection did not return a manifest; reconciliation is required")
	}
	return manifest, fingerprint, nil
}

// pinFirstUseFingerprint persists the host key learned by a trust-on-first-use
// dial so later connections pin it. It runs detached from client cancellation,
// mirroring the provisioner's post-create persistence, and never logs key
// material. A computer that already carries a fingerprint is left unchanged.
func (p railwayComputerProvider) pinFirstUseFingerprint(ctx context.Context, r computers.Runtime, creds railwayCredentials, fingerprint string) error {
	if strings.TrimSpace(creds.HostKeyFingerprint) != "" || strings.TrimSpace(fingerprint) == "" {
		return nil
	}
	updated, err := json.Marshal(railwayCredentials{PrivateKey: creds.PrivateKey, HostKeyFingerprint: fingerprint})
	if err != nil {
		return err
	}
	sealed, err := computers.SealCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, updated)
	if err != nil {
		return err
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return p.h.computerStore().UpdateCredentials(persist, r.TenantID, r.SpaceID, r.ComputerID, sealed)
}

// persistManifest stores the parsed manifest for display. Like the TOFU
// fingerprint it runs detached from client cancellation. It is best-effort: a
// manifest is a display artifact, so a failed write must never invalidate an
// otherwise-verified creation, and the caller ignores the returned error.
func (p railwayComputerProvider) persistManifest(ctx context.Context, r computers.Runtime, manifest map[string]any) error {
	if len(manifest) == 0 {
		return nil
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	return p.h.computerStore().UpdateManifest(persist, target, manifest, p.h.deps.Clock())
}

// Create observes the box reachable with the computer's key and returns its
// identity. rootPath is always empty: Railway mounts no node-local directory.
func (p railwayComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	creds, err := p.authorize(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	manifest, fingerprint, err := p.observe(ctx, creds)
	if err != nil {
		return computers.CreationResult{}, err
	}
	id := railwayBoxIdentity(manifest)
	if id == "" {
		return computers.CreationResult{}, errors.New("railway connection did not return a manifest; reconciliation is required")
	}
	if err := p.pinFirstUseFingerprint(ctx, r, creds, fingerprint); err != nil {
		return computers.CreationResult{}, err
	}
	_ = p.persistManifest(ctx, r, manifest)
	return computers.CreationResult{ExternalID: id}, nil
}

// Find reconnects and reconciles. A manifest naming a different box than the one
// this runtime was pinned to is a hard error, never a silent replacement.
func (p railwayComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	creds, err := p.authorize(ctx, r, false)
	if err != nil {
		return computers.CreationResult{}, err
	}
	manifest, fingerprint, err := p.observe(ctx, creds)
	if err != nil {
		return computers.CreationResult{}, err
	}
	id := railwayBoxIdentity(manifest)
	if id == "" {
		return computers.CreationResult{}, errors.New("railway connection did not return a manifest; reconciliation is required")
	}
	if r.ExternalID != "" && r.ExternalID != id {
		return computers.CreationResult{}, errors.New("reconnected to a different railway box")
	}
	if err := p.pinFirstUseFingerprint(ctx, r, creds, fingerprint); err != nil {
		return computers.CreationResult{}, err
	}
	_ = p.persistManifest(ctx, r, manifest)
	return computers.CreationResult{ExternalID: id}, nil
}

// railwayOutput is a bounded, concurrency-safe io.Writer for a session's combined
// stdout/stderr. Excess bytes are discarded while Write still reports success, so
// the SSH copy loops never fail on truncation.
type railwayOutput struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (o *railwayOutput) Write(p []byte) (int, error) {
	n := len(p)
	o.mu.Lock()
	defer o.mu.Unlock()
	if room := o.limit - len(o.data); room > 0 {
		if n > room {
			p = p[:room]
		}
		o.data = append(o.data, p...)
	}
	return n, nil
}

func (o *railwayOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return string(o.data)
}

// Keys that mark a parsed object as a Railway manifest and, in priority order,
// the sub-keys that name the box. Comparison lowercases and drops "_" and "-".
var railwayManifestKeys = []string{"preview", "claim", "deadline", "url", "id", "box", "boxid", "vm", "hostname", "name"}
var railwayBoxKeys = []string{"id", "box", "boxid", "vm", "hostname", "name"}

func normaliseRailwayKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.ReplaceAll(key, "_", "")
	return strings.ReplaceAll(key, "-", "")
}

// parseRailwayManifest scans text for the first balanced JSON object that parses
// to a map carrying a recognised manifest field. The banner and progress noise
// around it are ignored.
func parseRailwayManifest(text string) (map[string]any, bool) {
	for i := 0; i < len(text); {
		start := strings.IndexByte(text[i:], '{')
		if start < 0 {
			break
		}
		start += i
		end, ok := matchJSONObject(text, start)
		if !ok {
			i = start + 1
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(text[start:end+1]), &obj); err == nil && manifestRecognised(obj) {
			return obj, true
		}
		i = end + 1
	}
	return nil, false
}

// matchJSONObject returns the index of the brace balancing the one at start,
// respecting string literals and escapes.
func matchJSONObject(s string, start int) (int, bool) {
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

func manifestRecognised(obj map[string]any) bool {
	for key := range obj {
		name := normaliseRailwayKey(key)
		for _, candidate := range railwayManifestKeys {
			if name == candidate {
				return true
			}
		}
	}
	return false
}

func railwayBoxIdentity(obj map[string]any) string {
	for _, candidate := range railwayBoxKeys {
		for key, value := range obj {
			if normaliseRailwayKey(key) != candidate {
				continue
			}
			if identity, ok := value.(string); ok && strings.TrimSpace(identity) != "" {
				return strings.TrimSpace(identity)
			}
		}
	}
	return ""
}
