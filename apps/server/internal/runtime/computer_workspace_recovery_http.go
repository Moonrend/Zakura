package runtime

import (
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) acknowledgeWorkspaceRecovery(w http.ResponseWriter, r *http.Request) {
	if !h.manageComputerScope(w, r) {
		return
	}
	var body struct {
		Token             string `json:"token"`
		OperationQuiesced bool   `json:"operationQuiesced"`
	}
	if httpx.DecodeJSON(r, &body) != nil || strings.TrimSpace(body.Token) == "" || !body.OperationQuiesced {
		httpx.Error(w, http.StatusBadRequest, "confirm the previous remote operation has stopped and provide its current recovery token")
		return
	}
	tenant, space := principal(r).TenantID, chi.URLParam(r, "id")
	if err := h.acknowledgeAbsentSpaceWorkspace(r.Context(), tenant, space, body.Token); err != nil {
		h.serverComputerLifecycleError(w, err)
		return
	}
	state, err := h.serverComputerState(r.Context(), tenant, space)
	if err != nil {
		computerStatusError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, state)
}
