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

type approvalScopeConfig struct {
	Scope             string   `json:"scope"`
	AutoAllowReadOnly *bool    `json:"autoAllowReadOnly,omitempty"`
	SafeTools         []string `json:"safeTools"`
	DangerousTools    []string `json:"dangerousTools"`
}

func parseApprovalScope(raw json.RawMessage) (approvalScopeConfig, error) {
	cfg := approvalScopeConfig{Scope: "risky", SafeTools: []string{}, DangerousTools: []string{}}
	var root struct {
		Approvals json.RawMessage `json:"approvals"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &root) != nil {
		return cfg, errors.New("invalid Space approval configuration")
	}
	if len(root.Approvals) > 0 && string(root.Approvals) != "null" {
		if err := json.Unmarshal(root.Approvals, &cfg); err != nil {
			return cfg, errors.New("invalid Space approval configuration")
		}
	}
	if cfg.Scope != "risky" && cfg.Scope != "all" {
		return cfg, errors.New("approval scope must be risky or all")
	}
	for _, list := range [][]string{cfg.SafeTools, cfg.DangerousTools} {
		if len(list) > 100 {
			return cfg, errors.New("at most 100 tool matchers are allowed")
		}
		for _, matcher := range list {
			if strings.TrimSpace(matcher) == "" || len(matcher) > 256 {
				return cfg, errors.New("invalid approval tool matcher")
			}
		}
	}
	return cfg, nil
}

// Only known native read operations are trusted by default. MCP tool names and
// arbitrary commands do not establish read-only semantics; users can opt them in.
func approvalReadOnlyTool(name string) bool {
	switch strings.TrimPrefix(name, "re_") {
	case "fs_read", "fs_list", "web_search", "web_fetch", "tool_search", "list_computers", "memory_search",
		"list_sessions", "search_sessions", "get_messages", "list_routines", "list_automation_runs",
		"Read", "Glob", "Grep", "WebSearch", "WebFetch", "fs/read_text_file", "terminal/output", "terminal/wait_for_exit":
		return true
	}
	return false
}

func (c toolApprovalConfig) dangerousTool(name string, args json.RawMessage) bool {
	for _, matcher := range c.Scope.DangerousTools {
		if approvalMatcher(matcher, name, args) {
			return true
		}
	}
	return false
}

func (c toolApprovalConfig) needsAIReview(name string, args json.RawMessage) bool {
	scope := c.AI.Scope
	if scope == "" || scope == "inherit" {
		scope = c.Scope.Scope
	}
	if scope == "all" {
		return true
	}
	for _, matcher := range c.Scope.SafeTools {
		if approvalMatcher(matcher, name, args) {
			return false
		}
	}
	return !(c.Scope.AutoAllowReadOnly == nil || *c.Scope.AutoAllowReadOnly) || !approvalReadOnlyTool(name)
}

type automationApprovalBypassKey struct{}
type automationApprovalBypass struct{ tenant, agent, session, run string }

func (s *Service) effectiveApprovalConfig(ctx context.Context, a Agent, session, run, fallback string) (toolApprovalConfig, error) {
	cfg, err := parseApprovalConfig(a.Config, fallback)
	if err != nil {
		return cfg, err
	}
	space, err := s.store.GetSpace(ctx, a.TenantID, a.SpaceID)
	if err != nil {
		return cfg, err
	}
	cfg.Scope, err = parseApprovalScope(space.Config)
	if bypass, ok := ctx.Value(automationApprovalBypassKey{}).(automationApprovalBypass); ok {
		cfg.BypassAlwaysAsk = bypass == (automationApprovalBypass{a.TenantID, a.ID, session, run}) && run != ""
	}
	return cfg, err
}

func (h *handler) spaceApprovalConfig(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "id")
	if p.APIKey && (p.AgentID != "" || p.SpaceID != "" && p.SpaceID != id) {
		httpx.Error(w, http.StatusForbidden, "Space access denied")
		return
	}
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, id, ""); err != nil {
		statusErr(w, err)
		return
	}
	space, err := h.store.GetSpace(r.Context(), p.TenantID, id)
	if err != nil {
		statusErr(w, err)
		return
	}
	cfg, err := parseApprovalScope(space.Config)
	if r.Method == http.MethodPut {
		var patch map[string]any
		if httpx.DecodeJSON(r, &patch) != nil || patch == nil {
			httpx.Error(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		for key := range patch {
			if key != "scope" && key != "autoAllowReadOnly" && key != "safeTools" && key != "dangerousTools" {
				httpx.Error(w, http.StatusBadRequest, "unsupported approval setting")
				return
			}
		}
		_, err = h.store.mutateSpaceConfig(r.Context(), p.TenantID, id, func(current map[string]any) error {
			mergeConfigPatch(current, map[string]any{"approvals": patch})
			var validation error
			cfg, validation = parseApprovalScope(rawJSON(current))
			return validation
		})
	}
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, cfg)
}
