// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"golang.org/x/crypto/scrypt"
)

func secretBox(key []byte, scope string, plain []byte) (string, error) {
	_ = scope // pinned encryptJson intentionally does not use per-column AAD.
	derived, e := scrypt.Key(key, []byte("zakura-v1"), 16384, 8, 1, 32)
	if e != nil {
		return "", e
	}
	block, e := aes.NewCipher(derived)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, g.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	jsonPlain := plain
	if !json.Valid(jsonPlain) {
		jsonPlain, _ = json.Marshal(string(plain))
	}
	sealed := g.Seal(nil, nonce, jsonPlain, nil)
	ciphertext, tag := sealed[:len(sealed)-g.Overhead()], sealed[len(sealed)-g.Overhead():]
	payload := append(append(append([]byte{}, nonce...), tag...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}
func openSecretBox(key []byte, scope, value string) ([]byte, error) {
	if strings.HasPrefix(value, "v1.") {
		return openEarlyGoSecretBox(key, scope, value)
	}
	payload, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil || len(payload) < 28 {
		return nil, errors.New("invalid encrypted value")
	}
	derived, e := scrypt.Key(key, []byte("zakura-v1"), 16384, 8, 1, 32)
	if e != nil {
		return nil, e
	}
	block, e := aes.NewCipher(derived)
	if e != nil {
		return nil, e
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	nonce, tag, ciphertext := payload[:12], payload[12:28], payload[28:]
	sealed := append(append([]byte{}, ciphertext...), tag...)
	plain, e := g.Open(nil, nonce, sealed, nil)
	if e != nil {
		return nil, e
	}
	var stringValue string
	if json.Unmarshal(plain, &stringValue) == nil {
		return []byte(stringValue), nil
	}
	return plain, nil
}

func openEarlyGoSecretBox(key []byte, scope, value string) ([]byte, error) {
	raw, e := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "v1."))
	if e != nil {
		return nil, e
	}
	sum := sha256.Sum256(append(append([]byte{}, key...), scope...))
	block, e := aes.NewCipher(sum[:])
	if e != nil {
		return nil, e
	}
	g, e := cipher.NewGCM(block)
	if e != nil || len(raw) < g.NonceSize() {
		return nil, errors.New("invalid encrypted value")
	}
	return g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], []byte(scope))
}
func (h *handler) skillStores(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"stores": []map[string]any{{"id": "github", "name": "GitHub", "supportsSearch": true}, {"id": "gitlab", "name": "GitLab", "supportsSearch": true}}, "builtin": []any{}})
}
func (h *handler) listSkillRepos(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), `SELECT repo_key,provider,source_json,version,skill_count,size_bytes,warnings_json,checked_at,fetched_at,last_error FROM platform_skill_repos ORDER BY checked_at DESC`)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var key, provider, source, warnings, checked, fetched string
		var version, lastErr *string
		var count int
		var size int64
		if rows.Scan(&key, &provider, &source, &version, &count, &size, &warnings, &checked, &fetched, &lastErr) == nil {
			out = append(out, map[string]any{"repoKey": key, "provider": provider, "source": json.RawMessage(source), "version": version, "skillCount": count, "sizeBytes": size, "warnings": json.RawMessage(warnings), "checkedAt": checked, "fetchedAt": fetched, "lastError": lastErr})
		}
	}
	httpx.JSON(w, 200, map[string]any{"repos": out})
}
func (h *handler) skillToken(ctx context.Context, tenant, provider string) (string, error) {
	for _, scope := range []string{tenant, "platform"} {
		var enc string
		e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT token_enc FROM skill_source_tokens WHERE scope_key=? AND provider=?`), scope, provider).Scan(&enc)
		if e == nil {
			raw, e := openSecretBox(h.deps.Secret, scope+":"+provider, enc)
			return string(raw), e
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return "", e
		}
	}
	return "", sql.ErrNoRows
}
func (h *handler) syncRepo(ctx context.Context, provider, owner, repo string) (map[string]any, error) {
	if provider == "" {
		provider = "github"
	}
	if provider != "github" {
		return nil, errors.New("repository sync currently supports GitHub API")
	}
	base := "https://api.github.com"
	treeURL := base + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/git/trees/HEAD?recursive=1"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, treeURL, nil)
	if token, e := h.skillToken(ctx, "platform", "github"); e == nil && token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if e != nil {
		return nil, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub status %d: %s", resp.StatusCode, string(raw))
	}
	var tree struct {
		SHA  string                        `json:"sha"`
		Tree []struct{ Path, Type string } `json:"tree"`
	}
	if json.Unmarshal(raw, &tree) != nil {
		return nil, errors.New("invalid GitHub tree response")
	}
	packages := make([]map[string]any, 0)
	var total int64
	for _, entry := range tree.Tree {
		if entry.Type != "blob" || path.Base(entry.Path) != "SKILL.md" || len(packages) >= 100 {
			continue
		}
		rawURL := "https://raw.githubusercontent.com/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/HEAD/" + strings.ReplaceAll(entry.Path, " ", "%20")
		rq, _ := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if token, e := h.skillToken(ctx, "platform", "github"); e == nil && token != "" {
			rq.Header.Set("Authorization", "Bearer "+token)
		}
		rs, e := client.Do(rq)
		if e != nil {
			continue
		}
		content, e := io.ReadAll(io.LimitReader(rs.Body, 1<<20))
		rs.Body.Close()
		if e != nil || rs.StatusCode < 200 || rs.StatusCode >= 300 {
			continue
		}
		total += int64(len(content))
		name := path.Base(path.Dir(entry.Path))
		packages = append(packages, map[string]any{"name": slugify(name), "title": name, "description": "", "version": tree.SHA, "files": []skillFile{{Path: "SKILL.md", Content: string(content)}}})
	}
	packagesRaw, _ := json.Marshal(packages)
	sourceRaw, _ := json.Marshal(map[string]any{"provider": "github", "owner": owner, "repo": repo, "ref": "HEAD"})
	now := h.store.now()
	key := "github:" + owner + "/" + repo + "@HEAD"
	_, e = h.deps.DB.ExecContext(ctx, h.store.q(`INSERT INTO platform_skill_repos(id,repo_key,provider,source_json,ref,version,upstream_etag,packages_json,partial,skill_count,size_bytes,warnings_json,checked_at,fetched_at,ref_count,last_error,created_at,updated_at) VALUES(?,?, 'github',?,'HEAD',?,NULL,?,false,?,?,'[]',?,?,0,NULL,?,?) ON CONFLICT(repo_key) DO UPDATE SET version=?,packages_json=?,skill_count=?,size_bytes=?,checked_at=?,fetched_at=?,last_error=NULL,updated_at=?`), h.store.id(), key, string(sourceRaw), tree.SHA, string(packagesRaw), len(packages), total, now, now, now, now, tree.SHA, string(packagesRaw), len(packages), total, now, now, now)
	if e != nil {
		return nil, e
	}
	return map[string]any{"repoKey": key, "version": tree.SHA, "skillCount": len(packages), "sizeBytes": total}, nil
}
func (h *handler) syncSkillRepo(w http.ResponseWriter, r *http.Request) {
	x, e := h.syncRepo(r.Context(), "github", chi.URLParam(r, "owner"), chi.URLParam(r, "repo"))
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"repo": x})
}
func (h *handler) skillCacheStatus(w http.ResponseWriter, r *http.Request) {
	var repos, skills int
	var bytes int64
	e := h.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(SUM(skill_count),0),COALESCE(SUM(size_bytes),0) FROM platform_skill_repos`).Scan(&repos, &skills, &bytes)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"repos": repos, "skills": skills, "sizeBytes": bytes})
}
func (h *handler) skillAutoUpdateStatus(w http.ResponseWriter, r *http.Request) {
	var enabled, total int
	e := h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COALESCE(SUM(CASE WHEN auto_update THEN 1 ELSE 0 END),0),COUNT(*) FROM skills WHERE tenant_id=?`), principal(r).TenantID).Scan(&enabled, &total)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"enabled": enabled > 0, "enabledSkills": enabled, "totalSkills": total})
}
func (h *handler) putSkillAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Enabled == nil {
		httpx.Error(w, 400, "enabled is required")
		return
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE skills SET auto_update=?,updated_at=? WHERE tenant_id=? AND builtin=false`), *b.Enabled, h.store.now(), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, 200, map[string]any{"enabled": *b.Enabled, "updated": n})
}
func (h *handler) checkSkillUpdates(w http.ResponseWriter, r *http.Request) {
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT DISTINCT repo_key FROM skills WHERE tenant_id=? AND auto_update=true AND repo_key IS NOT NULL`), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	keys := []string{}
	for rows.Next() {
		var k string
		if rows.Scan(&k) == nil {
			keys = append(keys, k)
		}
	}
	rows.Close()
	updated := 0
	failed := map[string]string{}
	for _, key := range keys {
		trim := strings.TrimPrefix(strings.TrimSuffix(key, "@HEAD"), "github:")
		parts := strings.SplitN(trim, "/", 2)
		if len(parts) != 2 {
			continue
		}
		if _, e := h.syncRepo(r.Context(), "github", parts[0], parts[1]); e != nil {
			failed[key] = e.Error()
		} else {
			updated++
		}
	}
	httpx.JSON(w, 200, map[string]any{"result": map[string]any{"checked": len(keys), "updatedRepos": updated, "failed": failed}})
}
func (h *handler) listSkillTokens(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT scope_key,provider,label,hint,last_used_at,created_at,updated_at FROM skill_source_tokens WHERE scope_key=? OR (scope_key='platform' AND ?=true) ORDER BY scope_key,provider`), p.TenantID, p.IsPlatformAdmin)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var scope, provider string
		var label, hint, last *string
		var c, u string
		if rows.Scan(&scope, &provider, &label, &hint, &last, &c, &u) == nil {
			out = append(out, map[string]any{"scope": scope, "provider": provider, "label": label, "hint": hint, "lastUsedAt": last, "createdAt": c, "updatedAt": u})
		}
	}
	httpx.JSON(w, 200, map[string]any{"tokens": out})
}
func (h *handler) putSkillToken(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	provider := chi.URLParam(r, "provider")
	var b struct{ Token, Label, Scope string }
	if httpx.DecodeJSON(r, &b) != nil || b.Token == "" {
		httpx.Error(w, 400, "token required")
		return
	}
	scope := p.TenantID
	if b.Scope == "platform" {
		if !p.IsPlatformAdmin {
			httpx.Error(w, 403, "platform admin required")
			return
		}
		scope = "platform"
	}
	enc, e := secretBox(h.deps.Secret, scope+":"+provider, []byte(b.Token))
	if e != nil {
		statusErr(w, e)
		return
	}
	hint := b.Token
	if len(hint) > 4 {
		hint = hint[len(hint)-4:]
	}
	now := h.store.now()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO skill_source_tokens(id,scope_key,provider,token_enc,label,hint,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(scope_key,provider) DO UPDATE SET token_enc=?,label=?,hint=?,updated_at=?`), h.store.id(), scope, provider, enc, nullString(b.Label), hint, now, now, enc, nullString(b.Label), hint, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"scope": scope, "provider": provider, "hint": hint})
}
func (h *handler) deleteSkillToken(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	scope := r.URL.Query().Get("scope")
	if scope == "platform" {
		if !p.IsPlatformAdmin {
			httpx.Error(w, 403, "platform admin required")
			return
		}
	} else {
		scope = p.TenantID
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM skill_source_tokens WHERE scope_key=? AND provider=?`), scope, chi.URLParam(r, "provider"))
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
func (h *handler) resolveSkill(w http.ResponseWriter, r *http.Request) {
	var b struct{ RepoKey, Name string }
	if httpx.DecodeJSON(r, &b) != nil || b.RepoKey == "" || b.Name == "" {
		httpx.Error(w, 400, "repoKey and name required")
		return
	}
	var packages string
	e := h.deps.DB.QueryRowContext(r.Context(), `SELECT packages_json FROM platform_skill_repos WHERE repo_key=?`, b.RepoKey).Scan(&packages)
	if e != nil {
		statusErr(w, e)
		return
	}
	var all []map[string]any
	if json.Unmarshal([]byte(packages), &all) != nil {
		statusErr(w, errors.New("invalid repository cache"))
		return
	}
	for _, x := range all {
		if x["name"] == b.Name {
			httpx.JSON(w, 200, map[string]any{"skill": x})
			return
		}
	}
	statusErr(w, ErrNotFound)
}
func (h *handler) updateSkill(w http.ResponseWriter, r *http.Request) {
	skill, e := h.skillByID(r, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	var source struct {
		RepoKey string `json:"repoKey"`
	}
	_ = json.Unmarshal(skill.Source, &source)
	if source.RepoKey == "" {
		httpx.Error(w, 400, "skill has no cached repository source")
		return
	}
	var packages string
	e = h.deps.DB.QueryRowContext(r.Context(), `SELECT packages_json FROM platform_skill_repos WHERE repo_key=?`, source.RepoKey).Scan(&packages)
	if e != nil {
		statusErr(w, e)
		return
	}
	var all []struct {
		Name, Version string
		Files         []skillFile
	}
	if json.Unmarshal([]byte(packages), &all) != nil {
		statusErr(w, errors.New("invalid repository cache"))
		return
	}
	for _, x := range all {
		if x.Name != skill.Name {
			continue
		}
		size, e := validateSkillFiles(x.Files)
		if e != nil {
			statusErr(w, e)
			return
		}
		files, _ := json.Marshal(x.Files)
		_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE skills SET version=?,files_json=?,file_count=?,size_bytes=?,updated_at=? WHERE tenant_id=? AND id=?`), x.Version, string(files), len(x.Files), size, h.store.now(), principal(r).TenantID, skill.ID)
		if e != nil {
			statusErr(w, e)
			return
		}
		updated, _ := h.skillByID(r, skill.ID)
		httpx.JSON(w, 200, map[string]any{"skill": updated})
		return
	}
	statusErr(w, ErrNotFound)
}

var _ = bytes.NewBuffer
