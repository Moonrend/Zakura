package runtime

import (
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
	RuntimeID          string          `json:"runtimeId"`
	ComputerID         string          `json:"computerId"`
	Incarnation        string          `json:"incarnation"`
	CreateOperationID  string          `json:"createOperationId"`
	State              computers.State `json:"state"`
	ExecutionAvailable bool            `json:"executionAvailable"`
}

func publicComputerRuntime(r computers.Runtime) computerRuntimeResponse {
	return computerRuntimeResponse{RuntimeID: r.ID, ComputerID: r.ComputerID, Incarnation: r.Incarnation, CreateOperationID: r.CreateOperationID, State: r.State}
}
func (h *handler) computerProvisioner() computers.Provisioner {
	return computers.Provisioner{Store: h.computerStore(), Providers: map[computers.Provider]computers.CreationProvider{computers.Server: serverComputerProvider{h: h}}}
}
func (h *handler) computerLifecycleScope(w http.ResponseWriter, r *http.Request) bool {
	if !h.manageComputerScope(w, r) {
		return false
	}
	items, err := h.computerStore().List(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		computerStatusError(w, err)
		return false
	}
	for _, c := range items {
		if c.ID != chi.URLParam(r, "cid") {
			continue
		}
		// Legacy volumes remain under the legacy lifecycle. Temporary providers must
		// not be provisioned before their mandatory cleanup worker is implemented.
		if c.Provider != computers.Server || strings.HasPrefix(c.ID, "legacy:") {
			httpx.Error(w, http.StatusNotImplemented, "computer lifecycle adapter is unavailable")
			return false
		}
		return true
	}
	computerStatusError(w, sql.ErrNoRows)
	return false
}
func computerLifecycleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, computers.ErrProviderUnavailable):
		httpx.Error(w, 503, "computer provider unavailable")
	case errors.Is(err, computers.ErrCreationUncertain):
		httpx.Error(w, 409, "computer creation outcome uncertain; reconcile the same runtime before any further action")
	case errors.Is(err, computers.ErrTransitionConflict), errors.Is(err, computers.ErrApprovalRequired), errors.Is(err, computers.ErrRuntimeEnded):
		httpx.Error(w, 409, err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(w, 404, "computer runtime not found")
	default:
		httpx.Error(w, 500, "computer lifecycle operation failed")
	}
}
func (h *handler) reserveComputerRuntime(w http.ResponseWriter, r *http.Request) {
	if !h.computerLifecycleScope(w, r) {
		return
	}
	// Reservation records intent only. No RPC, credentials, or paid creation.
	result, err := h.computerStore().ReserveRuntime(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "cid"), "", time.Now())
	if err != nil {
		computerLifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, publicComputerRuntime(result))
}
func (h *handler) computerRuntimeTarget(r *http.Request, incarnation string) computers.Target {
	return computers.Target{TenantID: principal(r).TenantID, SpaceID: chi.URLParam(r, "id"), ComputerID: chi.URLParam(r, "cid"), RuntimeID: chi.URLParam(r, "rid"), Incarnation: incarnation}
}
func (h *handler) getComputerRuntime(w http.ResponseWriter, r *http.Request) {
	if !h.computerLifecycleScope(w, r) {
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
	httpx.JSON(w, 200, publicComputerRuntime(result))
}
func (h *handler) mutateComputerRuntime(w http.ResponseWriter, r *http.Request, approve bool) {
	if !h.computerLifecycleScope(w, r) {
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
	httpx.JSON(w, 200, publicComputerRuntime(result))
}
func (h *handler) approveComputerRuntime(w http.ResponseWriter, r *http.Request) {
	h.mutateComputerRuntime(w, r, true)
}
func (h *handler) reconcileComputerRuntime(w http.ResponseWriter, r *http.Request) {
	h.mutateComputerRuntime(w, r, false)
}
