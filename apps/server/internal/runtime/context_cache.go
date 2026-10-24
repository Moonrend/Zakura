// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"sync"
)

type contextCacheKey struct{}
type contextCache struct {
	mu    sync.Mutex
	key   string
	route string
}

func withContextCache(ctx context.Context, tenant, session string) context.Context {
	sum := sha256.Sum256([]byte(tenant + "\x00" + session))
	return context.WithValue(ctx, contextCacheKey{}, &contextCache{key: hex.EncodeToString(sum[:])})
}

// Apply only to native agent calls, never rewrite an external gateway client's
// explicit caching policy. Breakpoints preserve the static prefix on compaction.
func applyContextCache(ctx context.Context, protocol string, body map[string]any) {
	cache, _ := ctx.Value(contextCacheKey{}).(*contextCache)
	if cache == nil {
		return
	}
	if !isAnthropicProtocol(protocol) {
		// OpenAI-compatible deployments need not support optional cache parameters.
		// Exact append-only prefixes work without sending vendor-specific fields.
		return
	}
	if system, ok := body["system"].(string); ok && system != "" {
		body["system"] = []any{map[string]any{"type": "text", "text": system, "cache_control": map[string]any{"type": "ephemeral"}}}
	}
	// Keep the previous request's final user boundary as well as the new assistant
	// and tool-result boundaries. A large assistant/tool batch can exceed the
	// provider's lookback. Together with system this uses at most four breakpoints.
	messages := gwSlice(body["messages"])
	marked := 0
	for i := len(messages) - 1; i >= 0 && marked < 3; i-- {
		blocks := gwSlice(gwMap(messages[i])["content"])
		for j := len(blocks) - 1; j >= 0; j-- {
			b := gwMap(blocks[j])
			if b == nil || b["type"] == "thinking" {
				continue
			}
			b["cache_control"] = map[string]any{"type": "ephemeral"}
			marked++
			break
		}
	}
}

func preferContextRoute(ctx context.Context, candidates []ModelCandidate) {
	cache, _ := ctx.Value(contextCacheKey{}).(*contextCache)
	if cache == nil {
		return
	}
	cache.mu.Lock()
	route := cache.route
	cache.mu.Unlock()
	for i, c := range candidates {
		if c.Route.ID == route {
			copy(candidates[1:i+1], candidates[:i])
			candidates[0] = c
			return
		}
	}
	// Deterministic affinity survives a new run or a process restart. Keep the
	// priority tier and configured weights, and retain every failover candidate.
	if len(candidates) < 2 {
		return
	}
	// resolveCandidates randomizes the first candidate, so sort before hashing.
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i].Route, candidates[j].Route
		if a.IsDefault != b.IsDefault {
			return a.IsDefault
		}
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		return a.ID < b.ID
	})
	best, total := candidates[0].Route, 0
	for _, c := range candidates {
		if c.Route.IsDefault != best.IsDefault || c.Route.Priority != best.Priority {
			break
		}
		total += max(0, c.Route.Weight)
	}
	if total == 0 {
		return
	}
	sum := sha256.Sum256([]byte(cache.key))
	draw := 0
	for _, b := range sum[:4] {
		draw = (draw*256 + int(b)) % total
	}
	for i, c := range candidates {
		if c.Route.IsDefault != best.IsDefault || c.Route.Priority != best.Priority {
			break
		}
		draw -= max(0, c.Route.Weight)
		if draw < 0 {
			copy(candidates[1:i+1], candidates[:i])
			candidates[0] = c
			return
		}
	}
}

func rememberContextRoute(ctx context.Context, route string) {
	cache, _ := ctx.Value(contextCacheKey{}).(*contextCache)
	if cache == nil {
		return
	}
	cache.mu.Lock()
	cache.route = route
	cache.mu.Unlock()
}
