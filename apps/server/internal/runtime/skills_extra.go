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
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
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

const (
	skillRefreshIntervalMs      = 60 * 60 * 1000
	skillRepoCacheTTL           = 6 * time.Hour
	skillRepoRefreshBatch       = 4
	skillMaintenanceTenantBatch = 25
	skillAutoUpdateKey          = "skills.autoUpdate"
	skillRepoEpoch              = "1970-01-01T00:00:00.000Z"
)

type skillSource struct {
	Kind   string   `json:"kind"`
	Owner  string   `json:"owner"`
	Repo   string   `json:"repo"`
	Ref    string   `json:"ref"`
	Path   string   `json:"path"`
	Skills []string `json:"skills"`
}

func skillSourceFromJSON(raw json.RawMessage) skillSource {
	var src skillSource
	_ = json.Unmarshal(raw, &src)
	return src
}

func repoKeyOfSource(src skillSource) string {
	if src.Kind != "github" && src.Kind != "gitlab" {
		return ""
	}
	if src.Owner == "" || src.Repo == "" {
		return ""
	}
	ref := src.Ref
	if ref == "" {
		ref = "HEAD"
	}
	scope := ""
	if p := strings.Trim(src.Path, "/"); p != "" {
		scope = "#" + p
	}
	return src.Kind + ":" + src.Owner + "/" + src.Repo + "@" + ref + scope
}

func skillFrontmatterVersion(content string) string {
	text := strings.TrimPrefix(content, "\ufeff")
	if !strings.HasPrefix(text, "---") {
		return ""
	}
	rest := text[3:]
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[i+1:]
	} else {
		return ""
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return ""
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if strings.HasPrefix(line, "version:") {
			v := strings.TrimSpace(strings.TrimPrefix(line, "version:"))
			return strings.Trim(v, `"'`)
		}
	}
	return ""
}

func isZeroRepoTime(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	t, e := time.Parse(time.RFC3339Nano, v)
	if e != nil {
		return false
	}
	return t.Unix() <= 0
}

type curatedSkillRepo struct {
	Slug        string
	Name        string
	Description string
	Publisher   string
}

var curatedSkillRepos = []curatedSkillRepo{
	{Slug: "anthropics/skills", Name: "Anthropic Skills", Description: "Anthropic 官方技能集：文档处理、前端设计、MCP 构建等", Publisher: "Anthropic"},
	{Slug: "openai/skills", Name: "OpenAI Skills", Description: "OpenAI 官方技能集", Publisher: "OpenAI"},
	{Slug: "vercel-labs/agent-skills", Name: "Vercel Agent Skills", Description: "Vercel 出品的前端与写作类技能", Publisher: "Vercel"},
	{Slug: "obra/superpowers", Name: "Superpowers", Description: "工程实践类技能：TDD、系统化调试、代码评审", Publisher: "obra"},
	{Slug: "anthropics/knowledge-work-plugins", Name: "Knowledge Work Plugins", Description: "Anthropic 知识工作插件集", Publisher: "Anthropic"},
	{Slug: "cursor/plugins", Name: "Cursor Plugins", Description: "Cursor 官方插件与技能", Publisher: "Cursor"},
	{Slug: "google-labs-code/stitch-skills", Name: "Stitch Skills", Description: "Google Labs Stitch 设计到代码工作流", Publisher: "Google Labs"},
	{Slug: "mattpocock/skills", Name: "Matt Pocock Skills", Description: "写作与 TypeScript 相关技能", Publisher: "mattpocock"},
}

func curatedRepoBySlug(slug string) *curatedSkillRepo {
	for i := range curatedSkillRepos {
		if strings.EqualFold(curatedSkillRepos[i].Slug, slug) {
			return &curatedSkillRepos[i]
		}
	}
	return nil
}

func curatedRepoKey(slug string) string { return "github:" + slug + "@HEAD" }

