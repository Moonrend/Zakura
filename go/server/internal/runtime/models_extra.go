// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func (h *handler) patchUpstream(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "slug": "slug", "protocol": "protocol", "status": "status"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["config"]; ok {
		cfg, _ := v.(map[string]any)
		if cfg == nil {
			httpx.Error(w, 400, "config must be an object")
			return
		}
		if e := protectModelConfig(h.deps.Secret, principal(r).TenantID, chi.URLParam(r, "id"), cfg); e != nil {
			statusErr(w, e)
			return
		}
		b, _ := json.Marshal(cfg)
		sets = append(sets, "config_json=?")
		args = append(args, string(b))
	}
	if len(sets) == 0 {
		h.getUpstream(w, r)
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	res := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE model_upstreams SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getUpstream(w, r)
}
func (h *handler) getModelRoute(w http.ResponseWriter, r *http.Request) {
	var row struct {
		ID         string  `gorm:"column:id"`
		Name       string  `gorm:"column:name"`
		Slug       string  `gorm:"column:slug"`
		Capability string  `gorm:"column:capability"`
		Alias      *string `gorm:"column:alias"`
		UpstreamID string  `gorm:"column:upstream_id"`
		Model      string  `gorm:"column:model"`
		Options    string  `gorm:"column:options_json"`
		Priority   string  `gorm:"column:priority"`
		Weight     string  `gorm:"column:weight"`
		IsDefault  bool    `gorm:"column:is_default"`
		Status     string  `gorm:"column:status"`
		LastError  *string `gorm:"column:last_error"`
		CreatedAt  string  `gorm:"column:created_at"`
		UpdatedAt  string  `gorm:"column:updated_at"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("model_routes").Select("id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at").Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	x := ModelRoute{ID: row.ID, Name: row.Name, Slug: row.Slug, Capability: row.Capability, Alias: row.Alias, UpstreamID: row.UpstreamID, Model: row.Model, Options: json.RawMessage(row.Options), IsDefault: row.IsDefault, Status: row.Status, LastError: row.LastError, CreatedAt: parseTime(row.CreatedAt), UpdatedAt: parseTime(row.UpdatedAt)}
	x.Priority, _ = strconv.Atoi(row.Priority)
	x.Weight, _ = strconv.Atoi(row.Weight)
	httpx.JSON(w, 200, x)
}
func (h *handler) patchModelRoute(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "slug": "slug", "capability": "capability", "alias": "alias", "upstreamId": "upstream_id", "model": "model", "priority": "priority", "weight": "weight", "isDefault": "is_default", "status": "status"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["options"]; ok {
		b, _ := json.Marshal(v)
		sets = append(sets, "options_json=?")
		args = append(args, string(b))
	}
	if len(sets) == 0 {
		h.getModelRoute(w, r)
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	res := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE model_routes SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getModelRoute(w, r)
}
