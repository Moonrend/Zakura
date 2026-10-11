package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// Lifecycle requests are management operations, never executable agent tools.
// Keep the transport response separate from Runtime so account and provider IDs
// cannot accidentally become public when additional providers are registered.
type computerRuntimeResponse struct {
	RuntimeID          string            `json:"runtimeId"`
	ComputerID         string            `json:"computerId"`
	Incarnation        string            `json:"incarnation"`
	CreateOperationID  string            `json:"createOperationId"`
	State              computers.State   `json:"state"`
	ExecutionAvailable bool              `json:"executionAvailable"`
	Manifest           *computerManifest `json:"manifest,omitempty"`
}

// computerManifest is the only shape a provider manifest is exposed in. Unknown
// keys are dropped: the raw manifest is provider-controlled text and must never
// reach a client verbatim.
type computerManifest struct {
	ID       string `json:"id,omitempty"`
	Preview  string `json:"preview,omitempty"`
	Claim    string `json:"claim,omitempty"`
	Deadline string `json:"deadline,omitempty"`
}

// publicManifest decodes a stored manifest and returns only the known-safe string
// fields, matched case-insensitively the way railwayBoxIdentity matches keys. An
// empty, unparseable or field-less manifest yields nil so the key is omitted.
func publicManifest(raw string) *computerManifest {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal([]byte(raw), &obj) != nil {
		return nil
	}
	m := computerManifest{
		ID:       manifestStringField(obj, "id", "box", "boxid", "vm", "hostname", "name"),
		Preview:  manifestStringField(obj, "preview"),
		Claim:    manifestStringField(obj, "claim"),
		Deadline: manifestStringField(obj, "deadline"),
	}
	if m == (computerManifest{}) {
		return nil
	}
	return &m
}

