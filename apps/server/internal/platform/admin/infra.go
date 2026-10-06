package admin

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

const redisURLSettingKey = "infra.redis_url"

func (a *routes) getRedisInfra(w http.ResponseWriter, r *http.Request) {
	raw, err := a.readSetting(r.Context(), redisURLSettingKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		httpx.JSON(w, 200, map[string]any{"configured": false})
		return
	}
	plain, err := openAdmin(a.d.Secret, raw)
	if err != nil {
		httpx.JSON(w, 200, map[string]any{"configured": true, "url": "<configured>"})
		return
	}
	httpx.JSON(w, 200, map[string]any{"configured": true, "url": maskRedisURL(plain)})
}

func (a *routes) putRedisInfra(w http.ResponseWriter, r *http.Request) {
	var b struct {
		URL string `json:"url"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	raw := strings.TrimSpace(b.URL)
	if raw == "" {
		if err := a.d.Gorm.WithContext(r.Context()).Where("owner_key='platform' AND key=?", redisURLSettingKey).Delete(&models.Setting{}).Error; err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"configured": false})
		return
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "redis" && parsed.Scheme != "rediss") {
		httpx.Error(w, 400, "invalid redis url")
		return
	}
	sealed, err := sealAdmin(a.d.Secret, []byte(raw))
	if err != nil {
		httpx.Error(w, 500, "encryption failed")
		return
	}
	if err := a.writeSetting(r.Context(), redisURLSettingKey, sealed); err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"configured": true, "url": maskRedisURL(raw)})
}

func maskRedisURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "<configured>"
	}
	if parsed.User == nil {
		return parsed.String()
	}
	if _, hasPassword := parsed.User.Password(); !hasPassword {
		return parsed.String()
	}
	scheme := parsed.Scheme + "://"
	rest := strings.TrimPrefix(parsed.String(), scheme)
	if at := strings.Index(rest, "@"); at >= 0 {
		rest = rest[at+1:]
	}
	return scheme + url.User(parsed.User.Username()).String() + ":****@" + rest
}
