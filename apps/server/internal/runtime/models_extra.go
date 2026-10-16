// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func validModelCapability(capability string) bool {
	switch capability {
	case "chat", "embedding", "rerank", "image":
		return true
	}
	return false
}

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
		oldEnvelope := ""
		if cur, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id")); e == nil {
			var curCfg map[string]any
			if json.Unmarshal(cur.Config, &curCfg) == nil {
				oldEnvelope, _ = curCfg["credentialEnc"].(string)
			}
		}
		if e := protectModelConfig(h.deps.Secret, principal(r).TenantID, chi.URLParam(r, "id"), cfg, oldEnvelope); e != nil {
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
	args = append(args, runtimeTimeString(h.store.now()), principal(r).TenantID, chi.URLParam(r, "id"))
	res := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE model_upstreams SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	u, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	mc := map[string]any{"removed": 0}
	list, err := h.fetchUpstreamModelList(r.Context(), principal(r).TenantID, u)
	if err != nil {
		mc["status"] = "unhealthy"
		mc["liveModels"] = 0
		mc["message"] = err.Error()
	} else if len(list) == 0 {
		mc["status"] = "empty"
		mc["liveModels"] = 0
	} else {
		mc["status"] = "healthy"
		mc["liveModels"] = len(list)
	}
	var resp map[string]any
	if e := json.Unmarshal(rawJSON(redactUpstream(u)), &resp); e != nil {
		statusErr(w, e)
		return
	}
	resp["modelCheck"] = mc
	httpx.JSON(w, 200, resp)
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
	args = append(args, runtimeTimeString(h.store.now()), principal(r).TenantID, chi.URLParam(r, "id"))
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

func (h *handler) loadModelRouteForTenant(ctx context.Context, tenant, id string) (ModelRoute, error) {
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
	e := h.deps.Gorm.WithContext(ctx).Table("model_routes").Select("id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at").Where("tenant_id=? AND id=?", tenant, id).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return ModelRoute{}, ErrNotFound
	}
	if e != nil {
		return ModelRoute{}, e
	}
	x := ModelRoute{ID: row.ID, Name: row.Name, Slug: row.Slug, Capability: row.Capability, Alias: row.Alias, UpstreamID: row.UpstreamID, Model: row.Model, Options: json.RawMessage(row.Options), IsDefault: row.IsDefault, Status: row.Status, LastError: row.LastError, CreatedAt: parseTime(row.CreatedAt), UpdatedAt: parseTime(row.UpdatedAt)}
	x.Priority, _ = strconv.Atoi(row.Priority)
	x.Weight, _ = strconv.Atoi(row.Weight)
	return x, nil
}

func (h *handler) setDefaultModelRoute(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Capability string `json:"capability"`
		ModelID    string `json:"modelId"`
		UpstreamID string `json:"upstreamId"`
		RouteID    string `json:"routeId"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	tenant := principal(r).TenantID
	capability := strings.TrimSpace(b.Capability)
	if capability == "" {
		capability = "chat"
	}
	if !validModelCapability(capability) {
		httpx.Error(w, 400, "unsupported capability")
		return
	}
	modelID := strings.TrimSpace(b.ModelID)
	routeID := strings.TrimSpace(b.RouteID)
	upstreamID := strings.TrimSpace(b.UpstreamID)
	if modelID == "" {
		httpx.Error(w, 400, "modelId required")
		return
	}
	now := h.store.now()
	targetID := ""
	e := h.deps.Gorm.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if routeID != "" {
			var count int64
			if e := tx.Table("model_routes").Where("tenant_id=? AND id=? AND capability=?", tenant, routeID, capability).Count(&count).Error; e != nil {
				return e
			}
			if count == 0 {
				return ErrNotFound
			}
			targetID = routeID
		} else {
			var row struct {
				ID string `gorm:"column:id"`
			}
			e := tx.Table("model_routes").Select("id").Where("tenant_id=? AND capability=? AND (alias=? OR model=?)", tenant, capability, modelID, modelID).Order("is_default DESC, CAST(priority AS INTEGER), id").Take(&row).Error
			if e == nil {
				targetID = row.ID
			} else if !errors.Is(e, gorm.ErrRecordNotFound) {
				return e
			}
		}
		if targetID == "" {
			if upstreamID == "" {
				return ErrNotFound
			}
			var upCount int64
			if e := tx.Table("model_upstreams").Where("tenant_id=? AND id=?", tenant, upstreamID).Count(&upCount).Error; e != nil {
				return e
			}
			if upCount == 0 {
				return ErrNotFound
			}
			var modelCount int64
			if e := tx.Table("upstream_models").Where("tenant_id=? AND upstream_id=? AND (native_model=? OR canonical_model=?)", tenant, upstreamID, modelID, modelID).Count(&modelCount).Error; e != nil {
				return e
			}
			if modelCount == 0 {
				return ErrNotFound
			}
			targetID = h.store.id()
			slug := slugify(modelID + "-" + capability)
			if slug == "" {
				slug = "model"
			}
			if e := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant_id"}, {Name: "slug"}}, DoNothing: true}).Table("model_routes").Create(map[string]any{"id": targetID, "tenant_id": tenant, "name": modelID, "slug": slug, "capability": capability, "alias": modelID, "upstream_id": upstreamID, "model": modelID, "options_json": "{}", "priority": "100", "weight": "100", "is_default": false, "status": "ready", "last_error": nil, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)}).Error; e != nil {
				return e
			}
			var created int64
			if e := tx.Table("model_routes").Where("tenant_id=? AND id=?", tenant, targetID).Count(&created).Error; e != nil {
				return e
			}
			if created == 0 {
				var row struct {
					ID string `gorm:"column:id"`
				}
				if e := tx.Table("model_routes").Select("id").Where("tenant_id=? AND capability=? AND (alias=? OR model=?)", tenant, capability, modelID, modelID).Take(&row).Error; e != nil {
					return ErrNotFound
				}
				targetID = row.ID
			}
		}
		if e := tx.Table("model_routes").Where("tenant_id=? AND capability=?", tenant, capability).Update("is_default", false).Error; e != nil {
			return e
		}
		return tx.Table("model_routes").Where("tenant_id=? AND id=?", tenant, targetID).Updates(map[string]any{"is_default": true, "updated_at": runtimeTimeString(now)}).Error
	})
	if e != nil {
		statusErr(w, e)
		return
	}
	dto, e := h.loadModelRouteForTenant(r.Context(), tenant, targetID)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, dto)
}
