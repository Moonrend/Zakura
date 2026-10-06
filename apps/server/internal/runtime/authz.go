// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func apiKeyScopeAllows(p httpx.Principal, required ...string) bool {
	return APIKeyScopeAllows(p, required...)
}

// APIKeyScopeAllows is shared with native integration handlers so a key whose
// capabilities are intentionally limited cannot fall through to the general API.
func APIKeyScopeAllows(p httpx.Principal, required ...string) bool {
	if !p.APIKey {
		return true
	}
	var scopes []string
	if json.Unmarshal([]byte(p.APIKeyScopes), &scopes) != nil {
		return false
	}
	for _, scope := range scopes {
		scope = strings.TrimSpace(scope)
		if scope == "*" {
			return true
		}
		for _, candidate := range required {
			if scope == candidate {
				return true
			}
		}
	}
	return false
}

func RequireAPIScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := httpx.PrincipalFrom(r.Context())
		if p.APIKey && !APIKeyScopeAllows(p, "api") {
			httpx.Error(w, http.StatusForbidden, "insufficient_scope")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func gatewayPrincipalAllowed(p httpx.Principal) bool {
	return p.APIKey && p.AgentID != "" && apiKeyScopeAllows(p, "gateway", "gateway:models", "gateway:chat")
}
