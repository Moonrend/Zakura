package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/apps/server/internal/integrations"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/admin"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/config"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/identity"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/rediscache"
	platformsystem "github.com/Moonrend/Zakura/apps/server/internal/platform/system"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/usage"
	"github.com/Moonrend/Zakura/apps/server/internal/runtime"
)

func Router(cfg config.Config, d *appdeps.Dependencies, log *slog.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(httpx.Recoverer(log))
	r.Use(httpx.SecurityHeaders)
	r.Use(httpx.CORS(cfg.WebURL))
	r.Use(httpx.RequestLog(log))
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"name": "Zakura", "backend": "go", "version": "go-rewrite"})
	})
	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := d.DB.PingContext(ctx); err != nil {
			httpx.JSON(w, 503, map[string]any{"ok": false, "database": "unavailable"})
			return
		}
		if d.OAuthPublicKey == nil {
			httpx.JSON(w, 503, map[string]any{"ok": false, "database": "ready", "oauthSigningKey": "unavailable"})
			return
		}
		if _, err := d.OAuthPublicKey(ctx); err != nil {
			httpx.JSON(w, 503, map[string]any{"ok": false, "database": "ready", "oauthSigningKey": "unavailable"})
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "database": "ready", "oauthSigningKey": "ready"})
	})
	r.Get("/api/livez", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, map[string]bool{"ok": true}) })
	d.Redis = rediscache.Open(d.RunContext(), rediscache.URLFromSettings(d.RunContext(), d.Gorm, d.Secret))
	identity.RegisterRoutes(r, d)
	admin.RegisterRoutes(r, d)
	usage.RegisterRoutes(r, d)
	platformsystem.RegisterRoutes(r, d)
	runtime.RegisterRoutes(r, d)
	integrations.RegisterRoutes(r, d)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { httpx.Error(w, 404, "not found") })
	return r
}

func NewDependencies(cfg config.Config, db *sql.DB, dialect string, rebind func(string) string, gormDB *gorm.DB) *appdeps.Dependencies {
	d := &appdeps.Dependencies{DB: db, Gorm: gormDB, Dialect: dialect, Rebind: rebind, Clock: time.Now, NewID: newID, Secret: []byte(cfg.Secret), PublicURL: cfg.PublicURL, WebURL: cfg.WebURL, DataDir: cfg.DataDir, Edition: cfg.Edition, MultiTenant: cfg.MultiTenant, VerifyDomain: VerifyDNSDomain}
	d.OnTenantCreated = func(ctx context.Context, tenantID string) {
		_ = admin.SyncManagedWebDefaultsForTenant(ctx, d, tenantID)
	}
	return d
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}
