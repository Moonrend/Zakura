package runtime

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// e2bComputerProvider is a control-plane adapter that talks to the E2B cloud
// API directly; it never touches the runner hub. E2B is session-scoped, so a
// runtime here always carries a session ID. The provider only creates, observes
// and destroys sandboxes: lifetime renewal lives in computers.CompleteCreation.
type e2bComputerProvider struct {
	h          *handler
	apiBase    string
	httpClient *http.Client
}

var _ computers.CreationProvider = e2bComputerProvider{}
var _ computers.DestructionProvider = e2bComputerProvider{}

const defaultE2BAPIBase = "https://api.e2b.dev"

type e2bCredentials struct {
	APIKey   string `json:"apiKey"`
	Template string `json:"template"`
}

type e2bConfiguration struct {
	APIKey      string
	Template    string
	MaxLifetime int
}

func (p e2bComputerProvider) base() string {
	if strings.TrimSpace(p.apiBase) != "" {
		return strings.TrimRight(p.apiBase, "/")
	}
	return defaultE2BAPIBase
}

func (p e2bComputerProvider) client() *http.Client {
	if p.httpClient != nil {
		return p.httpClient
	}
	return &http.Client{Timeout: 60 * time.Second}
}

// e2bMetadata is the durable ownership tag attached to every sandbox. Find uses
// it both as a server-side filter and as proof that a returned instance belongs
// to this exact runtime: different accounts can hand back the same sandbox ID.
func e2bMetadata(r computers.Runtime) map[string]string {
	return map[string]string{
		"zakura.operation":   r.CreateOperationID,
		"zakura.runtime":     r.ID,
		"zakura.incarnation": r.Incarnation,
		"zakura.computer":    r.ComputerID,
		"zakura.tenant":      r.TenantID,
		"zakura.space":       r.SpaceID,
	}
}

func e2bMetadataMatches(metadata map[string]string, r computers.Runtime) bool {
	for key, want := range e2bMetadata(r) {
		if metadata[key] != want {
			return false
		}
	}
	return true
}

// pinnedRuntime re-reads identity from storage so a caller can never point the
// provider at another tenant's or another incarnation's runtime.
func (p e2bComputerProvider) pinnedRuntime(ctx context.Context, r computers.Runtime) (computers.Runtime, error) {
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	return p.h.computerStore().GetRuntime(ctx, target)
}

// configuration decrypts the computer's own E2B envelope. Secrets never reach a
// log, error or response surface: every failure returns a generic message.
func (p e2bComputerProvider) configuration(ctx context.Context, r computers.Runtime) (e2bConfiguration, error) {
	var envelope string
	var maxLifetime int
	err := p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT COALESCE(secret_ref,''), max_lifetime_seconds FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&envelope, &maxLifetime)
	if err != nil {
		return e2bConfiguration{}, err
	}
	if strings.TrimSpace(envelope) == "" {
		return e2bConfiguration{}, errors.New("computer has no E2B configuration")
	}
	plain, err := computers.OpenCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope)
	if err != nil {
		return e2bConfiguration{}, errors.New("computer E2B configuration could not be opened")
	}
	var creds e2bCredentials
	if err := json.Unmarshal(plain, &creds); err != nil {
		return e2bConfiguration{}, errors.New("computer E2B configuration is invalid")
	}
	if strings.TrimSpace(creds.APIKey) == "" || strings.TrimSpace(creds.Template) == "" {
		return e2bConfiguration{}, errors.New("computer E2B configuration is incomplete")
	}
	if maxLifetime <= 0 {
		maxLifetime = 3600
	}
	return e2bConfiguration{APIKey: creds.APIKey, Template: creds.Template, MaxLifetime: maxLifetime}, nil
}

