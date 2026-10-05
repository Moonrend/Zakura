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
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

type UpstreamModel struct {
	ID             string          `json:"id"`
	UpstreamID     string          `json:"upstreamId"`
	NativeModel    string          `json:"nativeModel"`
	CanonicalModel string          `json:"canonicalModel"`
	DisplayName    *string         `json:"displayName"`
	Capability     string          `json:"capability"`
	Weight         string          `json:"weight"`
	IsDefault      bool            `json:"isDefault"`
	Options        json.RawMessage `json:"options"`
	Meta           json.RawMessage `json:"meta"`
	Status         string          `json:"status"`
	LastError      *string         `json:"lastError"`
	SyncedAt       *string         `json:"syncedAt"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

func scanUpstreamModel(row interface{ Scan(...any) error }) (UpstreamModel, error) {
	var x UpstreamModel
	var opts, meta string
	e := row.Scan(&x.ID, &x.UpstreamID, &x.NativeModel, &x.CanonicalModel, &x.DisplayName, &x.Capability, &x.Weight, &x.IsDefault, &opts, &meta, &x.Status, &x.LastError, &x.SyncedAt, &x.CreatedAt, &x.UpdatedAt)
	x.Options = json.RawMessage(opts)
	x.Meta = json.RawMessage(meta)
	return x, e
}
func (h *handler) queryUpstreamModels(r *http.Request, upstream string) ([]UpstreamModel, error) {
	q := `SELECT id,upstream_id,native_model,canonical_model,display_name,capability,weight,is_default,options_json,meta_json,status,last_error,synced_at,created_at,updated_at FROM upstream_models WHERE tenant_id=?`
	args := []any{principal(r).TenantID}
	if upstream != "" {
		q += ` AND upstream_id=?`
		args = append(args, upstream)
	}
	q += ` ORDER BY canonical_model,native_model`
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(q), args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]UpstreamModel, 0)
	for rows.Next() {
		x, e := scanUpstreamModel(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
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
	x, e := h.queryUpstreamModels(r, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"models": x})
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
	if x.Weight == "" {
		x.Weight = "100"
	}
	if x.Status == "" {
		x.Status = "ready"
	}
	now := h.store.now()
	x.ID = h.store.id()
	_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO upstream_models(id,tenant_id,upstream_id,native_model,canonical_model,display_name,capability,weight,is_default,options_json,meta_json,status,last_error,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`), x.ID, principal(r).TenantID, x.UpstreamID, x.NativeModel, x.CanonicalModel, x.DisplayName, x.Capability, x.Weight, x.IsDefault, validJSON(x.Options, "{}"), validJSON(x.Meta, "{}"), x.Status, now, now, now)
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
	args = append(args, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE upstream_models SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
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
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM upstream_models WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
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
		res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM upstream_models WHERE tenant_id=? AND id=?`), principal(r).TenantID, id)
		if e != nil {
			statusErr(w, e)
			return
		}
		x, _ := res.RowsAffected()
		n += x
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
		res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM model_upstreams WHERE tenant_id=? AND id=?`), principal(r).TenantID, id)
		if e != nil {
			statusErr(w, e)
			return
		}
		x, _ := res.RowsAffected()
		n += x
	}
	httpx.JSON(w, 200, map[string]any{"deleted": n})
}
func (h *handler) syncUpstreamModels(w http.ResponseWriter, r *http.Request) {
	count, e := h.discoverUpstreamModels(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"synced": count})
}
func (h *handler) discoverUpstreamModels(ctx context.Context, tenant, id string) (int, error) {
	u, e := h.store.GetUpstream(ctx, tenant, id)
	if e != nil {
		return 0, e
	}
	var cfg upstreamConfig
	if json.Unmarshal(u.Config, &cfg) != nil || cfg.BaseURL == "" {
		return 0, errors.New("baseUrl not configured")
	}
	target, e := safeProviderURL(cfg.BaseURL, "/v1/models")
	if e != nil {
		return 0, e
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		return 0, e
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if e != nil {
		return 0, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("model discovery status %d", resp.StatusCode)
	}
	type item struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var result struct {
		Data   []item `json:"data"`
		Models []item `json:"models"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return 0, errors.New("invalid model catalog")
	}
	if len(result.Data) == 0 {
		result.Data = result.Models
	}
	now := h.store.now()
	count := 0
	for _, m := range result.Data {
		if m.ID == "" {
			continue
		}
		_, e = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO upstream_models(id,tenant_id,upstream_id,native_model,canonical_model,display_name,capability,weight,is_default,options_json,meta_json,status,last_error,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'chat','100',false,'{}','{}','ready',NULL,?,?,?) ON CONFLICT(tenant_id,upstream_id,native_model,capability) DO UPDATE SET display_name=?,synced_at=?,updated_at=?,status='ready',last_error=NULL`), h.store.id(), tenant, id, m.ID, m.ID, nullString(m.Name), now, now, now, nullString(m.Name), now, now)
		if e != nil {
			return count, e
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
		if m.Weight == "" {
			m.Weight = "100"
		}
		now := h.store.now()
		_, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO upstream_models(id,tenant_id,upstream_id,native_model,canonical_model,display_name,capability,weight,is_default,options_json,meta_json,status,last_error,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,? ,?,'ready',NULL,?,?,?) ON CONFLICT(tenant_id,upstream_id,native_model,capability) DO UPDATE SET canonical_model=?,display_name=?,meta_json=?,updated_at=?`), h.store.id(), principal(r).TenantID, m.UpstreamID, m.NativeModel, m.CanonicalModel, m.DisplayName, m.Capability, m.Weight, m.IsDefault, validJSON(m.Options, "{}"), validJSON(m.Meta, "{}"), now, now, now, m.CanonicalModel, m.DisplayName, validJSON(m.Meta, "{}"), now)
		if e == nil {
			count++
		}
	}
	httpx.JSON(w, 201, map[string]any{"imported": count})
}

var _ = sql.ErrNoRows
var _ = errors.Is
var _ = url.URL{}
