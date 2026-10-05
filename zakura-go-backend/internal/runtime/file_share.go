// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
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
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO file_shares(id,tenant_id,agent_id,token_hash,path,file_name,mime_type,size_bytes,status,ttl_minutes,expires_at,download_count,disposition,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?,0,?,NULL,?,?)`), id, p.TenantID, chi.URLParam(r, "id"), hash, b.Path, b.FileName, nullString(b.MimeType), info.Size(), b.TTLMinutes, expires, b.Disposition, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"share": map[string]any{"id": id, "url": strings.TrimRight(h.deps.PublicURL, "/") + "/api/files/shared/" + token, "expiresAt": expires, "fileName": b.FileName, "sizeBytes": info.Size(), "disposition": b.Disposition}})
}
func (h *handler) revokeFileShare(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE file_shares SET status='revoked',revoked_at=?,updated_at=? WHERE id=? AND tenant_id=? AND agent_id=? AND status='active'`), h.store.now(), h.store.now(), chi.URLParam(r, "shareId"), p.TenantID, chi.URLParam(r, "id"))
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
func (h *handler) downloadSharedFile(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	var id, tenant, agent, path, name, mime, disposition string
	var size int64
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,tenant_id,agent_id,path,file_name,COALESCE(mime_type,'application/octet-stream'),size_bytes,disposition FROM file_shares WHERE token_hash=? AND status='active' AND revoked_at IS NULL AND expires_at>?`), hash, h.store.now()).Scan(&id, &tenant, &agent, &path, &name, &mime, &size, &disposition)
	if errors.Is(e, sql.ErrNoRows) {
		httpx.Error(w, 404, "Share not found or expired")
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	f, e := h.workspaceFor(r.Context(), tenant, agent)
	if e != nil {
		httpx.Error(w, 404, "Share unavailable")
		return
	}
	resolved, e := f.resolve(path, true)
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
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE file_shares SET download_count=download_count+1,updated_at=? WHERE id=?`), h.store.now(), id)
	safe := strings.NewReplacer("\"", "_", "\r", "_", "\n", "_").Replace(name)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", disposition+`; filename="`+safe+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, safe, info.ModTime(), file)
}