// authorize enforces the Provisioner contract before any paid call: the runtime
// must still be the pinned, unbound record this call was dispatched for and its
// creation must be durably approved.
func (p e2bComputerProvider) authorize(ctx context.Context, r computers.Runtime, create bool) (e2bConfiguration, error) {
	if strings.TrimSpace(r.SessionScope) == "" {
		return e2bConfiguration{}, computers.ErrTransitionConflict
	}
	actual, err := p.pinnedRuntime(ctx, r)
	if err != nil {
		return e2bConfiguration{}, err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || actual.ExternalID != "" ||
		(actual.State != computers.Creating && (create || actual.State != computers.Unknown)) {
		return e2bConfiguration{}, computers.ErrTransitionConflict
	}
	var approved int
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT 1 FROM computer_creation_approvals WHERE runtime_id=? AND create_operation_id=?`), r.ID, r.CreateOperationID).Scan(&approved)
	if errors.Is(err, sql.ErrNoRows) {
		return e2bConfiguration{}, computers.ErrTransitionConflict
	}
	if err != nil {
		return e2bConfiguration{}, err
	}
	return p.configuration(ctx, r)
}

func (p e2bComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	cfg, err := p.authorize(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"templateID": cfg.Template,
		"metadata":   e2bMetadata(r),
		"timeout":    cfg.MaxLifetime,
	})
	if err != nil {
		return computers.CreationResult{}, errors.New("E2B create request could not be encoded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.base()+"/sandboxes", bytes.NewReader(payload))
	if err != nil {
		return computers.CreationResult{}, errors.New("E2B create request could not be built")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)
	resp, err := p.client().Do(req)
	if err != nil {
		return computers.CreationResult{}, errors.New("E2B create request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Never echo the response body: it can carry credentials or signed URLs.
		return computers.CreationResult{}, fmt.Errorf("E2B create request rejected with status %d", resp.StatusCode)
	}
	var created struct {
		SandboxID       string `json:"sandboxID"`
		EnvdAccessToken string `json:"envdAccessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		return computers.CreationResult{}, errors.New("E2B create response could not be read")
	}
	if strings.TrimSpace(created.SandboxID) == "" {
		return computers.CreationResult{}, errors.New("E2B create response contained no sandbox ID")
	}
	// envd rejects unauthenticated execution, so the sandbox-issued token is
	// sealed under the computer identity before it ever leaves this function.
	var tokenEnc string
	if token := strings.TrimSpace(created.EnvdAccessToken); token != "" {
		tokenEnc, err = computers.SealCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, []byte(fmt.Sprintf(`{"envdAccessToken":%q}`, token)))
		if err != nil {
			return computers.CreationResult{}, errors.New("E2B access token could not be sealed")
		}
	}
	return computers.CreationResult{ExternalID: created.SandboxID, AccessTokenEnc: tokenEnc}, nil
}