func (h *handler) enrichSkillRepoState(ctx context.Context, skills []Skill) {
	keys := make([]string, 0, len(skills))
	seen := map[string]bool{}
	for _, s := range skills {
		if s.RepoKey == nil || *s.RepoKey == "" || seen[*s.RepoKey] {
			continue
		}
		seen[*s.RepoKey] = true
		keys = append(keys, *s.RepoKey)
	}
	if len(keys) == 0 {
		return
	}
	versions := make(map[string]repoSkillVersions, len(keys))
	for _, key := range keys {
		versions[key] = h.repoSkillVersions(ctx, key)
	}
	for i := range skills {
		if skills[i].RepoKey == nil || *skills[i].RepoKey == "" {
			continue
		}
		up := versions[*skills[i].RepoKey].upstream(skills[i].Name)
		if up == "" {
			continue
		}
		value := up
		skills[i].UpstreamVersion = &value
		if skills[i].Version != nil && *skills[i].Version != up {
			skills[i].UpdateAvailable = true
		}
	}
}

type skillUpdateFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

type skillUpdateSummary struct {
	Updated       []string             `json:"updated"`
	UpToDate      int                  `json:"upToDate"`
	BuiltinSynced int                  `json:"builtinSynced"`
	Failed        []skillUpdateFailure `json:"failed"`
}

func skillRepoParts(repoKey string) (slug, owner, repo string) {
	key := repoKey
	if i := strings.IndexByte(key, ':'); i >= 0 {
		key = key[i+1:]
	}
	if i := strings.IndexByte(key, '@'); i >= 0 {
		key = key[:i]
	}
	slug = key
	if i := strings.IndexByte(key, '/'); i >= 0 {
		owner, repo = key[:i], key[i+1:]
	} else {
		repo = key
	}
	if repo == "" {
		repo = key
	}
	return
}

func skillRepoSummary(m models.PlatformSkillRepo) map[string]any {
	slug, owner, repo := skillRepoParts(m.RepoKey)
	name := repo
	if name == "" {
		name = slug
	}
	description := ""
	publisher := owner
	if c := curatedRepoBySlug(slug); c != nil {
		if c.Name != "" {
			name = c.Name
		}
		description = c.Description
		if c.Publisher != "" {
			publisher = c.Publisher
		}
	}
	var checkedAt any
	if m.CheckedAt != nil && !isZeroRepoTime(*m.CheckedAt) {
		checkedAt = *m.CheckedAt
	}
	var fetchedAt any
	if !isZeroRepoTime(m.FetchedAt) {
		fetchedAt = m.FetchedAt
	}
	return map[string]any{
		"repoKey":     m.RepoKey,
		"slug":        slug,
		"name":        name,
		"description": description,
		"publisher":   publisher,
		"skillCount":  int(m.SkillCount),
		"sizeBytes":   int64(m.SizeBytes),
		"version":     m.Version,
		"checkedAt":   checkedAt,
		"fetchedAt":   fetchedAt,
		"partial":     m.Partial,
		"pending":     isZeroRepoTime(m.FetchedAt) || m.SkillCount == 0,
		"lastError":   m.LastError,
	}
}

func curatedRepoPlaceholder(key string, c curatedSkillRepo) map[string]any {
	return map[string]any{
		"repoKey":     key,
		"slug":        c.Slug,
		"name":        c.Name,
		"description": c.Description,
		"publisher":   c.Publisher,
		"skillCount":  0,
		"sizeBytes":   int64(0),
		"version":     nil,
		"checkedAt":   nil,
		"fetchedAt":   nil,
		"partial":     false,
		"pending":     true,
		"lastError":   nil,
	}
}