// manifestStringField returns the first non-empty string value whose key
// normalises to one of the candidates, mirroring railwayBoxIdentity's matching.
func manifestStringField(obj map[string]any, candidates ...string) string {
	for _, candidate := range candidates {
		for key, value := range obj {
			if normaliseRailwayKey(key) != candidate {
				continue
			}
			if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

// publicComputerRuntime loads the computer's granted capabilities so
// executionAvailable reflects the channels actually wired rather than the
// selection-time snapshot, which is stale once provisioning grants them. It is
// only available once the runtime is ready and the commands channel is granted.
func (h *handler) publicComputerRuntime(ctx context.Context, r computers.Runtime) computerRuntimeResponse {
	executionAvailable := false
	if r.State == computers.Ready {
		var raw string
		if err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT capabilities_json FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), r.TenantID, r.SpaceID, r.ComputerID).Scan(&raw); err == nil {
			var granted []computers.Capability
			if json.Unmarshal([]byte(raw), &granted) == nil {
				for _, cap := range granted {
					if cap == computers.Commands {
						executionAvailable = true
						break
					}
				}
			}
		}
	}
	return computerRuntimeResponse{RuntimeID: r.ID, ComputerID: r.ComputerID, Incarnation: r.Incarnation, CreateOperationID: r.CreateOperationID, State: r.State, ExecutionAvailable: executionAvailable, Manifest: publicManifest(r.ManifestJSON)}
}
func (h *handler) computerProvisioner() computers.Provisioner {
	return computers.Provisioner{Store: h.computerStore(), Providers: map[computers.Provider]computers.CreationProvider{
		computers.Server:    serverComputerProvider{h: h},
		computers.Temporary: temporaryComputerProvider{h: h},
		computers.E2B:       e2bComputerProvider{h: h},
		computers.Railway:   railwayComputerProvider{h: h},
		computers.SSH:       sshComputerProvider{h: h},
	}}
}

// computerDestroyers is the adapter set handed to deadline reclamation. Providers
// without a destructive adapter are expired in place rather than force-removed.
func (h *handler) computerDestroyers() map[computers.Provider]computers.DestructionProvider {
	return map[computers.Provider]computers.DestructionProvider{
		computers.Temporary: temporaryComputerProvider{h: h},
		computers.E2B:       e2bComputerProvider{h: h},
	}
}
func (h *handler) computerLifecycleScope(w http.ResponseWriter, r *http.Request) (computers.Computer, bool) {
	if !h.manageComputerScope(w, r) {
		return computers.Computer{}, false
	}
	items, err := h.computerStore().List(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		computerStatusError(w, err)
		return computers.Computer{}, false
	}
	for _, c := range items {
		if c.ID != chi.URLParam(r, "cid") {
			continue
		}
		// Legacy volumes remain under the legacy lifecycle, and adapters without a
		// registered provider stay unavailable rather than failing at dispatch.
		if (c.Provider != computers.Server && c.Provider != computers.Temporary && c.Provider != computers.E2B && c.Provider != computers.Railway && c.Provider != computers.SSH) || strings.HasPrefix(c.ID, "legacy:") {
			httpx.Error(w, http.StatusNotImplemented, "computer lifecycle adapter is unavailable")
			return computers.Computer{}, false
		}
		return c, true
	}
	computerStatusError(w, sql.ErrNoRows)
	return computers.Computer{}, false
}
func computerLifecycleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, computers.ErrProviderUnavailable):
		httpx.Error(w, 503, "computer provider unavailable")
	case errors.Is(err, computers.ErrCreationUncertain):
		httpx.Error(w, 409, "computer creation outcome uncertain; reconcile the same runtime before any further action")
	case errors.Is(err, computers.ErrTransitionConflict), errors.Is(err, computers.ErrApprovalRequired), errors.Is(err, computers.ErrRuntimeEnded), errors.Is(err, computers.ErrReplaceUnavailable):
		httpx.Error(w, 409, err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(w, 404, "computer runtime not found")
	default:
		httpx.Error(w, 500, "computer lifecycle operation failed")
	}
}
func (h *handler) reserveComputerRuntime(w http.ResponseWriter, r *http.Request) {
	c, ok := h.computerLifecycleScope(w, r)
	if !ok {
		return
	}
	// Reservation records intent only. No RPC, credentials, or paid creation.
	// Session-scoped providers (temporary, e2b) require the owning chat; a missing
	// session is a client error, never a server fault. Other providers ignore it.
	session := strings.TrimSpace(r.URL.Query().Get("session"))
	if _, err := c.Scope(session); err != nil {
		httpx.Error(w, http.StatusBadRequest, "a session is required for this computer provider")
		return
	}
	result, err := h.computerStore().ReserveRuntime(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "cid"), session, time.Now())
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, h.publicComputerRuntime(r.Context(), result))
}
func (h *handler) computerRuntimeTarget(r *http.Request, incarnation string) computers.Target {
	return computers.Target{TenantID: principal(r).TenantID, SpaceID: chi.URLParam(r, "id"), ComputerID: chi.URLParam(r, "cid"), RuntimeID: chi.URLParam(r, "rid"), Incarnation: incarnation}
}
func (h *handler) getComputerRuntime(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.computerLifecycleScope(w, r); !ok {
		return
	}
	if r.URL.Query().Get("incarnation") == "" {
		httpx.Error(w, 400, "incarnation is required")
		return
	}
	result, err := h.computerStore().GetRuntime(r.Context(), h.computerRuntimeTarget(r, r.URL.Query().Get("incarnation")))
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, h.publicComputerRuntime(r.Context(), result))
}
func (h *handler) mutateComputerRuntime(w http.ResponseWriter, r *http.Request, approve bool) {
	if _, ok := h.computerLifecycleScope(w, r); !ok {
		return
	}
	var in struct {
		Incarnation string `json:"incarnation"`
		Operation   string `json:"createOperationId"`
		Confirm     bool   `json:"confirm"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF || in.Incarnation == "" || in.Operation == "" || (approve && !in.Confirm) {
		httpx.Error(w, 400, "exact incarnation and creation operation are required; creation also requires confirm=true")
		return
	}
	target := h.computerRuntimeTarget(r, in.Incarnation)
	stored, err := h.computerStore().GetRuntime(r.Context(), target)
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	if stored.CreateOperationID != in.Operation {
		computerLifecycleError(w, computers.ErrTransitionConflict)
		return
	}
	provisioner := h.computerProvisioner()
	var result computers.Runtime
	if approve {
		actor := principal(r).UserID
		if actor == "" {
			httpx.Error(w, 403, "an identified approving user is required")
			return
		}
		result, err = provisioner.ApproveAndCreate(r.Context(), target, in.Operation, actor)
	} else {
		result, err = provisioner.ReconcileCreation(r.Context(), target)
	}
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, h.publicComputerRuntime(r.Context(), result))
}
func (h *handler) approveComputerRuntime(w http.ResponseWriter, r *http.Request) {
	h.mutateComputerRuntime(w, r, true)
}
func (h *handler) reconcileComputerRuntime(w http.ResponseWriter, r *http.Request) {
	h.mutateComputerRuntime(w, r, false)
}

// replaceComputerRuntime is the explicit way out of a terminal creation outcome:
// it resolves the pinned runtime, verifies the instance really is gone (for
// providers whose Find can prove absence) and reserves a fresh pending runtime.
// It never creates anything and never retries the original operation.
func (h *handler) replaceComputerRuntime(w http.ResponseWriter, r *http.Request) {
	c, ok := h.computerLifecycleScope(w, r)
	if !ok {
		return
	}
	session := strings.TrimSpace(r.URL.Query().Get("session"))
	if _, err := c.Scope(session); err != nil {
		httpx.Error(w, http.StatusBadRequest, "a session is required for this computer provider")
		return
	}
	var in struct {
		Incarnation string `json:"incarnation"`
		Operation   string `json:"createOperationId"`
		Confirm     bool   `json:"confirm"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF || in.Incarnation == "" || in.Operation == "" || !in.Confirm {
		httpx.Error(w, 400, "exact incarnation and creation operation are required; replacement also requires confirm=true")
		return
	}
	target := h.computerRuntimeTarget(r, in.Incarnation)
	stored, err := h.computerStore().GetRuntime(r.Context(), target)
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	if stored.CreateOperationID != in.Operation {
		computerLifecycleError(w, computers.ErrTransitionConflict)
		return
	}
	result, err := h.computerProvisioner().PrepareReplacement(r.Context(), target, principal(r).UserID)
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, h.publicComputerRuntime(r.Context(), result))
}
