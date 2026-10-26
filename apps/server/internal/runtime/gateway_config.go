// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"net/http"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) spaceGatewayConfig(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	if p.APIKey && (p.AgentID != "" || p.SpaceID != "" && p.SpaceID != id) {
		httpx.Error(w, http.StatusForbidden, "Space access denied")
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, id)
	if err != nil {
		statusErr(w, err)
		return
	}
	var config map[string]any
	_ = json.Unmarshal(space.Config, &config)
	if r.Method == http.MethodPut {
		var patch map[string]any
		if httpx.DecodeJSON(r, &patch) != nil || patch == nil {
			httpx.Error(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		for key, value := range patch {
			switch key {
			case "model", "modelRouteId":
				if value != nil {
					if _, ok := value.(string); !ok {
						httpx.Error(w, http.StatusBadRequest, "model selection must be a string")
						return
					}
				}
			case "gatewayModelMap":
				if value != nil {
					mapping, ok := value.(map[string]any)
					if !ok {
						httpx.Error(w, http.StatusBadRequest, "gatewayModelMap must be an object")
						return
					}
					for _, target := range mapping {
						if _, ok := target.(string); !ok {
							httpx.Error(w, http.StatusBadRequest, "model map values must be strings")
							return
						}
					}
				}
			default:
				httpx.Error(w, http.StatusBadRequest, "unsupported gateway setting")
				return
			}
		}
		config, err = h.store.mutateSpaceConfig(r.Context(), p.TenantID, id, func(current map[string]any) error {
			cloud := gwMap(current["cloud"])
			if cloud == nil {
				cloud = map[string]any{}
			}
			for key, value := range patch {
				if value == nil || value == "" {
					delete(cloud, key)
				} else {
					cloud[key] = value
				}
			}
			current["cloud"] = cloud
			return nil
		})
		if err != nil {
			statusErr(w, err)
			return
		}
	}
	cloud := gwMap(config["cloud"])
	gateway := map[string]any{}
	for _, key := range []string{"model", "modelRouteId", "gatewayModelMap"} {
		if value, ok := cloud[key]; ok {
			gateway[key] = value
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cloud": gateway})
}
