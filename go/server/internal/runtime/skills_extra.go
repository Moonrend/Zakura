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

	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/scrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	var ms []models.PlatformSkillRepo
	if e := h.deps.Gorm.WithContext(r.Context()).Order("checked_at DESC").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		if m.CheckedAt == nil {
			continue
		}
		out = append(out, map[string]any{"repoKey": m.RepoKey, "provider": m.Provider, "source": json.RawMessage(m.SourceJSON), "version": m.Version, "skillCount": int(m.SkillCount), "sizeBytes": int64(m.SizeBytes), "warnings": json.RawMessage(m.WarningsJSON), "checkedAt": *m.CheckedAt, "fetchedAt": m.FetchedAt, "lastError": m.LastError})
	}
	httpx.JSON(w, 200, map[string]any{"repos": out})
}
func (h *handler) skillToken(ctx context.Context, tenant, provider string) (string, error) {
	for _, scope := range []string{tenant, "platform"} {
		var row struct {
			TokenEnc string `gorm:"column:token_enc"`
		}
		e := h.deps.Gorm.WithContext(ctx).Table("skill_source_tokens").Select("token_enc").Where("scope_key = ? AND provider = ?", scope, provider).Take(&row).Error
		if e == nil {
			raw, e := openSecretBox(h.deps.Secret, scope+":"+provider, row.TokenEnc)
			return string(raw), e
		}
		if !errors.Is(e, gorm.ErrRecordNotFound) {
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
	now := runtimeTimeString(h.store.now())
	key := "github:" + owner + "/" + repo + "@HEAD"
	e = h.deps.Gorm.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "repo_key"}},
			DoUpdates: clause.Assignments(map[string]any{
				"version": tree.SHA, "packages_json": string(packagesRaw), "skill_count": len(packages), "size_bytes": total,
				"checked_at": now, "fetched_at": now, "last_error": nil, "updated_at": now,
			}),
		}).
		Table("platform_skill_repos").
		Create(map[string]any{"id": h.store.id(), "repo_key": key, "provider": "github", "source_json": string(sourceRaw), "ref": "HEAD", "version": tree.SHA, "upstream_etag": nil, "packages_json": string(packagesRaw), "partial": false, "skill_count": len(packages), "size_bytes": total, "warnings_json": "[]", "checked_at": now, "fetched_at": now, "ref_count": 0, "last_error": nil, "created_at": now, "updated_at": now}).Error
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
	var agg struct {
		Repos  int64 `gorm:"column:repos"`
		Skills int64 `gorm:"column:skills"`
		Size   int64 `gorm:"column:size"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Model(&models.PlatformSkillRepo{}).Select("COUNT(*) AS repos, COALESCE(SUM(skill_count),0) AS skills, COALESCE(SUM(size_bytes),0) AS size").Scan(&agg).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"repos": agg.Repos, "skills": agg.Skills, "sizeBytes": agg.Size})
}
func (h *handler) skillAutoUpdateStatus(w http.ResponseWriter, r *http.Request) {
	var agg struct {
		Enabled int64 `gorm:"column:enabled"`
		Total   int64 `gorm:"column:total"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ?", principal(r).TenantID).Select("COALESCE(SUM(CASE WHEN auto_update THEN 1 ELSE 0 END),0) AS enabled, COUNT(*) AS total").Scan(&agg).Error
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"enabled": agg.Enabled > 0, "enabledSkills": agg.Enabled, "totalSkills": agg.Total})
}
func (h *handler) putSkillAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Enabled == nil {
		httpx.Error(w, 400, "enabled is required")
		return
	}
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = false", principal(r).TenantID).Updates(map[string]any{"auto_update": *b.Enabled, "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	httpx.JSON(w, 200, map[string]any{"enabled": *b.Enabled, "updated": res.RowsAffected})
}
func (h *handler) checkSkillUpdates(w http.ResponseWriter, r *http.Request) {
	var keys []string
	if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ? AND auto_update = true AND repo_key IS NOT NULL", principal(r).TenantID).Distinct().Pluck("repo_key", &keys).Error; e != nil {
		statusErr(w, e)
		return
	}
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
	q := h.deps.Gorm.WithContext(r.Context()).Model(&models.SkillSourceToken{}).Where("scope_key = ?", p.TenantID)
	if p.IsPlatformAdmin {
		q = q.Or("scope_key = 'platform'")
	}
	var ms []models.SkillSourceToken
	if e := q.Order("scope_key, provider").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{"scope": m.ScopeKey, "provider": m.Provider, "label": m.Label, "hint": m.Hint, "lastUsedAt": m.LastUsedAt, "createdAt": m.CreatedAt, "updatedAt": m.UpdatedAt})
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
	now := runtimeTimeString(h.store.now())
	e = h.deps.Gorm.WithContext(r.Context()).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "scope_key"}, {Name: "provider"}},
			DoUpdates: clause.AssignmentColumns([]string{"token_enc", "label", "hint", "updated_at"}),
		}).
		Table("skill_source_tokens").
		Create(map[string]any{"id": h.store.id(), "scope_key": scope, "provider": provider, "token_enc": enc, "label": nullString(b.Label), "hint": hint, "last_used_at": nil, "created_at": now, "updated_at": now}).Error
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
	res := h.deps.Gorm.WithContext(r.Context()).Where("scope_key = ? AND provider = ?", scope, chi.URLParam(r, "provider")).Delete(&models.SkillSourceToken{})
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
func (h *handler) resolveSkill(w http.ResponseWriter, r *http.Request) {
	var b struct{ RepoKey, Name string }
	if httpx.DecodeJSON(r, &b) != nil || b.RepoKey == "" || b.Name == "" {
		httpx.Error(w, 400, "repoKey and name required")
		return
	}
	var row struct {
		PackagesJSON string `gorm:"column:packages_json"`
	}
	e := h.deps.Gorm.WithContext(r.Context()).Table("platform_skill_repos").Select("packages_json").Where("repo_key = ?", b.RepoKey).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = sql.ErrNoRows
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	packages := row.PackagesJSON
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
	var repoRow struct {
		PackagesJSON string `gorm:"column:packages_json"`
	}
	e = h.deps.Gorm.WithContext(r.Context()).Table("platform_skill_repos").Select("packages_json").Where("repo_key = ?", source.RepoKey).Take(&repoRow).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = sql.ErrNoRows
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	packages := repoRow.PackagesJSON
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
		if e = h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ? AND id = ?", principal(r).TenantID, skill.ID).Updates(map[string]any{"version": x.Version, "files_json": string(files), "file_count": len(x.Files), "size_bytes": size, "updated_at": runtimeTimeString(h.store.now())}).Error; e != nil {
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