func (h *handler) listSkillRepos(w http.ResponseWriter, r *http.Request) {
	var ms []models.PlatformSkillRepo
	if e := h.deps.Gorm.WithContext(r.Context()).Order("checked_at DESC").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	cached := map[string]models.PlatformSkillRepo{}
	for _, m := range ms {
		cached[m.RepoKey] = m
	}
	out := make([]map[string]any, 0, len(ms)+len(curatedSkillRepos))
	for _, c := range curatedSkillRepos {
		key := curatedRepoKey(c.Slug)
		if m, ok := cached[key]; ok {
			out = append(out, skillRepoSummary(m))
			delete(cached, key)
			continue
		}
		out = append(out, curatedRepoPlaceholder(key, c))
	}
	for _, m := range ms {
		if _, ok := cached[m.RepoKey]; ok && m.SkillCount > 0 {
			out = append(out, skillRepoSummary(m))
		}
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
		version := skillFrontmatterVersion(string(content))
		if version == "" {
			version = tree.SHA
		}
		packages = append(packages, map[string]any{"name": slugify(name), "title": name, "description": "", "version": version, "files": []skillFile{{Path: "SKILL.md", Content: string(content)}}})
	}
	repoVersion := tree.SHA
	if len(packages) > 0 {
		if v, ok := packages[0]["version"].(string); ok && v != "" {
			repoVersion = v
		}
	}
	packagesRaw, _ := json.Marshal(packages)
	sourceRaw, _ := json.Marshal(map[string]any{"provider": "github", "owner": owner, "repo": repo, "ref": "HEAD"})
	now := runtimeTimeString(h.store.now())
	key := "github:" + owner + "/" + repo + "@HEAD"
	e = h.deps.Gorm.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "repo_key"}},
			DoUpdates: clause.Assignments(map[string]any{
				"version": repoVersion, "upstream_etag": tree.SHA, "packages_json": string(packagesRaw), "skill_count": len(packages), "size_bytes": total,
				"checked_at": now, "fetched_at": now, "last_error": nil, "updated_at": now,
			}),
		}).
		Table("platform_skill_repos").
		Create(map[string]any{"id": h.store.id(), "repo_key": key, "provider": "github", "source_json": string(sourceRaw), "ref": "HEAD", "version": repoVersion, "upstream_etag": tree.SHA, "packages_json": string(packagesRaw), "partial": false, "skill_count": len(packages), "size_bytes": total, "warnings_json": "[]", "checked_at": now, "fetched_at": now, "ref_count": 0, "last_error": nil, "created_at": now, "updated_at": now}).Error
	if e != nil {
		return nil, e
	}
	return map[string]any{"repoKey": key, "version": repoVersion, "skillCount": len(packages), "sizeBytes": total}, nil
}
func (h *handler) syncSkillRepo(w http.ResponseWriter, r *http.Request) {
	h.syncSkillRepoParts(w, r, chi.URLParam(r, "owner"), chi.URLParam(r, "repo"))
}
func (h *handler) syncSkillRepoBySlug(w http.ResponseWriter, r *http.Request) {
	tail := strings.Trim(chi.URLParam(r, "*"), "/")
	tail = strings.TrimSuffix(tail, "/sync")
	parts := strings.SplitN(tail, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid repository slug")
		return
	}
	h.syncSkillRepoParts(w, r, parts[0], parts[1])
}
func (h *handler) syncSkillRepoParts(w http.ResponseWriter, r *http.Request, owner, repo string) {
	x, e := h.syncRepo(r.Context(), "github", owner, repo)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	var m models.PlatformSkillRepo
	if e := h.deps.Gorm.WithContext(r.Context()).Where("repo_key = ?", "github:"+owner+"/"+repo+"@HEAD").Take(&m).Error; e != nil {
		httpx.JSON(w, 200, map[string]any{"repo": x})
		return
	}
	httpx.JSON(w, 200, map[string]any{"repo": skillRepoSummary(m)})
}
func (h *handler) skillCacheStatus(w http.ResponseWriter, r *http.Request) {
	var ms []models.PlatformSkillRepo
	if e := h.deps.Gorm.WithContext(r.Context()).Order("checked_at DESC").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	repos := make([]map[string]any, 0, len(ms))
	var totalSkills, totalBytes int64
	for _, m := range ms {
		repos = append(repos, skillRepoSummary(m))
		totalSkills += int64(m.SkillCount)
		totalBytes += int64(m.SizeBytes)
	}
	httpx.JSON(w, 200, map[string]any{"repos": repos, "totalSkills": totalSkills, "totalBytes": totalBytes, "refreshIntervalMs": skillRefreshIntervalMs})
}

type repoSkillVersions struct {
	packages map[string]string
	version  string
}

func (v repoSkillVersions) upstream(name string) string {
	if x := v.packages[name]; x != "" {
		return x
	}
	return v.version
}

func (h *handler) repoSkillVersions(ctx context.Context, repoKey string) repoSkillVersions {
	out := repoSkillVersions{packages: map[string]string{}}
	var row struct {
		Version      *string `gorm:"column:version"`
		PackagesJSON string  `gorm:"column:packages_json"`
	}
	if e := h.deps.Gorm.WithContext(ctx).Table("platform_skill_repos").Select("version, packages_json").Where("repo_key = ?", repoKey).Take(&row).Error; e != nil {
		return out
	}
	if row.Version != nil {
		out.version = *row.Version
	}
	var pkgs []struct{ Name, Version string }
	_ = json.Unmarshal([]byte(row.PackagesJSON), &pkgs)
	for _, p := range pkgs {
		out.packages[p.Name] = p.Version
	}
	return out
}

