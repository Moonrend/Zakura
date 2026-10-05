// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
)

type remoteWorkspace struct {
	runner  *runnerSession
	spaceID string
}

func runnerWorkspacePath(value string) (string, error) {
	if strings.ContainsRune(value, 0) {
		return "", errors.New("workspace path cannot contain NUL")
	}
	value = strings.ReplaceAll(value, "\\", "/")
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", errors.New("path escapes workspace")
		}
	}
	if value == "" {
		return "/", nil
	}
	return value, nil
}

func (h *handler) remoteWorkspace(ctx context.Context, tenant, agent string) (*remoteWorkspace, bool, error) {
	var spaceID, nodeID string
	err := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT a.space_id,COALESCE(s.runtime_node_id,'') FROM agents a JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.id=?`), tenant, agent).Scan(&spaceID, &nodeID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if nodeID == "" {
		return nil, false, nil
	}
	runner, err := h.hub.get(nodeID)
	if err != nil {
		return nil, true, err
	}
	return &remoteWorkspace{runner: runner, spaceID: spaceID}, true, nil
}

func (h *handler) remoteFSRequest(w http.ResponseWriter, r *http.Request) (*remoteWorkspace, bool, bool) {
	remote, selected, err := h.remoteWorkspace(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil {
		writeRemoteError(w, err)
		return nil, selected, false
	}
	return remote, selected, true
}

func (h *handler) remoteProject(r *http.Request) (*remoteWorkspace, bool, error) {
	remote, selected, err := h.remoteWorkspace(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if err != nil || !selected {
		return remote, selected, err
	}
	var count int
	err = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT COUNT(*) FROM space_projects p JOIN agents a ON a.space_id=p.space_id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=? AND a.id=? AND p.slug=?`), principal(r).TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "slug")).Scan(&count)
	if err != nil {
		return nil, true, err
	}
	if count == 0 {
		return nil, true, ErrNotFound
	}
	return remote, true, nil
}

func projectRemotePath(slug string, parts ...string) string {
	values := append([]string{"/projects", slug}, parts...)
	return path.Join(values...)
}

func (r *remoteWorkspace) projectSnapshot(ctx context.Context, slug string) map[string]any {
	instructions := map[string]any{"file": nil, "content": "", "claudeFallback": false}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		if raw, _, err := r.read(ctx, projectRemotePath(slug, name), 1<<20); err == nil {
			instructions["file"], instructions["content"], instructions["claudeFallback"] = name, string(raw), name == "CLAUDE.md"
			break
		}
	}
	events := map[string]any{}
	hookFile := any(nil)
	if raw, _, err := r.read(ctx, projectRemotePath(slug, ".zakura", "hooks.json"), 1<<20); err == nil {
		_ = json.Unmarshal(raw, &events)
		hookFile = ".zakura/hooks.json"
	}
	skills := []map[string]any{}
	_, entries, _ := r.list(ctx, projectRemotePath(slug, ".zakura", "skills"))
	for _, entry := range entries {
		if !entry.IsDir {
			continue
		}
		name := path.Base(entry.Path)
		raw, _, err := r.read(ctx, projectRemotePath(slug, ".zakura", "skills", name, "SKILL.md"), 1<<20)
		if err != nil {
			continue
		}
		description := ""
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") {
				description = line
				break
			}
		}
		skills = append(skills, map[string]any{"name": name, "title": name, "description": description, "path": ".zakura/skills/" + name + "/SKILL.md"})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i]["name"].(string) < skills[j]["name"].(string) })
	sources := []map[string]any{}
	if hookFile != nil {
		sources = append(sources, map[string]any{"file": hookFile, "events": events})
	}
	return map[string]any{"slug": slug, "exists": true, "instructions": instructions, "skills": skills, "hooks": map[string]any{"file": hookFile, "events": events, "sources": sources}}
}

func remotePathParams(spaceID, raw string) (map[string]any, error) {
	safe, err := runnerWorkspacePath(raw)
	if err != nil {
		return nil, err
	}
	return map[string]any{"spaceId": spaceID, "path": safe}, nil
}

func writeRemoteError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, 404, "Not found")
		return
	}
	if strings.Contains(err.Error(), "offline") {
		httpx.Error(w, 503, err.Error())
		return
	}
	statusErr(w, err)
}

type runnerFSEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime any    `json:"modTime"`
	IsDir   bool   `json:"isDir"`
}

func (r *remoteWorkspace) list(ctx context.Context, target string) (string, []runnerFSEntry, error) {
	params, err := remotePathParams(r.spaceID, target)
	if err != nil {
		return "", nil, err
	}
	var result struct {
		Path    string          `json:"path"`
		Entries []runnerFSEntry `json:"entries"`
	}
	err = r.runner.call(ctx, "host.fs.list", params, &result)
	return result.Path, result.Entries, err
}

