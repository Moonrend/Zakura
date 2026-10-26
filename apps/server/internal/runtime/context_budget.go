// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"unicode"
)

type contextBudget struct{ Window, Output, Reserve, Trigger, Target int }

func (s *Service) turnModel(ctx context.Context, tenant string, agent Agent, space Space, sess Session) (string, error) {
	cloud, base := parseCloudConfig(agent.Config), parseCloudConfig(space.Config)
	model, route := base.Model, base.ModelRouteID
	if cloud.ModelRouteID != "" || cloud.Model != "" {
		model, route = cloud.Model, cloud.ModelRouteID
	}
	if sess.Model != nil && *sess.Model != "" {
		model, route = *sess.Model, ""
	}
	if sess.ModelRouteID != nil && *sess.ModelRouteID != "" {
		route = *sess.ModelRouteID
	}
	if route != "" {
		routes, err := s.store.ListRoutes(ctx, tenant, "chat")
		if err != nil {
			return "", err
		}
		for _, r := range routes {
			if r.ID == route && r.Status == "ready" {
				return r.ID, nil
			}
		}
		return "", errors.New("selected model route is unavailable")
	}
	return model, nil
}

func (s *Service) contextPolicy(ctx context.Context, tenant, model string) (contextBudget, error) {
	candidates, err := s.gateway.resolveCandidates(ctx, tenant, "chat", model)
	if err != nil {
		return contextBudget{}, err
	}
	window, output := 0, 0
	for _, c := range candidates {
		var row struct {
			MetaJSON    string `gorm:"column:meta_json"`
			OptionsJSON string `gorm:"column:options_json"`
		}
		err = s.store.deps.Gorm.WithContext(ctx).Table("upstream_models").Select("meta_json, options_json").Where("tenant_id=? AND upstream_id=? AND native_model=? AND capability='chat'", tenant, c.Route.UpstreamID, c.Route.Model).Limit(1).Scan(&row).Error
		if err != nil {
			return contextBudget{}, err
		}
		meta := gatewayModelMetadata(c.Route, row.MetaJSON, row.OptionsJSON)
		w, o := gwInt(meta["contextLimit"]), gwInt(meta["outputLimit"])
		// Unknown deployments use a conservative input window; known capacities
		// come from inventory. Budget against every eligible failover deployment.
		if w <= 0 {
			w = 32000
		}
		if o <= 0 {
			o = 4096
		}
		if window == 0 || w < window {
			window = w
		}
		if output == 0 || o < output {
			output = o
		}
	}
	output = min(output, min(8192, max(1, window/8)))
	reserve := min(max(1024, window/20), max(1, window/4))
	usable := window - output - reserve
	if usable < 128 {
		return contextBudget{}, errors.New("model context window is too small for agent requests")
	}
	return contextBudget{Window: window, Output: output, Reserve: reserve, Trigger: usable * 85 / 100, Target: usable * 35 / 100}, nil
}

// A local estimate is only a fallback. CJK and other non-ASCII text need more
// tokens than English; provider usage calibrates growth during the live run.
func estimateTextTokens(text string) int {
	ascii, other := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hangul, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) {
			other++
		} else {
			other += 2
		}
	}
	return (ascii+2)/3 + other
}

func estimatePayloadTokens(payload map[string]any) int {
	total := 0
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case string:
			total += estimateTextTokens(v)
		case []any:
			for _, x := range v {
				visit(x)
			}
		case []map[string]any:
			for _, x := range v {
				visit(x)
			}
		case []string:
			for _, x := range v {
				visit(x)
			}
		case json.RawMessage:
			var decoded any
			if json.Unmarshal(v, &decoded) == nil {
				visit(decoded)
			}
		case map[string]any:
			if v["type"] == "image_url" || v["type"] == "input_image" || v["type"] == "image" {
				total += 4096
				return
			}
			for key, x := range v {
				total += estimateTextTokens(key) + 1
				visit(x)
			}
		}
	}
	visit(payload["messages"])
	visit(payload["tools"])
	return total + 16
}

func estimateMessageTokens(m chatMessage) int {
	raw, _ := json.Marshal(m.ToolCalls)
	return 8 + estimateTextTokens(m.Content) + estimateTextTokens(string(raw)) + 4096*len(m.Images)
}
