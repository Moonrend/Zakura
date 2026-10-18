// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/runtime/builtins"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type skillCachedPackage struct {
	Name        string      `json:"name"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Version     string      `json:"version"`
	Files       []skillFile `json:"files"`
	Homepage    *string     `json:"homepage,omitempty"`
	License     *string     `json:"license,omitempty"`
}

func skillFileFromBytes(p string, b []byte) skillFile {
	f := skillFile{Path: p, Content: string(b), Encoding: "utf8", Size: len(b)}
	if !utf8.Valid(b) {
		f.Content = base64.StdEncoding.EncodeToString(b)
		f.Encoding = "base64"
	}
	return f
}
func skillManifestMeta(manifest, fallback string) (string, string) {
	title := fallback
	description := ""
	text := strings.TrimPrefix(strings.ReplaceAll(manifest, "\r\n", "\n"), string(rune(0xfeff)))
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			for _, line := range strings.Split(text[4:4+end], "\n") {
				key, value, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				value = strings.Trim(strings.TrimSpace(value), "\"'")
				switch strings.TrimSpace(key) {
				case "name":
					if value != "" {
						title = value
					}
				case "description":
					description = value
				}
			}
		}
	}
	return title, description
}
func skillBody(manifest string) string {
	text := strings.TrimPrefix(strings.ReplaceAll(manifest, "\r\n", "\n"), string(rune(0xfeff)))
	if strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			return strings.TrimSpace(text[4+end+4:])
		}
	}
	return text
}

// Parse the supported source dialects once, preserving ref/path/selection in the
// repo key. Unsupported hosts/protocols never become arbitrary server fetches.
func parseSkillSource(input string) (skillSource, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return skillSource{}, errors.New("source required")
	}
	if strings.HasPrefix(strings.ToLower(raw), "builtin:") {
		name := strings.TrimSpace(raw[len("builtin:"):])
		if name == "" {
			return skillSource{}, errors.New("builtin name required")
		}
		return skillSource{Kind: "builtin", Skills: []string{name}}, nil
	}
	fields := strings.Fields(raw)
	if len(fields) >= 4 && (fields[0] == "npx" || fields[0] == "bunx") && (fields[1] == "skills" || strings.HasPrefix(fields[1], "skills@")) && fields[2] == "add" {
		raw = strings.Trim(fields[3], "\"'")
		selected := []string{}
		for i := 4; i < len(fields); i++ {
			if fields[i] == "--skill" || fields[i] == "-s" {
				i++
				for ; i < len(fields) && !strings.HasPrefix(fields[i], "-"); i++ {
					selected = append(selected, strings.Trim(fields[i], "\"'"))
				}
				i--
			}
		}
		src, err := parseSkillSource(raw)
		if len(selected) > 0 {
			src.Skills = selected
		}
		return src, err
	}
	src := skillSource{Kind: "github", Ref: "HEAD"}
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
			return src, errors.New("only public HTTPS GitHub/GitLab sources are supported")
		}
		switch strings.ToLower(u.Hostname()) {
		case "github.com":
			src.Kind = "github"
		case "gitlab.com":
			src.Kind = "gitlab"
		default:
			return src, errors.New("unsupported skill source host")
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) < 2 {
			return src, errors.New("source must identify owner/repo")
		}
		src.Owner = parts[0]
		src.Repo = strings.TrimSuffix(parts[1], ".git")
		rest := parts[2:]
		if len(rest) > 0 && rest[0] == "-" {
			rest = rest[1:]
		}
		if len(rest) >= 2 && (rest[0] == "tree" || rest[0] == "blob") {
			src.Ref = rest[1]
			if len(rest) > 2 {
				src.Path = strings.Join(rest[2:], "/")
				if path.Base(src.Path) == "SKILL.md" {
					src.Path = path.Dir(src.Path)
				}
			}
		} else if len(rest) > 0 {
			return src, errors.New("unsupported repository URL path")
		}
		if u.Fragment != "" {
			src.Skills = strings.Split(u.Fragment, ",")
		}
	} else {
		raw = strings.TrimPrefix(raw, "github:")
		if strings.HasPrefix(raw, "gitlab:") {
			src.Kind = "gitlab"
			raw = strings.TrimPrefix(raw, "gitlab:")
		}
		if repo, selection, ok := strings.Cut(raw, "@"); ok {
			raw = repo
			src.Skills = strings.Split(selection, ",")
		}
		if repo, scope, ok := strings.Cut(raw, "#"); ok {
			raw = repo
			src.Path = scope
		}
		parts := strings.Split(raw, "/")
		if len(parts) < 2 {
			return src, errors.New("source must identify owner/repo")
		}
		src.Owner = parts[0]
		src.Repo = strings.TrimSuffix(parts[1], ".git")
		if len(parts) > 2 {
			src.Path = strings.Join(parts[2:], "/")
		}
	}
	for _, part := range []string{src.Owner, src.Repo, src.Ref} {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\x00 ?&#") {
			return src, errors.New("invalid repository source")
		}
	}
	if src.Path != "" && (path.Clean(src.Path) != src.Path || strings.HasPrefix(src.Path, "/") || src.Path == ".." || strings.HasPrefix(src.Path, "../") || strings.ContainsAny(src.Path, "\\\x00:")) {
		return src, errors.New("invalid source subpath")
	}
	return src, nil
}
func skillSourceJSON(src skillSource) json.RawMessage {
	if src.Kind == "builtin" {
		raw, _ := json.Marshal(map[string]any{"kind": "builtin", "builtinId": src.Skills[0], "raw": "builtin:" + src.Skills[0], "store": "builtin"})
		return raw
	}
	src.Skills = nil
	raw, _ := json.Marshal(src)
	return raw
}
func skillSourceMatches(a, b string) bool {
	var x, y map[string]any
	_ = json.Unmarshal([]byte(a), &x)
	_ = json.Unmarshal([]byte(b), &y)
	for _, key := range []string{"raw", "store", "skills"} {
		delete(x, key)
		delete(y, key)
	}
	left, _ := json.Marshal(x)
	right, _ := json.Marshal(y)
	return string(left) == string(right)
}
func (h *handler) registerSkillPackage(ctx context.Context, tenant string, pkg skillCachedPackage, source json.RawMessage, repoKey *string) (Skill, error) {
	if pkg.Name == "" || pkg.Name != slugify(pkg.Name) {
		return Skill{}, errors.New("invalid skill name")
	}
	files, size, err := normalizeSkillFiles(pkg.Files)
	if err != nil {
		return Skill{}, err
	}
	pkg.Files = files
	var existing models.Skill
	err = h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND name=?", tenant, pkg.Name).Take(&existing).Error
	if err == nil {
		if !skillSourceMatches(existing.SourceJSON, string(source)) {
			return Skill{}, errSkillConflict
		}
		if repoKey == nil {
			var oldFiles []skillFile
			_ = json.Unmarshal([]byte(existing.FilesJSON), &oldFiles)
			if skillRevision(oldFiles) != skillRevision(files) {
				return Skill{}, errSkillConflict
			}
		}
		return skillFromModel(existing), nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Skill{}, err
	}
	now := runtimeTimeString(h.store.now())
	id := h.store.id()
	filesRaw, _ := json.Marshal(files)
	version := pkg.Version
	if version == "" {
		version = skillRevision(files)
	}
	m := models.Skill{ID: &id, TenantID: tenant, Name: pkg.Name, Title: pkg.Title, Description: pkg.Description, Version: &version, SourceJSON: string(source), FilesJSON: string(filesRaw), Homepage: pkg.Homepage, License: pkg.License, FileCount: int32(len(files)), SizeBytes: int32(size), RepoKey: repoKey, AutoUpdate: repoKey != nil, CreatedAt: now, UpdatedAt: now}
	result := h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant_id"}, {Name: "name"}}, DoNothing: true}).Create(&m)
	if result.Error != nil {
		return Skill{}, result.Error
	}
	if result.RowsAffected == 0 {
		return h.registerSkillPackage(ctx, tenant, pkg, source, repoKey)
	}
	return skillFromModel(m), nil
}
func (h *handler) resolveSkillPackages(ctx context.Context, tenant, input string) (skillSource, []skillCachedPackage, []string, error) {
	src, err := parseSkillSource(input)
	if err != nil {
		return src, nil, nil, err
	}
	warnings := []string{}
	if src.Kind == "builtin" {
		packages := []skillCachedPackage{}
		for _, def := range builtins.All() {
			if def.Name == src.Skills[0] || src.Skills[0] == "*" {
				manifest := def.Manifest()
				packages = append(packages, skillCachedPackage{Name: def.Name, Title: def.Title, Description: def.Description, Version: def.Version(), Files: []skillFile{skillFileFromBytes("SKILL.md", []byte(manifest))}})
			}
		}
		if len(packages) == 0 {
			return src, nil, nil, ErrNotFound
		}
		return src, packages, warnings, nil
	}
	key := repoKeyOfSource(src)
	var row models.PlatformSkillRepo
	err = h.deps.Gorm.WithContext(ctx).Where("repo_key=?", key).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) || err == nil && (isZeroRepoTime(row.FetchedAt) || row.Partial) {
		_, err = h.syncSkillSource(ctx, tenant, src)
		if err == nil {
			err = h.deps.Gorm.WithContext(ctx).Where("repo_key=?", key).Take(&row).Error
		}
	}
	if err != nil {
		return src, nil, nil, err
	}
	var packages []skillCachedPackage
	if err = json.Unmarshal([]byte(row.PackagesJSON), &packages); err != nil {
		return src, nil, nil, err
	}
	if len(src.Skills) > 0 && !listContains(src.Skills, "*") {
		selected := []skillCachedPackage{}
		for _, pkg := range packages {
			if listContains(src.Skills, pkg.Name) {
				selected = append(selected, pkg)
			}
		}
		if len(selected) != len(src.Skills) {
			return src, nil, nil, errors.New("selected skill not found in source")
		}
		packages = selected
	}
	return src, packages, warnings, nil
}
func (h *handler) skillFetchJSON(ctx context.Context, tenant, provider, target string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return err
	}
	if token, e := h.skillToken(ctx, tenant, provider); e == nil && token != "" {
		if provider == "gitlab" {
			req.Header.Set("PRIVATE-TOKEN", token)
		} else {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return errors.New("skill fetch redirects are not supported")
	}}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("skill source returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 8<<20 {
		return errors.New("skill response too large")
	}
	return json.Unmarshal(raw, out)
}
func (h *handler) syncRepo(ctx context.Context, provider, owner, repo string) (map[string]any, error) {
	return h.syncSkillSource(ctx, "platform", skillSource{Kind: provider, Owner: owner, Repo: repo, Ref: "HEAD"})
}
func (h *handler) syncSkillSource(ctx context.Context, tenant string, src skillSource) (map[string]any, error) {
	type treeEntry struct {
		Path string `json:"path"`
		Type string `json:"type"`
		SHA  string `json:"sha"`
		Mode string `json:"mode"`
		Size int    `json:"size"`
		URL  string `json:"url"`
	}
	entries := []treeEntry{}
	revision := ""
	base := ""
	ref := src.Ref
	if ref == "" {
		ref = "HEAD"
	}
	if src.Kind == "github" {
		base = "https://api.github.com/repos/" + url.PathEscape(src.Owner) + "/" + url.PathEscape(src.Repo)
		var metadata struct {
			Private *bool `json:"private"`
		}
		if err := h.skillFetchJSON(ctx, tenant, src.Kind, base, &metadata); err != nil {
			return nil, err
		}
		if metadata.Private == nil || *metadata.Private {
			return nil, errors.New("shared skill cache only supports public repositories")
		}
		var tree struct {
			SHA       string      `json:"sha"`
			Tree      []treeEntry `json:"tree"`
			Truncated bool        `json:"truncated"`
		}
		if err := h.skillFetchJSON(ctx, tenant, src.Kind, base+"/git/trees/"+url.PathEscape(ref)+"?recursive=1", &tree); err != nil {
			return nil, err
		}
		if tree.Truncated {
			return nil, errors.New("repository tree is truncated")
		}
		entries = tree.Tree
		revision = tree.SHA
	} else if src.Kind == "gitlab" {
		base = "https://gitlab.com/api/v4/projects/" + url.PathEscape(src.Owner+"/"+src.Repo)
		var metadata struct {
			Visibility string `json:"visibility"`
		}
		if err := h.skillFetchJSON(ctx, tenant, src.Kind, base, &metadata); err != nil {
			return nil, err
		}
		if metadata.Visibility != "public" {
			return nil, errors.New("shared skill cache only supports public repositories")
		}
		var commit struct {
			ID string `json:"id"`
		}
		if err := h.skillFetchJSON(ctx, tenant, src.Kind, base+"/repository/commits/"+url.PathEscape(ref), &commit); err != nil {
			return nil, err
		}
		revision = commit.ID
		for page := 1; page <= 100; page++ {
			var tree []struct{ Path, Type, ID, Mode string }
			target := base + "/repository/tree?recursive=true&per_page=100&page=" + strconv.Itoa(page) + "&ref=" + url.QueryEscape(revision)
			if err := h.skillFetchJSON(ctx, tenant, src.Kind, target, &tree); err != nil {
				return nil, err
			}
			for _, entry := range tree {
				entries = append(entries, treeEntry{Path: entry.Path, Type: entry.Type, SHA: entry.ID, Mode: entry.Mode})
			}
			if len(tree) < 100 {
				break
			}
			if page == 100 {
				return nil, errors.New("repository tree too large")
			}
		}
	} else {
		return nil, errors.New("unsupported repository provider")
	}
	if revision == "" {
		return nil, errors.New("source returned no immutable revision")
	}
	dirs := []string{}
	for _, entry := range entries {
		if entry.Type != "blob" || path.Base(entry.Path) != "SKILL.md" {
			continue
		}
		dir := path.Dir(entry.Path)
		if dir == "." {
			dir = ""
		}
		if src.Path != "" && dir != src.Path && !strings.HasPrefix(dir, src.Path+"/") {
			continue
		}
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	if len(dirs) > 100 {
		return nil, errors.New("repository contains too many skills")
	}
	packages := []skillCachedPackage{}
	names := map[string]bool{}
	var total int64
	for _, dir := range dirs {
		pkg := skillCachedPackage{Name: slugify(path.Base(dir)), Version: revision, Files: []skillFile{}}
		if dir == "" {
			pkg.Name = slugify(src.Repo)
		}
		for _, entry := range entries {
			if entry.Type != "blob" || entry.Mode == "120000" || entry.Mode == "160000" {
				continue
			}
			relative := entry.Path
			if dir != "" {
				if !strings.HasPrefix(entry.Path, dir+"/") {
					continue
				}
				relative = strings.TrimPrefix(entry.Path, dir+"/")
			}
			nested := false
			for _, other := range dirs {
				if other != dir && strings.HasPrefix(entry.Path, other+"/") && (dir == "" || strings.HasPrefix(other, dir+"/")) {
					nested = true
					break
				}
			}
			if nested {
				continue
			}
			if entry.Size > 512<<10 || len(pkg.Files) >= 64 {
				return nil, errors.New("skill exceeds file limits")
			}
			target := base + "/git/blobs/" + url.PathEscape(entry.SHA)
			if src.Kind == "gitlab" {
				target = base + "/repository/blobs/" + url.PathEscape(entry.SHA)
			}
			var blob struct {
				Content, Encoding string
				Size              int
			}
			if err := h.skillFetchJSON(ctx, tenant, src.Kind, target, &blob); err != nil {
				return nil, err
			}
			if blob.Encoding != "base64" {
				return nil, errors.New("unsupported source blob encoding")
			}
			data, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(blob.Content, "\n", ""))
			if err != nil {
				return nil, err
			}
			pkg.Files = append(pkg.Files, skillFileFromBytes(relative, data))
			if relative == "SKILL.md" {
				pkg.Title, pkg.Description = skillManifestMeta(string(data), pkg.Name)
			}
		}
		files, size, err := normalizeSkillFiles(pkg.Files)
		if err != nil {
			return nil, err
		}
		pkg.Files = files
		if names[pkg.Name] {
			return nil, errors.New("repository contains duplicate skill names")
		}
		names[pkg.Name] = true
		total += size
		if total > 32<<20 {
			return nil, errors.New("repository skill cache exceeds 32 MiB")
		}
		packages = append(packages, pkg)
	}
	raw, _ := json.Marshal(packages)
	source, _ := json.Marshal(src)
	now := runtimeTimeString(h.store.now())
	key := repoKeyOfSource(src)
	err := h.deps.Gorm.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "repo_key"}}, DoUpdates: clause.Assignments(map[string]any{"version": revision, "upstream_etag": revision, "packages_json": string(raw), "partial": false, "skill_count": len(packages), "size_bytes": total, "checked_at": now, "fetched_at": now, "last_error": nil, "updated_at": now})}).Table("platform_skill_repos").Create(map[string]any{"id": h.store.id(), "repo_key": key, "provider": src.Kind, "source_json": string(source), "ref": ref, "version": revision, "upstream_etag": revision, "packages_json": string(raw), "partial": false, "skill_count": len(packages), "size_bytes": total, "warnings_json": "[]", "checked_at": now, "fetched_at": now, "ref_count": 0, "last_error": nil, "created_at": now, "updated_at": now}).Error
	return map[string]any{"repoKey": key, "version": revision, "skillCount": len(packages), "sizeBytes": total}, err
}

func (h *handler) searchSkillStore(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.authorizeSkillSpace(w, r); !ok {
		return
	}
	store := r.URL.Query().Get("store")
	if store == "" {
		store = "curated"
	}
	if !listContains([]string{"builtin", "curated", "skills-sh", "github"}, store) {
		httpx.Error(w, 400, "unknown skill store")
		return
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 24
	}
	if limit > 100 {
		limit = 100
	}
	term := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	tenant := principal(r).TenantID
	items := []map[string]any{}
	installed := map[string]bool{}
	var registered []models.Skill
	_ = h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=?", tenant).Find(&registered).Error
	for _, m := range registered {
		installed[m.Name] = true
	}
	if space := chi.URLParam(r, "spaceId"); space != "" {
		installed = map[string]bool{}
		var rows []spaceSkill
		if err := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id=? AND space_id=? AND status='installed'", tenant, space).Find(&rows).Error; err != nil {
			skillHTTPError(w, err)
			return
		}
		for _, row := range rows {
			installed[row.Name] = true
		}
	}
	add := func(id, name, title, description, source, spec string, extra map[string]any) {
		if term != "" && !strings.Contains(strings.ToLower(name+" "+title+" "+description+" "+source), term) {
			return
		}
		item := map[string]any{"id": id, "store": store, "name": name, "title": title, "description": description, "source": source, "installSpec": spec, "installed": installed[name]}
		for k, v := range extra {
			item[k] = v
		}
		items = append(items, item)
	}
	if store == "builtin" {
		for _, d := range builtins.All() {
			add("builtin:"+d.Name, d.Name, d.Title, d.Description, "builtin", "builtin:"+d.Name, nil)
		}
	}
	if store == "curated" || store == "github" || store == "skills-sh" {
		var repos []models.PlatformSkillRepo
		if err := h.deps.Gorm.WithContext(r.Context()).Order("repo_key").Find(&repos).Error; err != nil {
			skillHTTPError(w, err)
			return
		}
		for _, repo := range repos {
			slug, _, _ := skillRepoParts(repo.RepoKey)
			if store == "curated" && curatedRepoBySlug(slug) == nil {
				continue
			}
			if filter := r.URL.Query().Get("repo"); filter != "" && slug != filter && repo.RepoKey != filter {
				continue
			}
			var pkgs []skillCachedPackage
			_ = json.Unmarshal([]byte(repo.PackagesJSON), &pkgs)
			var src skillSource
			_ = json.Unmarshal([]byte(repo.SourceJSON), &src)
			prefix := slug
			if src.Kind == "gitlab" || repo.Provider == "gitlab" {
				prefix = "gitlab:" + slug
			}
			if src.Ref != "" && src.Ref != "HEAD" {
				prefix = "https://" + repo.Provider + ".com/" + slug + "/tree/" + src.Ref
			}
			if src.Path != "" {
				prefix += "/" + src.Path
			}
			for _, pkg := range pkgs {
				spec := prefix + "@" + pkg.Name
				if strings.HasPrefix(prefix, "https://") {
					spec = prefix + "#" + pkg.Name
				}
				add(repo.RepoKey+":"+pkg.Name, pkg.Name, pkg.Title, pkg.Description, slug, spec, map[string]any{"cached": !repo.Partial, "repoSlug": slug})
			}
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["id"].(string) < items[j]["id"].(string) })
	total := len(items)
	start := offset
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}
	result := map[string]any{"store": store, "items": items[start:end], "total": total, "offset": offset, "limit": limit, "hasMore": end < total}
	if src, err := parseSkillSource(r.URL.Query().Get("q")); err == nil {
		result["direct"] = map[string]any{"id": "direct:" + term, "store": store, "name": src.Repo, "title": r.URL.Query().Get("q"), "description": "", "source": r.URL.Query().Get("q"), "installSpec": r.URL.Query().Get("q")}
	}
	// Do not misrepresent a cached subset as an online search result.
	if store == "skills-sh" {
		result["items"] = []any{}
		result["total"] = 0
		result["hasMore"] = false
		result["error"] = "skills.sh search is unavailable; paste a repository source to install"
	}
	if store == "github" || store == "skills-sh" {
		h.searchOnlineSkillStore(r, store, term, offset, limit, result)
	}
	httpx.JSON(w, 200, result)
}

func (h *handler) searchOnlineSkillStore(r *http.Request, store, term string, offset, limit int, result map[string]any) {
	items := []map[string]any{}
	tenant := principal(r).TenantID
	var err error
	if store == "skills-sh" {
		var response struct {
			Skills []struct {
				ID, Name, SkillID, Source string
				Installs                  int
			}
			Count int
			Total int
		}
		err = h.skillFetchJSON(r.Context(), tenant, "", "https://skills.sh/api/search?q="+url.QueryEscape(term)+"&limit="+strconv.Itoa(offset+limit), &response)
		if err == nil {
			for _, s := range response.Skills {
				name := s.SkillID
				if name == "" {
					name = s.Name
				}
				if s.Source == "" {
					continue
				}
				items = append(items, map[string]any{"id": s.ID, "store": store, "name": name, "title": s.Name, "description": "", "source": s.Source, "installSpec": s.Source + "@" + name, "installs": s.Installs})
			}
			total := response.Total
			if total == 0 {
				total = response.Count
			}
			if total < len(items) {
				total = len(items)
			}
			start := offset
			if start > len(items) {
				start = len(items)
			}
			end := start + limit
			if end > len(items) {
				end = len(items)
			}
			result["items"] = items[start:end]
			result["total"] = total
			result["hasMore"] = offset+end-start < total
		}
	} else {
		query := term
		if query == "" {
			query = "topic:agent-skills"
		} else {
			query += " topic:agent-skills"
		}
		page := offset/100 + 1
		skip := offset % 100
		var response struct {
			Total int `json:"total_count"`
			Items []struct {
				ID          int64
				FullName    string `json:"full_name"`
				Name        string
				Description string
				Stars       int    `json:"stargazers_count"`
				URL         string `json:"html_url"`
			}
		}
		err = h.skillFetchJSON(r.Context(), tenant, "github", "https://api.github.com/search/repositories?q="+url.QueryEscape(query)+"&sort=stars&per_page=100&page="+strconv.Itoa(page), &response)
		if err == nil {
			total := response.Total
			if skip+limit > 100 && page*100 < total {
				var next struct {
					Items []struct {
						ID                int64
						FullName          string `json:"full_name"`
						Name, Description string
						Stars             int    `json:"stargazers_count"`
						URL               string `json:"html_url"`
					}
				}
				err = h.skillFetchJSON(r.Context(), tenant, "github", "https://api.github.com/search/repositories?q="+url.QueryEscape(query)+"&sort=stars&per_page=100&page="+strconv.Itoa(page+1), &next)
				if err == nil {
					response.Items = append(response.Items, next.Items...)
				}
			}
			for _, repo := range response.Items {
				items = append(items, map[string]any{"id": strconv.FormatInt(repo.ID, 10), "store": store, "name": repo.Name, "title": repo.FullName, "description": repo.Description, "source": repo.FullName, "installSpec": repo.FullName, "stars": repo.Stars, "homepage": repo.URL})
			}
			if skip > len(items) {
				skip = len(items)
			}
			end := skip + limit
			if end > len(items) {
				end = len(items)
			}
			result["items"] = items[skip:end]
			result["total"] = response.Total
			result["hasMore"] = offset+end-skip < response.Total
		}
	}
	if err != nil {
		result["items"] = []any{}
		result["total"] = 0
		result["hasMore"] = false
		result["error"] = err.Error()
	} else {
		delete(result, "error")
	}
}
