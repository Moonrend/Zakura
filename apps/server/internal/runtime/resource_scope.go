// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// Bound keys may enter only explicitly scoped resource routes. Tenant-wide
// management endpoints require an unbound credential; collections filter below.
func (h *handler) resourceScopeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		if !p.APIKey || p.AgentID == "" && p.SpaceID == "" {
			next.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
		if len(parts) < 2 || parts[0] != "api" {
			httpx.Error(w, http.StatusForbidden, "resource scope denied")
			return
		}
		if len(parts) == 2 && (parts[1] == "agents" || parts[1] == "spaces") && r.Method == http.MethodGet {
			next.ServeHTTP(w, r)
			return
		}
		if len(parts) < 3 || parts[1] != "agents" && parts[1] != "spaces" {
			httpx.Error(w, http.StatusForbidden, "resource scope denied")
			return
		}
		id, err := url.PathUnescape(parts[2])
		space, agent := "", ""
		if parts[1] == "agents" {
			agent = id
		} else {
			space = id
		}
		if err != nil || strings.Contains(id, "/") || httpx.AuthorizeResource(r.Context(), h.deps, p, space, agent) != nil {
			httpx.Error(w, http.StatusNotFound, "Not found")
			return
		}
		next.ServeHTTP(w, r)
	})
}
