// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func newShareToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, e := rand.Read(raw); e != nil {
		return "", "", e
	}
	token := "zfs_" + base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}
func (h *handler) createFileShare(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Path, FileName, MimeType, Disposition string
		TTLMinutes                            int `json:"ttlMinutes"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Path == "" {
		httpx.Error(w, 400, "path required")
		return
	}
	if b.TTLMinutes <= 0 {
		b.TTLMinutes = 60
	}
	if b.TTLMinutes > 7*24*60 {
		httpx.Error(w, 400, "ttlMinutes exceeds 7 days")
		return
	}
	if b.Disposition != "inline" {
		b.Disposition = "attachment"
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	resolved, e := f.resolve(b.Path, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	info, e := os.Stat(resolved)
	if e != nil || info.IsDir() {
		httpx.Error(w, 400, "path must be a file")
		return
	}
	if b.FileName == "" {
		b.FileName = filepath.Base(resolved)
	}
	token, hash, e := newShareToken()
	if e != nil {
		statusErr(w, e)
		return
	}
	p := principal(r)
	now := h.store.now()
	expires := now.Add(time.Duration(b.TTLMinutes) * time.Minute)
	id := h.store.id()
	res := h.deps.Gorm.WithContext(r.Context()).Table("file_shares").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "agent_id": chi.URLParam(r, "id"), "token_hash": hash, "path": b.Path, "file_name": b.FileName, "mime_type": nullString(b.MimeType), "size_bytes": info.Size(), "status": "active", "ttl_minutes": b.TTLMinutes, "expires_at": runtimeTimeString(expires), "download_count": 0, "disposition": b.Disposition, "revoked_at": nil, "created_at": runtimeTimeString(now), "updated_at": runtimeTimeString(now)})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 201, map[string]any{"share": map[string]any{"id": id, "url": strings.TrimRight(h.deps.PublicURL, "/") + "/api/files/shared/" + token, "expiresAt": expires, "fileName": b.FileName, "sizeBytes": info.Size(), "disposition": b.Disposition}})
}
func (h *handler) revokeFileShare(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res := h.deps.Gorm.WithContext(r.Context()).Table("file_shares").Where("id = ? AND tenant_id = ? AND agent_id = ? AND status = 'active'", chi.URLParam(r, "shareId"), p.TenantID, chi.URLParam(r, "id")).Updates(map[string]any{"status": "revoked", "revoked_at": runtimeTimeString(h.store.now()), "updated_at": runtimeTimeString(h.store.now())})
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
func (h *handler) downloadSharedFile(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	var row struct {
		ID          string `gorm:"column:id"`
		Tenant      string `gorm:"column:tenant_id"`
		Agent       string `gorm:"column:agent_id"`
		Path        string `gorm:"column:path"`
		Name        string `gorm:"column:file_name"`
		Mime        string `gorm:"column:mime_type"`
		Size        int64  `gorm:"column:size_bytes"`
		Disposition string `gorm:"column:disposition"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("file_shares").Select("id,tenant_id,agent_id,path,file_name,COALESCE(mime_type,'application/octet-stream') AS mime_type,size_bytes,disposition").Where("token_hash = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?", hash, runtimeTimeString(h.store.now())).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		httpx.Error(w, 404, "Share not found or expired")
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	f, e := h.workspaceFor(r.Context(), row.Tenant, row.Agent)
	if e != nil {
		httpx.Error(w, 404, "Share unavailable")
		return
	}
	resolved, e := f.resolve(row.Path, true)
	if e != nil {
		httpx.Error(w, 403, "Forbidden")
		return
	}
	file, e := os.Open(resolved)
	if e != nil {
		httpx.Error(w, 404, "File no longer exists in workspace")
		return
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || info.IsDir() {
		httpx.Error(w, 404, "File no longer exists in workspace")
		return
	}
	_ = h.deps.Gorm.WithContext(r.Context()).Table("file_shares").Where("id = ?", row.ID).Updates(map[string]any{"download_count": gorm.Expr("download_count+1"), "updated_at": runtimeTimeString(h.store.now())})
	safe := strings.NewReplacer("\"", "_", "\r", "_", "\n", "_").Replace(row.Name)
	w.Header().Set("Content-Type", row.Mime)
	w.Header().Set("Content-Disposition", row.Disposition+`; filename="`+safe+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, safe, info.ModTime(), file)
}
