// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
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
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE model_upstreams SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getUpstream(w, r)
}
func scanRoute(row interface{ Scan(...any) error }) (ModelRoute, error) {
	var x ModelRoute
	var opts, pri, wei string
	var c, u flexibleTime
	e := row.Scan(&x.ID, &x.Name, &x.Slug, &x.Capability, &x.Alias, &x.UpstreamID, &x.Model, &opts, &pri, &wei, &x.IsDefault, &x.Status, &x.LastError, &c, &u)
	if e != nil {
		return x, e
	}
	x.Options = json.RawMessage(opts)
	x.Priority, _ = strconv.Atoi(pri)
	x.Weight, _ = strconv.Atoi(wei)
	x.CreatedAt = c.Time
	x.UpdatedAt = u.Time
	return x, nil
}
func (h *handler) getModelRoute(w http.ResponseWriter, r *http.Request) {
	x, e := scanRoute(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,last_error,created_at,updated_at FROM model_routes WHERE tenant_id=? AND id=?`), principal(r).TenantID, chi.URLParam(r, "id")))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
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
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE model_routes SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getModelRoute(w, r)
}
