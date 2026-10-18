// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// ACP installations and credentials belong to the Space, not to an arbitrary
// Agent used to reach its workspace. Old Agent routes are compatibility aliases.
func (h *handler) acpSpace(ctx context.Context, tenant, agent, space string) (Space, map[string]any, error) {
	var legacy map[string]any
	if agent != "" {
		a, cfg, err := h.agentConfig(ctx, tenant, agent)
		if err != nil {
			return Space{}, nil, err
		}
		space = a.SpaceID
		legacy, _ = cfg["acp"].(map[string]any)
	}
	s, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return Space{}, nil, err
	}
	cfg := map[string]any{}
	if len(s.Config) > 0 && string(s.Config) != "null" {
		if err = json.Unmarshal(s.Config, &cfg); err != nil {
			return Space{}, nil, errors.New("space configuration is invalid JSON")
		}
	}
	// Read legacy settings only until the Space has its own ACP section. Once
	// saved, sibling Agents all use the same canonical configuration.
	if _, exists := cfg["acp"]; !exists && legacy != nil {
		cfg["acp"] = legacy
	}
	return s, cfg, nil
}

func (h *handler) requestACPSpace(r *http.Request) (Space, map[string]any, error) {
	p := principal(r)
	if p.APIKey && p.AgentID != "" && (chi.URLParam(r, "spaceId") != "" || chi.URLParam(r, "id") != p.AgentID) {
		return Space{}, nil, ErrNotFound
	}
	s, cfg, err := h.acpSpace(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "spaceId"))
	if err == nil {
		agent := chi.URLParam(r, "id")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			agent = ""
		}
		if httpx.AuthorizeResource(r.Context(), h.deps, p, s.ID, agent) != nil {
			return Space{}, nil, ErrNotFound
		}
	}
	return s, cfg, err
}

// mutateSpaceACP applies profile/install patches to the latest ACP section on
// every retry. Legacy Agent configuration is adopted only when no section exists.
func (h *handler) mutateSpaceACP(ctx context.Context, tenant, space string, legacy map[string]any, mutate func(map[string]any) (map[string]any, error)) (map[string]any, error) {
	var result map[string]any
	_, err := h.store.mutateSpaceConfig(ctx, tenant, space, func(cfg map[string]any) error {
		current, exists := cfg["acp"].(map[string]any)
		if !exists {
			current = map[string]any{}
			if legacy != nil {
				encoded, err := json.Marshal(legacy)
				if err != nil {
					return err
				}
				if err = json.Unmarshal(encoded, &current); err != nil {
					return err
				}
			}
		}
		next, err := mutate(current)
		if err != nil {
			return err
		}
		cfg["acp"] = next
		result = next
		return nil
	})
	return result, err
}

// saveSpaceACP replaces the ACP section explicitly. Patch callers must use
// mutateSpaceACP so retries never replace fields from an outdated snapshot.
func (h *handler) saveSpaceACP(ctx context.Context, tenant, space string, acp map[string]any) error {
	_, err := h.mutateSpaceACP(ctx, tenant, space, nil, func(map[string]any) (map[string]any, error) {
		return acp, nil
	})
	return err
}

func acpConfigResponse(raw map[string]any) map[string]any {
	cfg := parseACPConfig(raw)
	return map[string]any{"config": scrubACPConfig(cfg), "profiles": acpCatalogForConfig(cfg)}
}