func (h *handler) pendingSkillUpdates(ctx context.Context, tenant string) int {
	type skillRow struct {
		Name    string  `gorm:"column:name"`
		Version *string `gorm:"column:version"`
		RepoKey string  `gorm:"column:repo_key"`
	}
	var rows []skillRow
	if e := h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Select("name, version, repo_key").Where("tenant_id = ? AND repo_key IS NOT NULL", tenant).Find(&rows).Error; e != nil {
		return 0
	}
	cache := map[string]repoSkillVersions{}
	pending := 0
	for _, row := range rows {
		v, ok := cache[row.RepoKey]
		if !ok {
			v = h.repoSkillVersions(ctx, row.RepoKey)
			cache[row.RepoKey] = v
		}
		latest := v.upstream(row.Name)
		if latest == "" {
			continue
		}
		if row.Version == nil || *row.Version != latest {
			pending++
		}
	}
	return pending
}

func (h *handler) recordSkillAutoRun(ctx context.Context, tenant string, summary skillUpdateSummary) {
	var enabled int64
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = false AND auto_update = true", tenant).Count(&enabled).Error
	state, _ := h.getSetting(ctx, tenant, skillAutoUpdateKey)
	if state == nil {
		state = map[string]any{}
	}
	state["enabled"] = enabled > 0
	state["lastRunAt"] = runtimeTimeString(h.store.now())
	state["lastResult"] = summary
	_ = h.putSetting(ctx, tenant, skillAutoUpdateKey, state)
}