func (r *remoteWorkspace) read(ctx context.Context, target string, max int64) ([]byte, map[string]any, error) {
	params, err := remotePathParams(r.spaceID, target)
	if err != nil {
		return nil, nil, err
	}
	params["max"] = max
	var result struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Base64  string `json:"base64"`
		Size    int64  `json:"size"`
	}
	if err = r.runner.call(ctx, "host.fs.read", params, &result); err != nil {
		return nil, nil, err
	}
	raw := []byte(result.Content)
	if result.Base64 != "" {
		raw, err = base64.StdEncoding.DecodeString(result.Base64)
		if err != nil {
			return nil, nil, err
		}
	}
	return raw, map[string]any{"path": result.Path, "content": string(raw), "size": len(raw)}, nil
}

func (r *remoteWorkspace) write(ctx context.Context, target string, data []byte) (map[string]any, error) {
	params, err := remotePathParams(r.spaceID, target)
	if err != nil {
		return nil, err
	}
	params["base64"] = base64.StdEncoding.EncodeToString(data)
	var result map[string]any
	err = r.runner.call(ctx, "host.fs.write", params, &result)
	return result, err
}

func (r *remoteWorkspace) archive(ctx context.Context, paths []string) ([]byte, error) {
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	written := int64(0)
	seen := map[string]bool{}
	var add func(string) error
	add = func(target string) error {
		safe, err := runnerWorkspacePath(target)
		if err != nil {
			return err
		}
		key := strings.TrimPrefix(path.Clean("/"+safe), "/")
		if key == "." {
			key = ""
		}
		if seen[key] {
			return nil
		}
		seen[key] = true
		params := map[string]any{"spaceId": r.spaceID, "path": safe}
		var stat runnerFSEntry
		if err = r.runner.call(ctx, "host.fs.stat", params, &stat); err != nil {
			return err
		}
		name := key
		if stat.IsDir {
			if name != "" {
				if err = tw.WriteHeader(&tar.Header{Name: name + "/", Typeflag: tar.TypeDir, Mode: 0o750}); err != nil {
					return err
				}
			}
			_, children, err := r.list(ctx, safe)
			if err != nil {
				return err
			}
			for _, child := range children {
				if err = add(child.Path); err != nil {
					return err
				}
			}
			return nil
		}
		data, _, err := r.read(ctx, safe, maxWorkspaceUpload-written+1)
		if err != nil {
			return err
		}
		written += int64(len(data))
		if written > maxWorkspaceUpload {
			return errors.New("archive exceeds size limit")
		}
		if name == "" {
			name = path.Base(safe)
		}
		if err = tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o640, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	}
	for _, target := range paths {
		if err := add(target); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return raw.Bytes(), nil
}

func (r *remoteWorkspace) extract(ctx context.Context, archivePath, destination string) error {
	raw, _, err := r.read(ctx, archivePath, maxWorkspaceUpload+1)
	if err != nil {
		return err
	}
	if len(raw) > maxWorkspaceUpload {
		return errors.New("archive exceeds size limit")
	}
	write := func(name string, data []byte, dir bool) error {
		clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
		if clean == "." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			return errors.New("archive path traversal")
		}
		target := path.Join(destination, clean)
		if dir {
			params, err := remotePathParams(r.spaceID, target)
			if err != nil {
				return err
			}
			return r.runner.call(ctx, "host.fs.mkdir", params, nil)
		}
		_, err := r.write(ctx, target, data)
		return err
	}
	if strings.HasSuffix(strings.ToLower(archivePath), ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
		if err != nil {
			return err
		}
		total := int64(0)
		for _, file := range zr.File {
			if file.Mode()&os.ModeSymlink != 0 {
				return errors.New("archive symlinks are not allowed")
			}
			total += int64(file.UncompressedSize64)
			if total > maxWorkspaceUpload {
				return errors.New("archive expands beyond limit")
			}
			if file.FileInfo().IsDir() {
				if err = write(file.Name, nil, true); err != nil {
					return err
				}
				continue
			}
			in, err := file.Open()
			if err != nil {
				return err
			}
			data, err := io.ReadAll(io.LimitReader(in, maxWorkspaceUpload+1))
			_ = in.Close()
			if err != nil {
				return err
			}
			if err = write(file.Name, data, false); err != nil {
				return err
			}
		}
		return nil
	}
	var reader io.Reader = bytes.NewReader(raw)
	if strings.HasSuffix(strings.ToLower(archivePath), ".gz") || strings.HasSuffix(strings.ToLower(archivePath), ".tgz") {
		gz, err := gzip.NewReader(reader)
		if err != nil {
			return err
		}
		defer gz.Close()
		reader = gz
	}
	tr := tar.NewReader(reader)
	total := int64(0)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir {
			return errors.New("archive links and special files are not allowed")
		}
		total += header.Size
		if total > maxWorkspaceUpload {
			return errors.New("archive expands beyond limit")
		}
		data := []byte(nil)
		if header.Typeflag == tar.TypeReg {
			data, err = io.ReadAll(io.LimitReader(tr, header.Size))
			if err != nil {
				return err
			}
		}
		if err = write(header.Name, data, header.Typeflag == tar.TypeDir); err != nil {
			return err
		}
	}
}
