// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm/clause"
)

type UpstreamModel struct {
	ID             string          `json:"id"`
	UpstreamID     string          `json:"upstreamId"`
	NativeModel    string          `json:"nativeModel"`
	CanonicalModel string          `json:"canonicalModel"`
	DisplayName    *string         `json:"displayName"`
	Capability     string          `json:"capability"`
	Weight         float64         `json:"weight"`
	IsDefault      bool            `json:"isDefault"`
	Options        json.RawMessage `json:"options"`
	Meta           json.RawMessage `json:"meta"`
	Status         string          `json:"status"`
	LastError      *string         `json:"lastError"`
	SyncedAt       *string         `json:"syncedAt"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

type remoteModel struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	OwnedBy    string `json:"ownedBy,omitempty"`
	Capability string `json:"capability,omitempty"`
}

type modelItem struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Model        string `json:"model"`
	ModelID      string `json:"modelId"`
	DisplayName  string `json:"display_name"`
	OwnedBySnake string `json:"owned_by"`
	OwnedByCamel string `json:"ownedBy"`
}

func (h *handler) fetchUpstreamModelList(ctx context.Context, tenant string, u Upstream) ([]remoteModel, error) {
	var cfg upstreamConfig
	if e := json.Unmarshal(u.Config, &cfg); e != nil {
		return nil, fmt.Errorf("invalid upstream config: %w", e)
	}
	if cfg.CredentialEnc != "" {
		if raw, e := openSecretBox(h.store.deps.Secret, "model:"+tenant+":"+u.ID, cfg.CredentialEnc); e == nil {
			var credentials map[string]any
			if json.Unmarshal(raw, &credentials) == nil {
				if v, ok := credentials["apiKey"].(string); ok {
					cfg.APIKey = v
				}
				if v, ok := credentials["accessToken"].(string); ok {
					cfg.AccessToken = v
				}
			}
		}
	}
	if cfg.APIKey == "" {
		cfg.APIKey = cfg.AccessToken
	}
	if cfg.BaseURL == "" {
		return nil, errors.New("baseUrl not configured")
	}
	target, e := safeProviderURL(cfg.BaseURL, "/v1/models")
	if e != nil {
		return nil, e
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if e != nil {
		return nil, e
	}
	if cfg.APIKey != "" {
		if u.Protocol == "anthropic" {
			req.Header.Set("x-api-key", cfg.APIKey)
			req.Header.Set("anthropic-version", "2023-06-01")
		} else {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
	}
	for k, v := range cfg.Headers {
		if http.CanonicalHeaderKey(k) != "Host" {
			req.Header.Set(k, v)
		}
	}
	client := h.service.gateway.client
	if cfg.Timeout > 0 {
		clone := *client
		clone.Timeout = time.Duration(cfg.Timeout) * time.Millisecond
		client = &clone
	}
	resp, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if e != nil {
		return nil, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("model list status %d: %.300s", resp.StatusCode, raw)
	}
	var items []modelItem
	if e := json.Unmarshal(raw, &items); e != nil {
		var result struct {
			Data   []modelItem `json:"data"`
			Models []modelItem `json:"models"`
		}
		if e := json.Unmarshal(raw, &result); e != nil {
			return nil, errors.New("invalid model catalog")
		}
		if len(result.Data) > 0 {
			items = result.Data
		} else {
			items = result.Models
		}
	}
	out := make([]remoteModel, 0, len(items))
	for _, m := range items {
		id := firstNonEmpty(m.ID, m.Name, m.Model, m.ModelID)
		if id == "" {
			continue
		}
		rm := remoteModel{ID: id, Capability: "chat"}
		if m.Name != "" && m.Name != id {
			rm.Name = m.Name
		} else if m.DisplayName != "" && m.DisplayName != id {
			rm.Name = m.DisplayName
		}
		if m.OwnedBySnake != "" {
			rm.OwnedBy = m.OwnedBySnake
		} else {
			rm.OwnedBy = m.OwnedByCamel
		}
		out = append(out, rm)
	}
	return out, nil
}

func (h *handler) queryUpstreamModels(r *http.Request, upstream string) ([]UpstreamModel, error) {
	q := h.deps.Gorm.WithContext(r.Context()).Table("upstream_models").Select("id,upstream_id,native_model,canonical_model,display_name,capability,weight,is_default,options_json,meta_json,status,last_error,synced_at,created_at,updated_at").Where("tenant_id=?", principal(r).TenantID)
	if upstream != "" {
		q = q.Where("upstream_id=?", upstream)
	}
	var rows []struct {
		ID             string  `gorm:"column:id"`
		UpstreamID     string  `gorm:"column:upstream_id"`
		NativeModel    string  `gorm:"column:native_model"`
		CanonicalModel string  `gorm:"column:canonical_model"`
		DisplayName    *string `gorm:"column:display_name"`
		Capability     string  `gorm:"column:capability"`
		Weight         string  `gorm:"column:weight"`
		IsDefault      bool    `gorm:"column:is_default"`
		OptionsJSON    string  `gorm:"column:options_json"`
		MetaJSON       string  `gorm:"column:meta_json"`
		Status         string  `gorm:"column:status"`
		LastError      *string `gorm:"column:last_error"`
		SyncedAt       *string `gorm:"column:synced_at"`
		CreatedAt      string  `gorm:"column:created_at"`
		UpdatedAt      string  `gorm:"column:updated_at"`
	}
	if e := q.Order("canonical_model,native_model").Find(&rows).Error; e != nil {
		return nil, e
	}
	out := make([]UpstreamModel, 0, len(rows))
	for _, row := range rows {
		weight, _ := strconv.ParseFloat(row.Weight, 64)
		out = append(out, UpstreamModel{ID: row.ID, UpstreamID: row.UpstreamID, NativeModel: row.NativeModel, CanonicalModel: row.CanonicalModel, DisplayName: row.DisplayName, Capability: row.Capability, Weight: weight, IsDefault: row.IsDefault, Options: json.RawMessage(row.OptionsJSON), Meta: json.RawMessage(row.MetaJSON), Status: row.Status, LastError: row.LastError, SyncedAt: row.SyncedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
	}
	return out, nil
}
func (h *handler) listUpstreamModels(w http.ResponseWriter, r *http.Request) {
	x, e := h.queryUpstreamModels(r, r.URL.Query().Get("upstreamId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"models": x, "capabilities": []map[string]any{{"id": "chat", "name": "Chat"}, {"id": "embedding", "name": "Embedding"}, {"id": "rerank", "name": "Rerank"}, {"id": "image", "name": "Image"}}})
}
func (h *handler) modelsForUpstream(w http.ResponseWriter, r *http.Request) {
	u, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	list, e := h.fetchUpstreamModelList(r.Context(), principal(r).TenantID, u)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"models": list})
}
func (h *handler) createUpstreamModel(w http.ResponseWriter, r *http.Request) {
	var x UpstreamModel
	if httpx.DecodeJSON(r, &x) != nil || x.UpstreamID == "" || x.NativeModel == "" {
		httpx.Error(w, 400, "upstreamId and nativeModel required")
		return
	}
	if _, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, x.UpstreamID); e != nil {
		statusErr(w, e)
		return
	}
	if x.CanonicalModel == "" {
		x.CanonicalModel = x.NativeModel
	}
	if x.Capability == "" {
		x.Capability = "chat"
	}
	if x.Weight == 0 {
		x.Weight = 100
	}
	if x.Status == "" {
		x.Status = "ready"
	}
	now := runtimeTimeString(h.store.now())
	x.ID = h.store.id()
	e := h.deps.Gorm.WithContext(r.Context()).Table("upstream_models").Create(map[string]any{"id": x.ID, "tenant_id": principal(r).TenantID, "upstream_id": x.UpstreamID, "native_model": x.NativeModel, "canonical_model": x.CanonicalModel, "display_name": x.DisplayName, "capability": x.Capability, "weight": strconv.FormatFloat(x.Weight, 'f', -1, 64), "is_default": x.IsDefault, "options_json": validJSON(x.Options, "{}"), "meta_json": validJSON(x.Meta, "{}"), "status": x.Status, "last_error": nil, "synced_at": now, "created_at": now, "updated_at": now}).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, x)
}
func (h *handler) patchUpstreamModel(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"nativeModel": "native_model", "canonicalModel": "canonical_model", "displayName": "display_name", "capability": "capability", "weight": "weight", "isDefault": "is_default", "status": "status"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	for k, col := range map[string]string{"options": "options_json", "meta": "meta_json"} {
		if v, ok := m[k]; ok {
			b, _ := json.Marshal(v)
			sets = append(sets, col+"=?")
			args = append(args, string(b))
		}
	}
	if len(sets) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, runtimeTimeString(h.store.now()), principal(r).TenantID, chi.URLParam(r, "id"))
	res := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE upstream_models SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`, args...)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	models, e := h.queryUpstreamModels(r, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	for _, model := range models {
		if model.ID == chi.URLParam(r, "id") {
			httpx.JSON(w, http.StatusOK, model)
			return
		}
	}
	statusErr(w, ErrNotFound)
}
func (h *handler) deleteUpstreamModel(w http.ResponseWriter, r *http.Request) {
	res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND id=?", principal(r).TenantID, chi.URLParam(r, "id")).Delete(&models.UpstreamModel{})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func decodeIDs(r *http.Request) ([]string, error) {
	var b struct {
		IDs []string `json:"ids"`
	}
	e := httpx.DecodeJSON(r, &b)
	return b.IDs, e
}
func (h *handler) batchDeleteUpstreamModels(w http.ResponseWriter, r *http.Request) {
	ids, e := decodeIDs(r)
	if e != nil || len(ids) == 0 {
		httpx.Error(w, 400, "ids required")
		return
	}
	n := int64(0)
	for _, id := range ids {
		res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND id=?", principal(r).TenantID, id).Delete(&models.UpstreamModel{})
		if res.Error != nil {
			statusErr(w, res.Error)
			return
		}
		n += res.RowsAffected
	}
	httpx.JSON(w, 200, map[string]any{"deleted": n})
}
func (h *handler) batchDeleteUpstreams(w http.ResponseWriter, r *http.Request) {
	ids, e := decodeIDs(r)
	if e != nil || len(ids) == 0 {
		httpx.Error(w, 400, "ids required")
		return
	}
	n := int64(0)
	for _, id := range ids {
		res := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND id=?", principal(r).TenantID, id).Delete(&models.ModelUpstream{})
		if res.Error != nil {
			statusErr(w, res.Error)
			return
		}
		n += res.RowsAffected
	}
	httpx.JSON(w, 200, map[string]any{"deleted": n})
}
func (h *handler) syncUpstreamModels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ModelIDs []string `json:"modelIds"`
	}
	_ = httpx.DecodeJSON(r, &body)
	tenant := principal(r).TenantID
	id := chi.URLParam(r, "id")
	u, e := h.store.GetUpstream(r.Context(), tenant, id)
	if e != nil {
		statusErr(w, e)
		return
	}
	list, e := h.fetchUpstreamModelList(r.Context(), tenant, u)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	found := map[string]bool{}
	for _, m := range list {
		found[m.ID] = true
	}
	targets := list
	unmatched := []map[string]any{}
	if body.ModelIDs != nil {
		want := map[string]bool{}
		for _, mid := range body.ModelIDs {
			want[mid] = true
		}
		targets = make([]remoteModel, 0, len(body.ModelIDs))
		for _, m := range list {
			if want[m.ID] {
				targets = append(targets, m)
			}
		}
		for _, mid := range body.ModelIDs {
			if !found[mid] {
				unmatched = append(unmatched, map[string]any{"nativeModel": mid})
			}
		}
	}
	existing := []string{}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("upstream_models").Where("tenant_id = ? AND upstream_id = ?", tenant, id).Pluck("native_model", &existing).Error; e != nil {
		statusErr(w, e)
		return
	}
	known := map[string]bool{}
	for _, m := range existing {
		known[m] = true
	}
	now := runtimeTimeString(h.store.now())
	created, updated := 0, 0
	for _, m := range targets {
		res := h.deps.Gorm.WithContext(r.Context()).
			Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "tenant_id"}, {Name: "upstream_id"}, {Name: "native_model"}, {Name: "capability"}},
				DoUpdates: clause.Assignments(map[string]any{
					"display_name": nullString(m.Name), "synced_at": now, "updated_at": now,
					"status": "ready", "last_error": nil,
				}),
			}).
			Table("upstream_models").
			Create(map[string]any{"id": h.store.id(), "tenant_id": tenant, "upstream_id": id, "native_model": m.ID, "canonical_model": m.ID, "display_name": nullString(m.Name), "capability": "chat", "weight": "100", "is_default": false, "options_json": "{}", "meta_json": "{}", "status": "ready", "last_error": nil, "synced_at": now, "created_at": now, "updated_at": now})
		if res.Error != nil {
			statusErr(w, res.Error)
			return
		}
		if known[m.ID] {
			updated++
		} else {
			created++
			known[m.ID] = true
		}
	}
	httpx.JSON(w, 200, map[string]any{"synced": len(targets), "created": created, "updated": updated, "unmatchedModels": unmatched})
}
func (h *handler) discoverUpstreamModels(ctx context.Context, tenant, id string) (int, error) {
	u, e := h.store.GetUpstream(ctx, tenant, id)
	if e != nil {
		return 0, e
	}
	list, e := h.fetchUpstreamModelList(ctx, tenant, u)
	if e != nil {
		return 0, e
	}
	now := runtimeTimeString(h.store.now())
	count := 0
	for _, m := range list {
		res := h.deps.Gorm.WithContext(ctx).
			Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "tenant_id"}, {Name: "upstream_id"}, {Name: "native_model"}, {Name: "capability"}},
				DoUpdates: clause.Assignments(map[string]any{
					"display_name": nullString(m.Name), "synced_at": now, "updated_at": now,
					"status": "ready", "last_error": nil,
				}),
			}).
			Table("upstream_models").
			Create(map[string]any{"id": h.store.id(), "tenant_id": tenant, "upstream_id": id, "native_model": m.ID, "canonical_model": m.ID, "display_name": nullString(m.Name), "capability": "chat", "weight": "100", "is_default": false, "options_json": "{}", "meta_json": "{}", "status": "ready", "last_error": nil, "synced_at": now, "created_at": now, "updated_at": now})
		if res.Error != nil {
			return count, res.Error
		}
		count++
	}
	return count, nil
}
func (h *handler) matchModelCatalog(w http.ResponseWriter, r *http.Request) {
	term := strings.ToLower(r.URL.Query().Get("q"))
	models, e := h.queryUpstreamModels(r, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	out := make([]UpstreamModel, 0)
	for _, x := range models {
		if term == "" || strings.Contains(strings.ToLower(x.NativeModel+" "+x.CanonicalModel), term) {
			out = append(out, x)
		}
	}
	httpx.JSON(w, 200, map[string]any{"models": out})
}
func (h *handler) refreshModelCatalog(w http.ResponseWriter, r *http.Request) {
	tenant := principal(r).TenantID
	ups, e := h.store.ListUpstreams(r.Context(), tenant)
	if e != nil {
		statusErr(w, e)
		return
	}
	synced := 0
	failed := map[string]string{}
	for _, u := range ups {
		n, e := h.discoverUpstreamModels(r.Context(), tenant, u.ID)
		if e != nil {
			failed[u.ID] = e.Error()
			continue
		}
		synced += n
	}
	httpx.JSON(w, 200, map[string]any{"synced": synced, "failed": failed})
}
func (h *handler) importModelCatalog(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Models []UpstreamModel `json:"models"`
	}
	if httpx.DecodeJSON(r, &b) != nil || len(b.Models) == 0 {
		httpx.Error(w, 400, "models required")
		return
	}
	count := 0
	for _, m := range b.Models {
		if m.UpstreamID == "" || m.NativeModel == "" {
			continue
		}
		if m.CanonicalModel == "" {
			m.CanonicalModel = m.NativeModel
		}
		if m.Capability == "" {
			m.Capability = "chat"
		}
		if m.Weight == 0 {
			m.Weight = 100
		}
		now := runtimeTimeString(h.store.now())
		res := h.deps.Gorm.WithContext(r.Context()).
			Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "tenant_id"}, {Name: "upstream_id"}, {Name: "native_model"}, {Name: "capability"}},
				DoUpdates: clause.Assignments(map[string]any{
					"canonical_model": m.CanonicalModel, "display_name": m.DisplayName,
					"meta_json": validJSON(m.Meta, "{}"), "updated_at": now,
				}),
			}).
			Table("upstream_models").
			Create(map[string]any{"id": h.store.id(), "tenant_id": principal(r).TenantID, "upstream_id": m.UpstreamID, "native_model": m.NativeModel, "canonical_model": m.CanonicalModel, "display_name": m.DisplayName, "capability": m.Capability, "weight": strconv.FormatFloat(m.Weight, 'f', -1, 64), "is_default": m.IsDefault, "options_json": validJSON(m.Options, "{}"), "meta_json": validJSON(m.Meta, "{}"), "status": "ready", "last_error": nil, "synced_at": now, "created_at": now, "updated_at": now})
		if res.Error == nil {
			count++
		}
	}
	httpx.JSON(w, 201, map[string]any{"imported": count})
}

var _ = sql.ErrNoRows
var _ = errors.Is
var _ = url.URL{}