func (h *handler) skillAutoUpdatePayload(r *http.Request, tenant string) map[string]any {
	ctx := r.Context()
	var enabled int64
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = false AND auto_update = true", tenant).Count(&enabled).Error
	stored, _ := h.getSetting(ctx, tenant, skillAutoUpdateKey)
	var lastRunAt any
	if v, ok := stored["lastRunAt"]; ok {
		lastRunAt = v
	}
	var lastResult any
	if v, ok := stored["lastResult"]; ok && v != nil {
		lastResult = v
	}
	return map[string]any{
		"enabled":      enabled > 0,
		"intervalMs":   skillRefreshIntervalMs,
		"lastRunAt":    lastRunAt,
		"lastResult":   lastResult,
		"pendingCount": h.pendingSkillUpdates(ctx, tenant),
	}
}
func (h *handler) skillAutoUpdateStatus(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, h.skillAutoUpdatePayload(r, principal(r).TenantID))
}
func (h *handler) putSkillAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled *bool `json:"enabled"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Enabled == nil {
		httpx.Error(w, 400, "enabled is required")
		return
	}
	tenant := principal(r).TenantID
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = false", tenant).Updates(map[string]any{"auto_update": *b.Enabled, "updated_at": runtimeTimeString(h.store.now())})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	state, _ := h.getSetting(r.Context(), tenant, skillAutoUpdateKey)
	if state == nil {
		state = map[string]any{}
	}
	state["enabled"] = *b.Enabled
	_ = h.putSetting(r.Context(), tenant, skillAutoUpdateKey, state)
	httpx.JSON(w, 200, map[string]any{"enabled": *b.Enabled, "updated": res.RowsAffected})
}
func (h *handler) checkSkillUpdates(w http.ResponseWriter, r *http.Request) {
	tenant := principal(r).TenantID
	type skillRow struct {
		Name    string  `gorm:"column:name"`
		Version *string `gorm:"column:version"`
		RepoKey string  `gorm:"column:repo_key"`
	}
	var rows []skillRow
	if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.Skill{}).Select("name, version, repo_key").Where("tenant_id = ? AND auto_update = true AND repo_key IS NOT NULL", tenant).Find(&rows).Error; e != nil {
		statusErr(w, e)
		return
	}
	type repoGroup struct {
		key    string
		owner  string
		repo   string
		skills []skillRow
	}
	groups := []*repoGroup{}
	index := map[string]*repoGroup{}
	for _, row := range rows {
		g, ok := index[row.RepoKey]
		if !ok {
			_, owner, repo := skillRepoParts(row.RepoKey)
			g = &repoGroup{key: row.RepoKey, owner: owner, repo: repo}
			index[row.RepoKey] = g
			groups = append(groups, g)
		}
		g.skills = append(g.skills, row)
	}
	summary := skillUpdateSummary{Updated: []string{}, Failed: []skillUpdateFailure{}}
	for _, g := range groups {
		if g.owner == "" || g.repo == "" {
			for _, s := range g.skills {
				summary.Failed = append(summary.Failed, skillUpdateFailure{Name: s.Name, Error: "invalid repository key"})
			}
			continue
		}
		if _, e := h.syncRepo(r.Context(), "github", g.owner, g.repo); e != nil {
			for _, s := range g.skills {
				summary.Failed = append(summary.Failed, skillUpdateFailure{Name: s.Name, Error: e.Error()})
			}
			continue
		}
		latest := h.repoSkillVersions(r.Context(), g.key)
		for _, s := range g.skills {
			v := latest.upstream(s.Name)
			if v != "" && (s.Version == nil || *s.Version != v) {
				summary.Updated = append(summary.Updated, s.Name)
			} else {
				summary.UpToDate++
			}
		}
	}
	h.recordSkillAutoRun(r.Context(), tenant, summary)
	httpx.JSON(w, 200, map[string]any{"result": summary, "status": h.skillAutoUpdatePayload(r, tenant)})
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
	updated, e := h.updateSkillFromCache(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"skill": updated})
}

func (h *handler) updateSkillFromCache(ctx context.Context, tenant, skillID string) (Skill, error) {
	var m models.Skill
	e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, skillID).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Skill{}, ErrNotFound
	}
	if e != nil {
		return Skill{}, e
	}
	if m.Builtin {
		return Skill{}, errors.New("builtin skill cannot be updated from cache")
	}
	if m.RepoKey == nil || *m.RepoKey == "" {
		return Skill{}, errors.New("skill has no cached repository source")
	}
	var row struct {
		PackagesJSON string `gorm:"column:packages_json"`
	}
	e = h.deps.Gorm.WithContext(ctx).Table("platform_skill_repos").Select("packages_json").Where("repo_key = ?", *m.RepoKey).Take(&row).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return Skill{}, sql.ErrNoRows
	}
	if e != nil {
		return Skill{}, e
	}
	versions := h.repoSkillVersions(ctx, *m.RepoKey)
	var all []struct {
		Name, Version string
		Files         []skillFile
	}
	if json.Unmarshal([]byte(row.PackagesJSON), &all) != nil {
		return Skill{}, errors.New("invalid repository cache")
	}
	for _, x := range all {
		if x.Name != m.Name {
			continue
		}
		size, e := validateSkillFiles(x.Files)
		if e != nil {
			return Skill{}, e
		}
		files, _ := json.Marshal(x.Files)
		version := x.Version
		if version == "" {
			version = versions.upstream(m.Name)
		}
		var versionValue any
		if version != "" {
			versionValue = version
		}
		if e = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id = ? AND id = ?", tenant, skillID).Updates(map[string]any{"version": versionValue, "files_json": string(files), "file_count": len(x.Files), "size_bytes": size, "updated_at": runtimeTimeString(h.store.now())}).Error; e != nil {
			return Skill{}, e
		}
		var updatedModel models.Skill
		if e = h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, skillID).Take(&updatedModel).Error; e != nil {
			return Skill{}, e
		}
		out := []Skill{skillFromModel(updatedModel)}
		h.enrichSkillRepoState(ctx, out)
		return out[0], nil
	}
	return Skill{}, ErrNotFound
}

func (h *handler) startSkillRefresh(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(15 * time.Second):
		}
		h.seedCuratedSkillRepos(ctx)
		h.runSkillMaintenance(ctx)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.runSkillMaintenance(ctx)
			}
		}
	}()
}

func (h *handler) seedCuratedSkillRepos(ctx context.Context) {
	now := runtimeTimeString(h.store.now())
	for _, c := range curatedSkillRepos {
		parts := strings.SplitN(c.Slug, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		sourceRaw, _ := json.Marshal(map[string]any{"provider": "github", "owner": parts[0], "repo": parts[1], "ref": "HEAD"})
		_ = h.deps.Gorm.WithContext(ctx).
			Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "repo_key"}}, DoNothing: true}).
			Table("platform_skill_repos").
			Create(map[string]any{"id": h.store.id(), "repo_key": curatedRepoKey(c.Slug), "provider": "github", "source_json": string(sourceRaw), "ref": "HEAD", "version": nil, "upstream_etag": nil, "packages_json": "[]", "partial": false, "skill_count": 0, "size_bytes": 0, "warnings_json": "[]", "checked_at": skillRepoEpoch, "fetched_at": skillRepoEpoch, "ref_count": 0, "last_error": nil, "created_at": now, "updated_at": now}).Error
	}
}

func (h *handler) runSkillMaintenance(ctx context.Context) {
	h.refreshStaleSkillRepos(ctx, skillRepoRefreshBatch)
	h.backfillSkillRepoKeys(ctx)
	for _, tenant := range h.activeSkillTenantIDs(ctx, skillMaintenanceTenantBatch) {
		_ = h.autoUpdateTenant(ctx, tenant)
	}
}

func (h *handler) refreshStaleSkillRepos(ctx context.Context, limit int) {
	cutoff := runtimeTimeString(h.store.now().Add(-skillRepoCacheTTL))
	var rows []models.PlatformSkillRepo
	if e := h.deps.Gorm.WithContext(ctx).Where("checked_at < ?", cutoff).Order("checked_at").Limit(limit * 4).Find(&rows).Error; e != nil {
		return
	}
	sort.SliceStable(rows, func(i, j int) bool {
		is, _, _ := skillRepoParts(rows[i].RepoKey)
		js, _, _ := skillRepoParts(rows[j].RepoKey)
		ci := curatedRepoBySlug(is) != nil
		cj := curatedRepoBySlug(js) != nil
		if ci != cj {
			return ci
		}
		return rows[i].RefCount > rows[j].RefCount
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	for _, row := range rows {
		var src struct{ Owner, Repo string }
		_ = json.Unmarshal([]byte(row.SourceJSON), &src)
		if src.Owner == "" || src.Repo == "" {
			continue
		}
		_, _ = h.syncRepo(ctx, row.Provider, src.Owner, src.Repo)
	}
}

func (h *handler) backfillSkillRepoKeys(ctx context.Context) {
	var rows []models.Skill
	if e := h.deps.Gorm.WithContext(ctx).Where("builtin = false AND repo_key IS NULL").Limit(200).Find(&rows).Error; e != nil {
		return
	}
	for _, row := range rows {
		if row.ID == nil {
			continue
		}
		repoKey := repoKeyOfSource(skillSourceFromJSON(json.RawMessage(row.SourceJSON)))
		if repoKey == "" {
			continue
		}
		_ = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("id = ?", *row.ID).Update("repo_key", repoKey).Error
	}
}

func (h *handler) activeSkillTenantIDs(ctx context.Context, limit int) []string {
	var agentTenants, skillTenants []string
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.Agent{}).Distinct().Pluck("tenant_id", &agentTenants).Error
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.Skill{}).Distinct().Pluck("tenant_id", &skillTenants).Error
	seen := map[string]bool{}
	out := make([]string, 0, len(agentTenants)+len(skillTenants))
	for _, t := range append(agentTenants, skillTenants...) {
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Strings(out)
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (h *handler) autoUpdateTenant(ctx context.Context, tenant string) skillUpdateSummary {
	summary := skillUpdateSummary{Updated: []string{}, Failed: []skillUpdateFailure{}}
	var rows []models.Skill
	if e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND builtin = false", tenant).Find(&rows).Error; e != nil {
		return summary
	}
	cache := map[string]repoSkillVersions{}
	for _, row := range rows {
		if !row.AutoUpdate || row.RepoKey == nil || *row.RepoKey == "" {
			continue
		}
		v, ok := cache[*row.RepoKey]
		if !ok {
			v = h.repoSkillVersions(ctx, *row.RepoKey)
			cache[*row.RepoKey] = v
		}
		latest := v.upstream(row.Name)
		if latest == "" || row.Version == nil || *row.Version == latest {
			summary.UpToDate++
			continue
		}
		if row.ID == nil {
			continue
		}
		if _, e := h.updateSkillFromCache(ctx, tenant, *row.ID); e != nil {
			summary.Failed = append(summary.Failed, skillUpdateFailure{Name: row.Name, Error: e.Error()})
		} else {
			summary.Updated = append(summary.Updated, row.Name)
		}
	}
	h.recordSkillAutoRun(ctx, tenant, summary)
	return summary
}

var _ = bytes.NewBuffer
