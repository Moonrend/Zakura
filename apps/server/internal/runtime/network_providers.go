// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"io"
	"net/http"
)

type exposureProviderSpec struct {
	Provider       string
	Name           string
	Description    string
	RequiresConfig bool
	PublicExposure bool
}

var exposureProviderRegistry = []exposureProviderSpec{
	{Provider: "cloudflare-named", Name: "Cloudflare Tunnel", Description: "使用 Cloudflare API 创建/管理 Named Tunnel（cloudflared）", RequiresConfig: true, PublicExposure: true},
	{Provider: "ngrok", Name: "ngrok", Description: "使用 ngrok authtoken 快速暴露公网端口", RequiresConfig: true, PublicExposure: true},
	{Provider: "frp", Name: "FRP", Description: "连接自建 frp server 进行端口转发", RequiresConfig: true, PublicExposure: true},
}

func (h *handler) tunnelProviderConfig(tenantID, provider, configEnc string) map[string]any {
	cfg := map[string]any{}
	if raw, e := openSecretBox(h.deps.Secret, "tunnel:"+tenantID+":"+provider, configEnc); e == nil {
		if json.Unmarshal(raw, &cfg) == nil {
			return cfg
		}
	}
	cfg = map[string]any{}
	_ = json.Unmarshal([]byte(configEnc), &cfg)
	if cfg == nil {
		cfg = map[string]any{}
	}
	return cfg
}

func (h *handler) testProviderFallback(r *http.Request, provider string, cfg map[string]any) (bool, string) {
	switch provider {
	case "cloudflare-named":
		if v, _ := cfg["tunnelToken"].(string); v != "" {
			return true, "Tunnel Token 已配置"
		}
		apiToken, _ := cfg["apiToken"].(string)
		account, _ := cfg["accountId"].(string)
		if apiToken != "" && account != "" {
			return h.verifyCloudflareToken(r, apiToken)
		}
		return false, "未配置"
	case "ngrok":
		if v, _ := cfg["authtoken"].(string); v != "" {
			return true, "Authtoken 已配置"
		}
		return false, "未配置"
	case "frp":
		if v, _ := cfg["server"].(string); v != "" {
			return true, "Server 已配置"
		}
		return false, "未配置"
	}
	return false, "未配置"
}

func (h *handler) verifyCloudflareToken(r *http.Request, apiToken string) (bool, string) {
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.cloudflare.com/client/v4/user/tokens/verify", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		return false, "API Token 验证失败"
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var out struct {
		Success bool `json:"success"`
	}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && out.Success {
		return true, "API Token 验证通过"
	}
	return false, "API Token 验证失败"
}
