package runtime

import (
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *handler) registerProjectSemantics(r chi.Router) {
	r.Get("/snapshots/{snapshot}/semantic", h.projectSemanticIndex)
	r.Get("/snapshots/{snapshot}/semantic/search", h.projectSemanticSearch)
	r.Get("/snapshots/{snapshot}/semantic/file", h.projectSemanticFile)
	r.Get("/snapshots/{snapshot}/semantic/symbol/{symbol}", h.projectSemanticSymbol)
	r.Get("/snapshots/{snapshot}/semantic/compare", h.projectSemanticCompareSnapshots)
	r.Get("/runs/{rid}/semantic/compare", h.projectSemanticCompareTasks)
}
func semanticSnapshotID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && id == strings.ToLower(id)
}
func semanticWindow(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	limit, offset := 1000, 0
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 1000 {
			httpx.Error(w, 400, "Semantic limit must be between 1 and 1000")
			return 0, 0, false
		}
		limit = parsed
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 || parsed > 1000000 {
			httpx.Error(w, 400, "Invalid semantic offset")
			return 0, 0, false
		}
		offset = parsed
	}
	return limit, offset, true
}
func semanticSnapshotArgs(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	id := chi.URLParam(r, "snapshot")
	if !semanticSnapshotID(id) {
		httpx.Error(w, 400, "An immutable snapshot identifier is required")
		return nil, false
	}
	return map[string]any{"snapshotId": id}, true
}
func (h *handler) projectSemanticIndex(w http.ResponseWriter, r *http.Request) {
	args, ok := semanticSnapshotArgs(w, r)
	if ok {
		h.projectReadRPC(w, r, "project.semantic.index", args)
	}
}
func (h *handler) projectSemanticSearch(w http.ResponseWriter, r *http.Request) {
	args, ok := semanticSnapshotArgs(w, r)
	if !ok {
		return
	}
	limit, offset, ok := semanticWindow(w, r)
	if !ok {
		return
	}
	query := r.URL.Query().Get("q")
	if len(query) > 256 {
		httpx.Error(w, 400, "Semantic query exceeds 256 bytes")
		return
	}
	exported := false
	if value := r.URL.Query().Get("exportedOnly"); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			httpx.Error(w, 400, "Invalid exportedOnly parameter")
			return
		}
		exported = parsed
	}
	args["query"] = query
	args["path"] = r.URL.Query().Get("path")
	args["kind"] = r.URL.Query().Get("kind")
	args["exportedOnly"] = exported
	args["limit"] = limit
	args["offset"] = offset
	h.projectReadRPC(w, r, "project.semantic.search", args)
}
func (h *handler) projectSemanticFile(w http.ResponseWriter, r *http.Request) {
	args, ok := semanticSnapshotArgs(w, r)
	if !ok {
		return
	}
	limit, _, ok := semanticWindow(w, r)
	if !ok {
		return
	}
	args["path"] = r.URL.Query().Get("path")
	args["limit"] = limit
	h.projectReadRPC(w, r, "project.semantic.file", args)
}
func (h *handler) projectSemanticSymbol(w http.ResponseWriter, r *http.Request) {
	args, ok := semanticSnapshotArgs(w, r)
	if !ok {
		return
	}
	limit, _, ok := semanticWindow(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "symbol")
	if len(id) != 32 {
		httpx.Error(w, 400, "Invalid semantic symbol identifier")
		return
	}
	if _, err := hex.DecodeString(id); err != nil {
		httpx.Error(w, 400, "Invalid semantic symbol identifier")
		return
	}
	args["symbolId"] = id
	args["limit"] = limit
	h.projectReadRPC(w, r, "project.semantic.symbol", args)
}
func (h *handler) projectSemanticCompareSnapshots(w http.ResponseWriter, r *http.Request) {
	args, ok := semanticSnapshotArgs(w, r)
	if !ok {
		return
	}
	limit, _, ok := semanticWindow(w, r)
	if !ok {
		return
	}
	before := r.URL.Query().Get("before")
	if !semanticSnapshotID(before) {
		httpx.Error(w, 400, "A before snapshot identifier is required")
		return
	}
	args["beforeSnapshot"] = before
	args["limit"] = limit
	h.projectReadRPC(w, r, "project.semantic.compare", args)
}
func (h *handler) projectSemanticCompareTasks(w http.ResponseWriter, r *http.Request) {
	p, err := h.requestProject(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	limit, _, ok := semanticWindow(w, r)
	if !ok {
		return
	}
	rid := chi.URLParam(r, "rid")
	left, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, rid, r.URL.Query().Get("leftTask"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	right, err := h.projects.GetTask(r.Context(), p.TenantID, p.ID, rid, r.URL.Query().Get("rightTask"))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	if left.SnapshotID == "" || right.SnapshotID == "" {
		httpx.Error(w, 409, "Both tasks require captured immutable artifacts before semantic comparison")
		return
	}
	h.projectReadRPC(w, r, "project.semantic.compare", map[string]any{"beforeSnapshot": left.SnapshotID, "snapshotId": right.SnapshotID, "limit": limit})
}