func acpRuntimeProfile(raw map[string]any, id string) (map[string]any, error) {
	cfg := parseACPConfig(raw)
	setup, ok := cfg.Agents[id]
	if !ok || !setup.Enabled {
		return nil, ErrNotFound
	}
	profile := acpProfileForSetup(setup)
	if setup.ModelProvider == "zakura" && (setup.Managed["zakura_api_key"] == "" || setup.Managed["zakura_base_url"] == "") {
		return nil, errors.New("ACP Zakura route requires a Space gateway key and base URL")
	}
	if setup.Command == "" {
		if field := missingRequiredACPField(profile, setup); field != nil {
			return nil, errors.New("ACP profile requires " + field.Label)
		}
	}
	launch := resolveACPLaunch(profile, setup)
	if strings.TrimSpace(launch.Command) == "" {
		return nil, errors.New("ACP profile command required")
	}
	out := map[string]any{"id": id, "command": launch.Command, "args": launch.Args, "env": launch.Env, "displayName": profile.DisplayName, "setup": setup}
	if setup.Command == "" {
		out["image"] = acpAdapterImage(id, setup.PinnedVersion)
	}
	// Preserve explicitly configured device OAuth endpoints from legacy profiles.
	for _, section := range []string{"profiles", "agents"} {
		entries, _ := raw[section].(map[string]any)
		rec, _ := entries[id].(map[string]any)
		for _, key := range []string{"deviceAuthorizationUrl", "tokenUrl", "clientId", "scope"} {
			if value, exists := rec[key]; exists {
				out[key] = value
			}
		}
	}
	return out, nil
}

func (h *handler) requestACPProfile(r *http.Request) (Space, map[string]any, error) {
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		return Space{}, nil, err
	}
	profile, err := acpRuntimeProfile(acpMap(cfg), chi.URLParam(r, "profileId"))
	return s, profile, err
}

func (h *handler) registerSpaceACP(r chi.Router) {
	r.Get("/spaces/{spaceId}/acp/config", h.getACPConfig)
	r.Put("/spaces/{spaceId}/acp/config", h.putACPConfig)
	r.Put("/spaces/{spaceId}/acp/agents/{profileId}", h.putACPProfile)
	r.Delete("/spaces/{spaceId}/acp/agents/{profileId}", h.deleteACPProfile)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/probe", h.probeACPProfile)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/install", h.installACPProfile)
	r.Get("/spaces/{spaceId}/acp/installs", h.acpInstalls)
	r.Get("/spaces/{spaceId}/acp/adapters", h.acpAdapters)
	r.Post("/spaces/{spaceId}/acp/adapters/{registryId}/install", h.installACPAdapter)
	r.Post("/spaces/{spaceId}/acp/adapters/{registryId}/adopt", h.adoptACPAdapter)
	r.Delete("/spaces/{spaceId}/acp/adapters/{registryId}", h.deleteACPAdapter)
	r.Post("/spaces/{spaceId}/acp/adapters/gc", h.gcACPAdapters)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/oauth/device/start", h.codexDeviceStart)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/oauth/device/poll", h.codexDevicePoll)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/oauth/device/cancel", h.codexDeviceCancel)
	r.Get("/spaces/{spaceId}/acp/agents/{profileId}/auth-recovery", h.getACPAuthRecovery)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/auth-recovery/acknowledge", h.acknowledgeACPAuthRecovery)
}

func (h *handler) adoptACPAdapter(w http.ResponseWriter, r *http.Request) {
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	id := chi.URLParam(r, "registryId")
	var profileID string
	for _, adapter := range acpCatalogOnce().Agents {
		if adapter.ID == id {
			profileID = adapter.ProfileID
			break
		}
	}
	if profileID == "" {
		statusErr(w, ErrNotFound)
		return
	}
	var setup acpSetup
	_, err = h.mutateSpaceACP(r.Context(), s.TenantID, s.ID, acpMap(cfg), func(acp map[string]any) (map[string]any, error) {
		parsed := parseACPConfig(acp)
		var exists bool
		setup, exists = parsed.Agents[profileID]
		if !exists {
			setup = parseACPSetup(profileID, nil, false)
		}
		setup.PinnedVersion = strings.TrimSpace(body.Version)
		parsed.Agents[profileID] = setup
		return acpConfigJSON(parsed, acp), nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": id, "pinnedVersion": nullString(setup.PinnedVersion), "image": acpAdapterImage(profileID, setup.PinnedVersion)})
}
