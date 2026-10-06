// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) patchMemory(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if value, ok := m["pinned"]; ok {
		pinned, valid := value.(bool)
		if !valid {
			httpx.Error(w, 400, "pinned must be a boolean")
			return
		}
		if pinned {
			m["pinned"] = 1
		} else {
			m["pinned"] = 0
		}
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"content": "content", "layer": "layer", "pinned": "pinned", "importance": "importance", "tags": "tags_json", "metadata": "metadata_json"} {
		if v, ok := m[k]; ok {
			if k == "tags" || k == "metadata" {
				b, _ := json.Marshal(v)
				v = string(b)
			}
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		httpx.Error(w, 400, "no supported fields")
		return
	}
	sets = append(sets, "content_hash=NULL", "updated_at=?")
	p := principal(r)
	args = append(args, runtimeTimeString(h.store.now()), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "memId"))
	res := h.deps.Gorm.WithContext(r.Context()).Exec(`UPDATE memories SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND agent_id=? AND id=?`, args...)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	n := res.RowsAffected
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	items, e := h.store.ListMemories(r.Context(), p.TenantID, chi.URLParam(r, "id"), "", "", 500)
	if e != nil {
		statusErr(w, e)
		return
	}
	for _, x := range items {
		if x.ID == chi.URLParam(r, "memId") {
			httpx.JSON(w, http.StatusOK, x)
			return
		}
	}
	statusErr(w, ErrNotFound)
}
func (h *handler) memoryGraph(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	items, e := h.store.ListMemories(r.Context(), p.TenantID, agent, "", "", 500)
	if e != nil {
		statusErr(w, e)
		return
	}
	rows, e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT id,from_memory_id,to_memory_id,relation,weight,created_at FROM memory_edges WHERE tenant_id=? AND agent_id=? ORDER BY created_at`, p.TenantID, agent).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	edges := make([]map[string]any, 0)
	for rows.Next() {
		var id, from, to, relation, weight string
		var c flexibleTime
		if rows.Scan(&id, &from, &to, &relation, &weight, &c) == nil {
			edges = append(edges, map[string]any{"id": id, "fromMemoryId": from, "toMemoryId": to, "relation": relation, "weight": weight, "createdAt": c.Time})
		}
	}
	httpx.JSON(w, 200, map[string]any{"nodes": items, "edges": edges})
}
func (h *handler) createMemoryEdge(w http.ResponseWriter, r *http.Request) {
	var b struct {
		FromMemoryID string `json:"fromMemoryId"`
		ToMemoryID   string `json:"toMemoryId"`
		Relation     string `json:"relation"`
		Weight       any    `json:"weight"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.FromMemoryID == "" || b.ToMemoryID == "" {
		httpx.Error(w, 400, "fromMemoryId and toMemoryId required")
		return
	}
	if b.FromMemoryID == b.ToMemoryID {
		httpx.Error(w, 400, "self edges are not allowed")
		return
	}
	if b.Relation == "" {
		b.Relation = "related"
	}
	weight := "1"
	switch v := b.Weight.(type) {
	case string:
		if v != "" {
			weight = v
		}
	case float64:
		weight = strconv.FormatFloat(v, 'f', -1, 64)
	}
	p := principal(r)
	agent := chi.URLParam(r, "id")
	var countRow struct {
		Count int64 `gorm:"column:total"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("memories").Select("COUNT(*) AS total").Where("tenant_id = ? AND agent_id = ? AND id IN (?,?)", p.TenantID, agent, b.FromMemoryID, b.ToMemoryID).Take(&countRow).Error
	if e != nil || countRow.Count != 2 {
		httpx.Error(w, 404, "memory not found")
		return
	}
	id := h.store.id()
	res := h.deps.Gorm.WithContext(r.Context()).Table("memory_edges").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "agent_id": agent, "from_memory_id": b.FromMemoryID, "to_memory_id": b.ToMemoryID, "relation": b.Relation, "weight": weight, "created_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 201, map[string]any{"edge": map[string]any{"id": id, "fromMemoryId": b.FromMemoryID, "toMemoryId": b.ToMemoryID, "relation": b.Relation, "weight": weight}})
}
func (h *handler) deleteMemoryEdge(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Table("memory_edges").Where("tenant_id = ? AND agent_id = ? AND id = ?", p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "edgeId")).Delete(nil)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	n := res.RowsAffected
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) reembedMemory(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	cfg, e := h.agentEmbeddingConfig(r.Context(), p.TenantID, agent)
	if e != nil {
		statusErr(w, e)
		return
	}
	if cfg == nil {
		httpx.Error(w, http.StatusBadRequest, "enable embedding on a Built-in memory provider first")
		return
	}
	rows, e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT id,content FROM memories WHERE tenant_id=? AND agent_id=? AND (embedding IS NULL OR content_hash IS NULL) ORDER BY updated_at LIMIT 100`, p.TenantID, agent).Rows()
	if e != nil {
		statusErr(w, e)
		return
	}
	type pending struct{ id, content string }
	items := []pending{}
	for rows.Next() {
		var item pending
		if rows.Scan(&item.id, &item.content) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	updated, failed := 0, 0
	errorsOut := []string{}
	for _, item := range items {
		vector, model, embedErr := h.embedMemoryText(r.Context(), p.TenantID, cfg, item.content)
		if embedErr == nil {
			embedErr = h.setMemoryEmbedding(r.Context(), p.TenantID, agent, item.id, item.content, vector, model)
		}
		if embedErr != nil {
			failed++
			if len(errorsOut) < 5 {
				errorsOut = append(errorsOut, item.id+": "+embedErr.Error())
			}
			continue
		}
		updated++
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": updated, "failed": failed, "errors": errorsOut, "stats": h.memoryEmbeddingCounts(r.Context(), p.TenantID, agent)})
}
func (h *handler) memoryEmbeddingStats(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent := chi.URLParam(r, "id")
	cfg, e := h.agentEmbeddingConfig(r.Context(), p.TenantID, agent)
	if e != nil {
		statusErr(w, e)
		return
	}
	stats := h.memoryEmbeddingCounts(r.Context(), p.TenantID, agent)
	var model, baseURL any
	if cfg != nil {
		model, baseURL = cfg.Model, cfg.BaseURL
		if cfg.RouteSlug != "" {
			model = cfg.RouteSlug
		}
		if cfg.RouteID != "" {
			model = cfg.RouteID
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"enabled": cfg != nil, "model": model, "baseUrl": baseURL, "stats": stats})
}

func (h *handler) memoryEmbeddingCounts(ctx context.Context, tenant, agent string) map[string]any {
	var stats struct {
		Total    int `gorm:"column:total"`
		Embedded int `gorm:"column:embedded"`
		Stale    int `gorm:"column:stale"`
	}
	_ = h.deps.Gorm.WithContext(ctx).Raw(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END),0) AS embedded,COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND content_hash IS NULL THEN 1 ELSE 0 END),0) AS stale FROM memories WHERE tenant_id=? AND agent_id=?`, tenant, agent).Scan(&stats).Error
	return map[string]any{"total": stats.Total, "withEmbedding": stats.Embedded, "missing": stats.Total - stats.Embedded, "stale": stats.Stale}
}