func (p e2bComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	cfg, err := p.authorize(ctx, r, false)
	if err != nil {
		return computers.CreationResult{}, err
	}
	query := url.Values{}
	query.Set("metadata", "zakura.operation="+r.CreateOperationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base()+"/sandboxes?"+query.Encode(), nil)
	if err != nil {
		return computers.CreationResult{}, errors.New("E2B lookup request could not be built")
	}
	req.Header.Set("X-API-Key", cfg.APIKey)
	resp, err := p.client().Do(req)
	if err != nil {
		return computers.CreationResult{}, errors.New("E2B lookup request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return computers.CreationResult{}, fmt.Errorf("E2B lookup request rejected with status %d", resp.StatusCode)
	}
	var listed []struct {
		SandboxID string            `json:"sandboxID"`
		Metadata  map[string]string `json:"metadata"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		return computers.CreationResult{}, errors.New("E2B lookup response could not be read")
	}
	if len(listed) == 0 {
		// Not yet observed is not permission to create a replacement.
		return computers.CreationResult{}, nil
	}
	if len(listed) != 1 {
		return computers.CreationResult{}, errors.New("ambiguous E2B creation operation")
	}
	if !e2bMetadataMatches(listed[0].Metadata, r) {
		return computers.CreationResult{}, errors.New("E2B sandbox ownership could not be verified")
	}
	// The list endpoint never returns the envd access token, so a sandbox
	// recovered here has no token and its envd execution fails until it is
	// destroyed and recreated. That is an accepted recovery limitation.
	return computers.CreationResult{ExternalID: listed[0].SandboxID}, nil
}

type e2bCleanupSnapshot struct {
	Runtime       computers.Runtime `json:"runtime"`
	Configuration e2bConfiguration  `json:"configuration"`
	APIBase       string            `json:"apiBase"`
}

var _ computers.CleanupSnapshotProvider = e2bComputerProvider{}

func (p e2bComputerProvider) CaptureCleanup(ctx context.Context, r computers.Runtime) (json.RawMessage, error) {
	actual, err := p.pinnedRuntime(ctx, r)
	if err != nil {
		return nil, err
	}
	if !cleanupRuntimeIdentityMatches(actual, r) || r.Incarnation == "" || r.CreateOperationID == "" || strings.TrimSpace(r.SessionScope) == "" {
		return nil, computers.ErrTransitionConflict
	}
	var provider string
	if err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT provider FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&provider); err != nil {
		return nil, err
	}
	if provider != "e2b" {
		return nil, computers.ErrTransitionConflict
	}
	cfg, err := p.configuration(ctx, r)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(e2bCleanupSnapshot{Runtime: actual, Configuration: cfg, APIBase: p.base()})
	if err != nil {
		return nil, errors.New("E2B cleanup snapshot could not be encoded")
	}
	sealed, err := computers.SealCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, raw)
	if err != nil {
		return nil, errors.New("E2B cleanup snapshot could not be sealed")
	}
	return json.Marshal(map[string]string{"sealed": sealed})
}

// Cleanup uses the original sealed account/configuration and immutable runtime,
// never the owner's current credentials. An exact ownership probe must succeed
// before DELETE; missing external identities are discovered by operation metadata.
func (p e2bComputerProvider) DestroyCleanup(ctx context.Context, r computers.Runtime, data json.RawMessage) error {
	var envelope struct {
		Sealed string `json:"sealed"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return errors.New("E2B cleanup snapshot is invalid")
	}
	plain, err := computers.OpenCredentials(p.h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope.Sealed)
	if err != nil {
		return errors.New("E2B cleanup snapshot could not be opened")
	}
	var snapshot e2bCleanupSnapshot
	if json.Unmarshal(plain, &snapshot) != nil || !cleanupRuntimeIdentityMatches(snapshot.Runtime, r) || snapshot.APIBase == "" || snapshot.Configuration.APIKey == "" {
		return computers.ErrTransitionConflict
	}
	client := *p.client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if strings.TrimSpace(r.ExternalID) == "" {
		query := url.Values{}
		query.Set("metadata", "zakura.operation="+r.CreateOperationID)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(snapshot.APIBase, "/")+"/sandboxes?"+query.Encode(), nil)
		if err != nil {
			return errors.New("E2B cleanup lookup request could not be built")
		}
		req.Header.Set("X-API-Key", snapshot.Configuration.APIKey)
		resp, err := client.Do(req)
		if err != nil {
			return errors.New("E2B cleanup lookup request failed")
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("E2B cleanup lookup rejected with status %d", resp.StatusCode)
		}
		var listed []struct {
			SandboxID string            `json:"sandboxID"`
			Metadata  map[string]string `json:"metadata"`
		}
		if json.NewDecoder(resp.Body).Decode(&listed) != nil {
			return errors.New("E2B cleanup lookup response could not be read")
		}
		// An empty list cannot prove an in-flight creation will never appear.
		// Leave the durable intent pending so the worker keeps discovering it.
		if len(listed) != 1 || listed[0].SandboxID == "" || !e2bMetadataMatches(listed[0].Metadata, r) {
			return errors.New("E2B cleanup creation outcome remains unknown")
		}
		// Persisted snapshot identity remains unchanged; the discovered ID is used
		// only after checking the exact operation's ownership metadata.
		r.ExternalID = listed[0].SandboxID
	}
	endpoint := strings.TrimRight(snapshot.APIBase, "/") + "/sandboxes/" + url.PathEscape(r.ExternalID)
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return errors.New("E2B cleanup ownership request could not be built")
	}
	probe.Header.Set("X-API-Key", snapshot.Configuration.APIKey)
	resp, err := client.Do(probe)
	if err != nil {
		return errors.New("E2B cleanup ownership request failed")
	}
	if resp.StatusCode == http.StatusNotFound {
		_ = resp.Body.Close()
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return fmt.Errorf("E2B cleanup ownership request rejected with status %d", resp.StatusCode)
	}
	var actual struct {
		SandboxID string            `json:"sandboxID"`
		Metadata  map[string]string `json:"metadata"`
	}
	decodeErr := json.NewDecoder(resp.Body).Decode(&actual)
	_ = resp.Body.Close()
	if decodeErr != nil {
		return errors.New("E2B cleanup ownership response could not be read")
	}
	if actual.SandboxID != r.ExternalID || !e2bMetadataMatches(actual.Metadata, r) {
		return errors.New("E2B cleanup sandbox ownership could not be verified")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return errors.New("E2B cleanup destroy request could not be built")
	}
	req.Header.Set("X-API-Key", snapshot.Configuration.APIKey)
	resp, err = client.Do(req)
	if err != nil {
		return errors.New("E2B cleanup destroy request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("E2B cleanup destroy request rejected with status %d", resp.StatusCode)
	}
	return nil
}

// Destroy is the control-plane teardown used by the cleanup worker, whose
// request context may already be cancelled, so the call runs detached.
func (p e2bComputerProvider) Destroy(ctx context.Context, r computers.Runtime) error {
	if strings.TrimSpace(r.ExternalID) == "" {
		return errors.New("E2B runtime has no sandbox to destroy")
	}
	detached, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := p.pinnedRuntime(detached, r); err != nil {
		return err
	}
	cfg, err := p.configuration(detached, r)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(detached, http.MethodDelete, p.base()+"/sandboxes/"+url.PathEscape(r.ExternalID), nil)
	if err != nil {
		return errors.New("E2B destroy request could not be built")
	}
	req.Header.Set("X-API-Key", cfg.APIKey)
	resp, err := p.client().Do(req)
	if err != nil {
		return errors.New("E2B destroy request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("E2B destroy request rejected with status %d", resp.StatusCode)
	}
	return nil
}
