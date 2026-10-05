// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

const maxWorkspaceUpload = 100 << 20

type workspaceFS struct{ root string }

func (h *handler) workspaceFor(ctx context.Context, tenant, agent string) (workspaceFS, error) {
	var space string
	e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), tenant, agent).Scan(&space)
	if errors.Is(e, sql.ErrNoRows) {
		return workspaceFS{}, ErrNotFound
	}
	if e != nil {
		return workspaceFS{}, e
	}
	base := os.Getenv("ZAKURA_WORKSPACE_ROOT")
	if base == "" {
		base = filepath.Join("data", "workspaces")
	}
	root := filepath.Join(base, tenant, space)
	if e = os.MkdirAll(root, 0o750); e != nil {
		return workspaceFS{}, e
	}
	abs, e := filepath.Abs(root)
	return workspaceFS{root: abs}, e
}
func (f workspaceFS) resolve(name string, existing bool) (string, error) {
	name = strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "/")
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." {
		clean = ""
	}
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace")
	}
	joined := filepath.Join(f.root, clean)
	parent := joined
	if !existing {
		parent = filepath.Dir(joined)
	}
	real, e := filepath.EvalSymlinks(parent)
	if e != nil {
		if !existing && errors.Is(e, os.ErrNotExist) {
			real = parent
		} else {
			return "", e
		}
	}
	rel, e := filepath.Rel(f.root, real)
	if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("symlink escapes workspace")
	}
	if existing {
		joined = real
	}
	return joined, nil
}

type fsEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
	IsDir   bool   `json:"isDir"`
}

func (h *handler) registerWorkspace(r chi.Router) {
	r.Get("/agents/{id}/fs", h.fsInfo)
	r.Get("/agents/{id}/fs/list", h.fsList)
	r.Get("/agents/{id}/fs/read", h.fsRead)
	r.Get("/agents/{id}/fs/download", h.fsDownload)
	r.Post("/agents/{id}/fs/write", h.fsWrite)
	r.Post("/agents/{id}/fs/upload", h.fsUpload)
	r.Post("/agents/{id}/fs/mkdir", h.fsMkdir)
	r.Post("/agents/{id}/fs/delete", h.fsDelete)
	r.Post("/agents/{id}/fs/rename", h.fsRename)
	r.Post("/agents/{id}/fs/archive", h.fsArchive)
	r.Post("/agents/{id}/fs/extract", h.fsExtract)
	r.Post("/agents/{id}/fs/share", h.createFileShare)
	r.Delete("/agents/{id}/fs/shares/{shareId}", h.revokeFileShare)
	r.Get("/agents/{id}/projects", h.listProjects)
	r.Post("/agents/{id}/projects", h.createProject)
	r.Patch("/agents/{id}/projects/{slug}", h.patchProject)
	r.Delete("/agents/{id}/projects/{slug}", h.deleteProject)
	r.Get("/agents/{id}/projects/{slug}/config", h.getProjectConfig)
	r.Put("/agents/{id}/projects/{slug}/instructions", h.putProjectInstructions)
	r.Put("/agents/{id}/projects/{slug}/hooks", h.putProjectHooks)
	r.Post("/agents/{id}/projects/{slug}/skills", h.putProjectSkill)
	r.Put("/agents/{id}/projects/{slug}/skills/{name}", h.putProjectSkill)
	r.Delete("/agents/{id}/projects/{slug}/skills/{name}", h.deleteProjectSkill)
	r.Get("/agents/{id}/projects/{slug}/skills/{name}/file", h.getProjectSkillFile)
	r.Get("/agents/{id}/desktop", h.agentDesktop)
	r.Post("/agents/{id}/desktop-ticket", h.desktopTicket)
	r.Post("/agents/{id}/terminal-ticket", h.terminalTicket)
	r.Get("/spaces/{id}/graph", h.spaceGraph)
	r.Get("/agents/{id}/migrations", h.listWorkspaceMigrations)
	r.Post("/agents/{id}/migrations", h.createWorkspaceMigration)
	r.Post("/instances/{id}/migrations", h.createInstanceMigration)
	r.Get("/migrations/{jobId}", h.getWorkspaceMigration)
	r.Get("/migrations/{jobId}/events", h.workspaceMigrationEvents)
	r.Get("/runtime-nodes", h.listRuntimeNodes)
	r.Get("/runtime-nodes/{id}", h.getRuntimeNode)
	r.Post("/runtime-nodes", h.createRuntimeNode)
	r.Patch("/runtime-nodes/{id}", h.patchRuntimeNode)
	r.Delete("/runtime-nodes/{id}", h.deleteRuntimeNode)
	r.Get("/runtime-nodes/mesh-status", h.runtimeMeshStatus)
	r.Get("/runtime-nodes/{id}/install", h.runtimeInstallInfo)
	r.Get("/runtime-nodes/{id}/detail", h.runtimeNodeDetail)
	r.Get("/runtime-nodes/{id}/version", h.runtimeNodeVersion)
	r.Get("/runtime-nodes/{id}/update-runner", h.runtimeUpdateInfo)
	r.Post("/runtime-nodes/{id}/update-runner", h.runtimeUpdateRunner)
	r.Post("/runtime-nodes/{id}/refresh-workspace-image", h.refreshWorkspaceImage)
	r.Get("/runtime-nodes/{id}/image-updates", h.runtimeImageUpdates)
	r.Get("/runtime-nodes/{id}/containers", h.runtimeNodeContainers)
	r.Post("/runtime-nodes/{id}/containers/allocate", h.runtimeNodeAllocate)
	r.Delete("/runtime-nodes/{nodeId}/agents/{agentId}/workspace-residual", h.deleteWorkspaceResidual)
	r.Get("/runtime/docker", h.runtimeDocker)
}
func (h *handler) fs(w http.ResponseWriter, r *http.Request) (workspaceFS, bool) {
	f, e := h.workspaceFor(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return workspaceFS{}, false
	}
	return f, true
}
func (h *handler) fsInfo(w http.ResponseWriter, r *http.Request) {
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		params, e := remotePathParams(remote.spaceID, r.URL.Query().Get("path"))
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		var result map[string]any
		if e = remote.runner.call(r.Context(), "host.fs.stat", params, &result); e != nil {
			writeRemoteError(w, e)
			return
		}
		httpx.JSON(w, http.StatusOK, result)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	reqPath := r.URL.Query().Get("path")
	p, e := f.resolve(reqPath, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	info, e := os.Stat(p)
	if e != nil {
		statusErr(w, e)
		return
	}
	display := "/" + strings.TrimPrefix(filepath.ToSlash(reqPath), "/")
	httpx.JSON(w, 200, fsEntry{Name: info.Name(), Path: display, Size: info.Size(), Mode: fmt.Sprintf("%04o", info.Mode().Perm()), ModTime: info.ModTime().UTC().Format(time.RFC3339Nano), IsDir: info.IsDir()})
}
func (h *handler) fsList(w http.ResponseWriter, r *http.Request) {
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		listedPath, entries, e := remote.list(r.Context(), r.URL.Query().Get("path"))
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"path": listedPath, "entries": entries})
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	reqPath := r.URL.Query().Get("path")
	p, e := f.resolve(reqPath, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	entries, e := os.ReadDir(p)
	if e != nil {
		statusErr(w, e)
		return
	}
	out := make([]fsEntry, 0, len(entries))
	for _, entry := range entries {
		info, e := entry.Info()
		if e != nil {
			continue
		}
		out = append(out, fsEntry{Name: entry.Name(), Path: filepath.ToSlash(filepath.Join(reqPath, entry.Name())), Size: info.Size(), Mode: fmt.Sprintf("%04o", info.Mode().Perm()), ModTime: info.ModTime().UTC().Format(time.RFC3339Nano), IsDir: entry.IsDir()})
	}
	httpx.JSON(w, 200, map[string]any{"entries": out, "path": reqPath})
}
func (h *handler) fsRead(w http.ResponseWriter, r *http.Request) {
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		raw, result, e := remote.read(r.Context(), r.URL.Query().Get("path"), 5<<20)
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		sum := sha256.Sum256(raw)
		result["revision"] = hex.EncodeToString(sum[:])
		httpx.JSON(w, http.StatusOK, result)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	p, e := f.resolve(r.URL.Query().Get("path"), true)
	if e != nil {
		statusErr(w, e)
		return
	}
	file, e := os.Open(p)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || info.IsDir() {
		httpx.Error(w, 400, "path is not a file")
		return
	}
	if info.Size() > 5<<20 {
		httpx.Error(w, 413, "file too large for text read")
		return
	}
	raw, e := io.ReadAll(file)
	if e != nil {
		statusErr(w, e)
		return
	}
	sum := sha256.Sum256(raw)
	httpx.JSON(w, 200, map[string]any{"path": r.URL.Query().Get("path"), "content": string(raw), "size": len(raw), "revision": hex.EncodeToString(sum[:])})
}
func (h *handler) fsDownload(w http.ResponseWriter, r *http.Request) {
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		target, e := runnerWorkspacePath(r.URL.Query().Get("path"))
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		raw, _, e := remote.read(r.Context(), target, 32<<20)
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
		w.Header().Set("Content-Disposition", `attachment; filename="`+url.PathEscape(filepath.Base(target))+`"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	p, e := f.resolve(r.URL.Query().Get("path"), true)
	if e != nil {
		statusErr(w, e)
		return
	}
	file, e := os.Open(p)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || info.IsDir() {
		httpx.Error(w, 400, "path is not a file")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(filepath.Base(p), `"`, "")+`"`)
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
func (h *handler) fsWrite(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Path, Content    string
		Append           bool
		Mode             *uint32
		ExpectedRevision string `json:"expectedRevision"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Path == "" {
		httpx.Error(w, 400, "path required")
		return
	}
	if len(b.Content) > maxWorkspaceUpload {
		httpx.Error(w, 413, "content too large")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		content := []byte(b.Content)
		if b.ExpectedRevision != "" || b.Append {
			existing, _, e := remote.read(r.Context(), b.Path, maxWorkspaceUpload)
			if e != nil {
				writeRemoteError(w, e)
				return
			}
			if b.ExpectedRevision != "" {
				sum := sha256.Sum256(existing)
				if hex.EncodeToString(sum[:]) != b.ExpectedRevision {
					httpx.Error(w, http.StatusConflict, "revision conflict")
					return
				}
			}
			if b.Append {
				content = append(existing, content...)
			}
		}
		result, e := remote.write(r.Context(), b.Path, content)
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		sum := sha256.Sum256(content)
		result["revision"] = hex.EncodeToString(sum[:])
		result["ok"] = true
		httpx.JSON(w, http.StatusOK, result)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	p, e := f.resolve(b.Path, false)
	if e != nil {
		statusErr(w, e)
		return
	}
	if e = os.MkdirAll(filepath.Dir(p), 0o750); e != nil {
		statusErr(w, e)
		return
	}
	mode := os.FileMode(0o640)
	if b.ExpectedRevision != "" {
		existing, e := os.ReadFile(p)
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			statusErr(w, e)
			return
		}
		sum := sha256.Sum256(existing)
		if hex.EncodeToString(sum[:]) != b.ExpectedRevision {
			httpx.Error(w, 409, "revision conflict")
			return
		}
	}
	if b.Mode != nil {
		mode = os.FileMode(*b.Mode) & 0o777
	}
	if b.Append {
		file, e := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, mode)
		if e == nil {
			_, e = file.WriteString(b.Content)
			_ = file.Close()
		}
		if e != nil {
			statusErr(w, e)
			return
		}
	} else {
		tmp, e := os.CreateTemp(filepath.Dir(p), ".zakura-write-*")
		if e != nil {
			statusErr(w, e)
			return
		}
		_ = tmp.Chmod(mode)
		_, e = tmp.WriteString(b.Content)
		closeErr := tmp.Close()
		if e == nil {
			e = closeErr
		}
		if e == nil {
			e = os.Rename(tmp.Name(), p)
		} else {
			_ = os.Remove(tmp.Name())
		}
		if e != nil {
			statusErr(w, e)
			return
		}
	}
	written, _ := os.ReadFile(p)
	sum := sha256.Sum256(written)
	httpx.JSON(w, 200, map[string]any{"ok": true, "path": b.Path, "revision": hex.EncodeToString(sum[:])})
}
func (h *handler) fsUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkspaceUpload)
	if e := r.ParseMultipartForm(maxWorkspaceUpload); e != nil {
		httpx.Error(w, 400, "invalid multipart upload")
		return
	}
	base := r.FormValue("path")
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		files = r.MultipartForm.File["file"]
	}
	if len(files) == 0 {
		httpx.Error(w, http.StatusBadRequest, "file is required")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		for _, head := range files {
			file, e := head.Open()
			if e != nil {
				writeRemoteError(w, e)
				return
			}
			raw, e := io.ReadAll(io.LimitReader(file, maxWorkspaceUpload+1))
			_ = file.Close()
			if e != nil || len(raw) > maxWorkspaceUpload {
				httpx.Error(w, http.StatusRequestEntityTooLarge, "file too large")
				return
			}
			target := base
			if len(files) > 1 || strings.HasSuffix(base, "/") || base == "" {
				target = filepath.ToSlash(filepath.Join(base, filepath.Base(head.Filename)))
			}
			if _, e = remote.write(r.Context(), target, raw); e != nil {
				writeRemoteError(w, e)
				return
			}
			if len(files) == 1 {
				httpx.JSON(w, http.StatusOK, map[string]any{"path": target, "size": len(raw)})
				return
			}
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"path": base, "files": func() []string {
			out := []string{}
			for _, f := range files {
				out = append(out, f.Filename)
			}
			return out
		}()})
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	if len(files) == 1 {
		head := files[0]
		if file, e := head.Open(); e == nil {
			defer file.Close()
			if e = h.saveUpload(f, base, head.Filename, file); e != nil {
				statusErr(w, e)
				return
			}
			target := base
			if strings.HasSuffix(base, "/") || base == "" {
				target = filepath.ToSlash(filepath.Join(base, head.Filename))
			}
			httpx.JSON(w, http.StatusOK, map[string]any{"path": target, "size": head.Size})
			return
		}
	}
	saved := []string{}
	for _, head := range files {
		file, e := head.Open()
		if e != nil {
			statusErr(w, e)
			return
		}
		e = h.saveUpload(f, base, head.Filename, file)
		file.Close()
		if e != nil {
			statusErr(w, e)
			return
		}
		saved = append(saved, head.Filename)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"path": base, "files": saved})
}
func (h *handler) saveUpload(f workspaceFS, base, name string, src multipart.File) error {
	name = filepath.Base(name)
	if name == "." || name == "" {
		return errors.New("invalid filename")
	}
	p, e := f.resolve(filepath.Join(base, name), false)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0o750); e != nil {
		return e
	}
	tmp, e := os.CreateTemp(filepath.Dir(p), ".zakura-upload-*")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if _, e = io.Copy(tmp, io.LimitReader(src, maxWorkspaceUpload+1)); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(tmp.Name(), p)
}
func (h *handler) fsMkdir(w http.ResponseWriter, r *http.Request) {
	var b struct{ Path string }
	if httpx.DecodeJSON(r, &b) != nil || b.Path == "" {
		httpx.Error(w, 400, "path required")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		params, e := remotePathParams(remote.spaceID, b.Path)
		if e == nil {
			var result map[string]any
			e = remote.runner.call(r.Context(), "host.fs.mkdir", params, &result)
			if e == nil {
				httpx.JSON(w, http.StatusOK, result)
				return
			}
		}
		writeRemoteError(w, e)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	p, e := f.resolve(b.Path, false)
	if e == nil {
		e = os.MkdirAll(p, 0o750)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "path": b.Path})
}
func (h *handler) fsDelete(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Path      string
		Recursive bool
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Path == "" {
		httpx.Error(w, 400, "path required")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		params, e := remotePathParams(remote.spaceID, b.Path)
		if e == nil {
			params["recursive"] = b.Recursive
			var result map[string]any
			e = remote.runner.call(r.Context(), "host.fs.remove", params, &result)
			if e == nil {
				httpx.JSON(w, http.StatusOK, result)
				return
			}
		}
		writeRemoteError(w, e)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	p, e := f.resolve(b.Path, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	if p == f.root {
		httpx.Error(w, 400, "cannot delete workspace root")
		return
	}
	if b.Recursive {
		e = os.RemoveAll(p)
	} else {
		e = os.Remove(p)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "path": b.Path})
}
func (h *handler) fsRename(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
		From    string `json:"from"`
		To      string `json:"to"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.From == "" {
		b.From = b.OldPath
	}
	if b.To == "" {
		b.To = b.NewPath
	}
	if b.From == "" || b.To == "" {
		httpx.Error(w, 400, "from and to required")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		from, e := runnerWorkspacePath(b.From)
		if e == nil {
			var to string
			to, e = runnerWorkspacePath(b.To)
			if e == nil {
				var result map[string]any
				e = remote.runner.call(r.Context(), "host.fs.rename", map[string]any{"spaceId": remote.spaceID, "oldPath": from, "newPath": to}, &result)
				if e == nil {
					httpx.JSON(w, http.StatusOK, result)
					return
				}
			}
		}
		writeRemoteError(w, e)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	from, e := f.resolve(b.From, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	to, e := f.resolve(b.To, false)
	if e == nil {
		e = os.MkdirAll(filepath.Dir(to), 0o750)
	}
	if e == nil {
		e = os.Rename(from, to)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "path": b.To})
}
func (h *handler) fsArchive(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Paths []string
	}
	if httpx.DecodeJSON(r, &b) != nil || len(b.Paths) == 0 {
		httpx.Error(w, 400, "paths required")
		return
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		raw, e := remote.archive(r.Context(), b.Paths)
		if e != nil {
			writeRemoteError(w, e)
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", `attachment; filename="workspace.tar.gz"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	raw, e := archiveLocalWorkspace(f, b.Paths)
	if e != nil {
		statusErr(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="workspace.tar.gz"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func archiveLocalWorkspace(f workspaceFS, paths []string) ([]byte, error) {
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	var total int64
	seen := map[string]bool{}
	for _, name := range paths {
		resolved, err := f.resolve(name, true)
		if err != nil {
			return nil, err
		}
		err = filepath.Walk(resolved, func(current string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, err := filepath.Rel(f.root, current)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if rel == "." || seen[rel] {
				return nil
			}
			seen[rel] = true
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("workspace symlinks are not archived")
			}
			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = rel
			if info.IsDir() {
				header.Name += "/"
				return tw.WriteHeader(header)
			}
			total += info.Size()
			if total > maxWorkspaceUpload {
				return errors.New("archive exceeds size limit")
			}
			if err = tw.WriteHeader(header); err != nil {
				return err
			}
			file, err := os.Open(current)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, io.LimitReader(file, info.Size()))
			_ = file.Close()
			return err
		})
		if err != nil {
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
func (h *handler) fsExtract(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Archive     string `json:"archive"`
		Path        string `json:"path"`
		Destination string `json:"destination"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.Archive == "" {
		b.Archive = b.Path
	}
	if remote, selected, ok := h.remoteFSRequest(w, r); !ok {
		return
	} else if selected {
		if e := remote.extract(r.Context(), b.Archive, b.Destination); e != nil {
			writeRemoteError(w, e)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "destination": b.Destination})
		return
	}
	if b.Archive == "" {
		httpx.Error(w, 400, "archive required")
		return
	}
	f, ok := h.fs(w, r)
	if !ok {
		return
	}
	src, e := f.resolve(b.Archive, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	dst, e := f.resolve(b.Destination, false)
	if e == nil {
		e = os.MkdirAll(dst, 0o750)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	if strings.HasSuffix(strings.ToLower(src), ".zip") {
		e = extractZip(src, dst)
	} else {
		e = extractTar(src, dst)
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "destination": b.Destination})
}
func safeExtractPath(root, name string) (string, error) {
	name = filepath.Clean(filepath.FromSlash(name))
	if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
		return "", errors.New("archive path traversal")
	}
	p := filepath.Join(root, name)
	rel, _ := filepath.Rel(root, p)
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("archive path traversal")
	}
	return p, nil
}
func extractZip(src, dst string) error {
	z, e := zip.OpenReader(src)
	if e != nil {
		return e
	}
	defer z.Close()
	var total int64
	for _, f := range z.File {
		total += int64(f.UncompressedSize64)
		if total > maxWorkspaceUpload {
			return errors.New("archive expands beyond limit")
		}
		p, e := safeExtractPath(dst, f.Name)
		if e != nil {
			return e
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			return errors.New("archive symlinks are not allowed")
		}
		if f.FileInfo().IsDir() {
			if e = os.MkdirAll(p, 0o750); e != nil {
				return e
			}
			continue
		}
		if e = os.MkdirAll(filepath.Dir(p), 0o750); e != nil {
			return e
		}
		in, e := f.Open()
		if e != nil {
			return e
		}
		out, e := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode()&0o777)
		if e == nil {
			_, e = io.Copy(out, io.LimitReader(in, maxWorkspaceUpload+1))
			_ = out.Close()
		}
		_ = in.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func extractTar(src, dst string) error {
	file, e := os.Open(src)
	if e != nil {
		return e
	}
	defer file.Close()
	var reader io.Reader = file
	if strings.HasSuffix(strings.ToLower(src), ".gz") || strings.HasSuffix(strings.ToLower(src), ".tgz") {
		gz, e := gzip.NewReader(file)
		if e != nil {
			return e
		}
		defer gz.Close()
		reader = gz
	}
	tr := tar.NewReader(reader)
	var total int64
	for {
		head, e := tr.Next()
		if errors.Is(e, io.EOF) {
			return nil
		}
		if e != nil {
			return e
		}
		if head.Typeflag != tar.TypeReg && head.Typeflag != tar.TypeDir {
			return errors.New("archive links and special files are not allowed")
		}
		total += head.Size
		if total > maxWorkspaceUpload {
			return errors.New("archive expands beyond limit")
		}
		p, e := safeExtractPath(dst, head.Name)
		if e != nil {
			return e
		}
		if head.Typeflag == tar.TypeDir {
			e = os.MkdirAll(p, 0o750)
		} else {
			if e = os.MkdirAll(filepath.Dir(p), 0o750); e == nil {
				var out *os.File
				out, e = os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(head.Mode)&0o777)
				if e == nil {
					_, e = io.Copy(out, io.LimitReader(tr, head.Size))
					_ = out.Close()
				}
			}
		}
		if e != nil {
			return e
		}
	}
}

func (h *handler) spaceForAgent(ctx context.Context, tenant, agent string) (string, error) {
	var id string
	e := h.deps.DB.QueryRowContext(ctx, h.store.q(`SELECT space_id FROM agents WHERE tenant_id=? AND id=?`), tenant, agent).Scan(&id)
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	return id, e
}
func (h *handler) listProjects(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, e := h.spaceForAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,slug,name,description,instructions,has_workspace,created_at,updated_at FROM space_projects WHERE tenant_id=? AND space_id=? ORDER BY name`), p.TenantID, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, slug, name, desc, instr string
		var has bool
		var c, u flexibleTime
		if rows.Scan(&id, &slug, &name, &desc, &instr, &has, &c, &u) == nil {
			var path any
			if has {
				path = "/workspace/projects/" + slug
			}
			out = append(out, map[string]any{"id": id, "slug": slug, "name": name, "description": desc, "instructions": instr, "hasWorkspace": has, "path": path, "createdAt": c.Time, "updatedAt": u.Time})
		}
	}
	httpx.JSON(w, 200, map[string]any{"projects": out})
}
func (h *handler) createProject(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Slug, Description, Instructions string
		HasWorkspace                          bool   `json:"hasWorkspace"`
		WithWorkspace                         bool   `json:"withWorkspace"`
		GitURL                                string `json:"gitUrl"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	if b.Slug == "" {
		b.Slug = slugify(b.Name)
	}
	if b.Slug == "" || b.Slug != strings.TrimSpace(b.Slug) || strings.ContainsAny(b.Slug, `/\\`) {
		httpx.Error(w, http.StatusBadRequest, "invalid project name")
		return
	}
	if b.WithWorkspace || b.GitURL != "" {
		b.HasWorkspace = true
	}
	if b.GitURL != "" && !(strings.HasPrefix(b.GitURL, "https://") || (strings.HasPrefix(b.GitURL, "git@") && strings.Contains(b.GitURL, ":"))) {
		httpx.Error(w, http.StatusBadRequest, "gitUrl must use https:// or git@host:path")
		return
	}
	p := principal(r)
	agent := chi.URLParam(r, "id")
	space, e := h.spaceForAgent(r.Context(), p.TenantID, agent)
	if e != nil {
		statusErr(w, e)
		return
	}
	now := h.store.now()
	id := h.store.id()
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO space_projects(id,tenant_id,space_id,slug,name,description,instructions,has_workspace,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`), id, p.TenantID, space, b.Slug, b.Name, b.Description, b.Instructions, b.HasWorkspace, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	cloneError := ""
	if b.HasWorkspace {
		if remote, selected, remoteErr := h.remoteWorkspace(r.Context(), p.TenantID, agent); remoteErr != nil {
			_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM space_projects WHERE id=?`), id)
			writeRemoteError(w, remoteErr)
			return
		} else if selected {
			params, _ := remotePathParams(remote.spaceID, projectRemotePath(b.Slug))
			if remoteErr = remote.runner.call(r.Context(), "host.fs.mkdir", params, nil); remoteErr != nil {
				_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM space_projects WHERE id=?`), id)
				writeRemoteError(w, remoteErr)
				return
			}
			if b.GitURL != "" {
				var execResult struct {
					ExitCode int    `json:"exitCode"`
					Stdout   string `json:"stdout"`
					Stderr   string `json:"stderr"`
				}
				remoteErr = remote.runner.call(r.Context(), "host.exec", map[string]any{"spaceId": remote.spaceID, "command": []string{"git", "clone", "--depth", "1", "--", b.GitURL, "/workspace/projects/" + b.Slug}, "workingDir": "/workspace"}, &execResult)
				if remoteErr != nil {
					cloneError = remoteErr.Error()
				} else if execResult.ExitCode != 0 {
					cloneError = strings.TrimSpace(execResult.Stderr + "\n" + execResult.Stdout)
					if len(cloneError) > 800 {
						cloneError = cloneError[:800]
					}
				}
			}
		} else if f, localErr := h.workspaceFor(r.Context(), p.TenantID, agent); localErr == nil {
			if localErr = os.MkdirAll(filepath.Join(f.root, "projects", b.Slug), 0o750); localErr != nil {
				_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM space_projects WHERE id=?`), id)
				statusErr(w, localErr)
				return
			}
		}
	}
	projectPath := any(nil)
	if b.HasWorkspace {
		projectPath = "/workspace/projects/" + b.Slug
	}
	response := map[string]any{"project": map[string]any{"id": id, "slug": b.Slug, "name": b.Name, "description": b.Description, "instructions": b.Instructions, "hasWorkspace": b.HasWorkspace, "path": projectPath}}
	if cloneError != "" {
		response["cloneError"] = cloneError
	}
	httpx.JSON(w, http.StatusOK, response)
}
func (h *handler) patchProject(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	space, e := h.spaceForAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	oldSlug := chi.URLParam(r, "slug")
	var existingHas bool
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT has_workspace FROM space_projects WHERE tenant_id=? AND space_id=? AND slug=?`), p.TenantID, space, oldSlug).Scan(&existingHas); errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "description": "description", "instructions": "instructions", "hasWorkspace": "has_workspace"} {
		if v, ok := m[k]; ok {
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if v, ok := m["withWorkspace"]; ok {
		sets = append(sets, "has_workspace=?")
		args = append(args, v)
	}
	if v, ok := m["slug"].(string); ok && slugify(v) != "" {
		sets = append(sets, "slug=?")
		args = append(args, slugify(v))
	}
	if len(sets) == 0 {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{"error": "no supported fields"})
		return
	}
	nextSlug := oldSlug
	if v, ok := m["slug"].(string); ok && slugify(v) != "" {
		nextSlug = slugify(v)
	}
	wantWorkspace := existingHas
	if v, ok := m["withWorkspace"].(bool); ok && v {
		wantWorkspace = true
	}
	if v, ok := m["hasWorkspace"].(bool); ok {
		wantWorkspace = v
	}
	if remote, selected, fsErr := h.remoteWorkspace(r.Context(), p.TenantID, chi.URLParam(r, "id")); fsErr != nil {
		writeRemoteError(w, fsErr)
		return
	} else if selected {
		if existingHas && nextSlug != oldSlug {
			from, to := projectRemotePath(oldSlug), projectRemotePath(nextSlug)
			fsErr = remote.runner.call(r.Context(), "host.fs.rename", map[string]any{"spaceId": remote.spaceID, "oldPath": from, "newPath": to}, nil)
		} else if wantWorkspace && !existingHas {
			params, _ := remotePathParams(remote.spaceID, projectRemotePath(nextSlug))
			fsErr = remote.runner.call(r.Context(), "host.fs.mkdir", params, nil)
		}
		if fsErr != nil {
			writeRemoteError(w, fsErr)
			return
		}
	} else if existingHas && nextSlug != oldSlug {
		if f, fsErr := h.workspaceFor(r.Context(), p.TenantID, chi.URLParam(r, "id")); fsErr == nil {
			if fsErr = os.Rename(filepath.Join(f.root, "projects", oldSlug), filepath.Join(f.root, "projects", nextSlug)); fsErr != nil {
				statusErr(w, fsErr)
				return
			}
		}
	} else if wantWorkspace && !existingHas {
		if f, fsErr := h.workspaceFor(r.Context(), p.TenantID, chi.URLParam(r, "id")); fsErr == nil {
			if fsErr = os.MkdirAll(filepath.Join(f.root, "projects", nextSlug), 0o750); fsErr != nil {
				statusErr(w, fsErr)
				return
			}
		}
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.store.now(), p.TenantID, space, chi.URLParam(r, "slug"))
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE space_projects SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND space_id=? AND slug=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	lookupSlug := chi.URLParam(r, "slug")
	if v, ok := m["slug"].(string); ok && slugify(v) != "" {
		lookupSlug = slugify(v)
	}
	var id, name, description, instructions string
	var has bool
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,description,instructions,has_workspace FROM space_projects WHERE tenant_id=? AND space_id=? AND slug=?`), p.TenantID, space, lookupSlug).Scan(&id, &name, &description, &instructions, &has); e != nil {
		statusErr(w, e)
		return
	}
	var projectPath any
	if has {
		projectPath = "/workspace/projects/" + lookupSlug
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"project": map[string]any{"id": id, "slug": lookupSlug, "name": name, "description": description, "instructions": instructions, "hasWorkspace": has, "path": projectPath}})
}
func (h *handler) deleteProject(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, e := h.spaceForAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	slug := chi.URLParam(r, "slug")
	var hasWorkspace bool
	if e = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT has_workspace FROM space_projects WHERE tenant_id=? AND space_id=? AND slug=?`), p.TenantID, space, slug).Scan(&hasWorkspace); errors.Is(e, sql.ErrNoRows) {
		statusErr(w, ErrNotFound)
		return
	} else if e != nil {
		statusErr(w, e)
		return
	}
	if hasWorkspace {
		if remote, selected, fsErr := h.remoteWorkspace(r.Context(), p.TenantID, chi.URLParam(r, "id")); fsErr != nil {
			writeRemoteError(w, fsErr)
			return
		} else if selected {
			params, _ := remotePathParams(remote.spaceID, projectRemotePath(slug))
			params["recursive"] = true
			if fsErr = remote.runner.call(r.Context(), "host.fs.remove", params, nil); fsErr != nil {
				writeRemoteError(w, fsErr)
				return
			}
		} else if f, fsErr := h.workspaceFor(r.Context(), p.TenantID, chi.URLParam(r, "id")); fsErr == nil {
			if fsErr = os.RemoveAll(filepath.Join(f.root, "projects", slug)); fsErr != nil {
				statusErr(w, fsErr)
				return
			}
		}
	}
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM space_projects WHERE tenant_id=? AND space_id=? AND slug=?`), p.TenantID, space, chi.URLParam(r, "slug"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": true})
}
func (h *handler) getProjectConfig(w http.ResponseWriter, r *http.Request) {
	if remote, selected, e := h.remoteProject(r); e != nil {
		writeRemoteError(w, e)
		return
	} else if selected {
		httpx.JSON(w, http.StatusOK, map[string]any{"config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug"))})
		return
	}
	_, dir, e := h.projectDir(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir)})
}
func (h *handler) putProjectInstructions(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Content string `json:"content"`
		File    string `json:"file"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	if b.File != "CLAUDE.md" {
		b.File = "AGENTS.md"
	}
	if remote, selected, e := h.remoteProject(r); e != nil {
		writeRemoteError(w, e)
		return
	} else if selected {
		if _, e = remote.write(r.Context(), projectRemotePath(chi.URLParam(r, "slug"), b.File), []byte(b.Content)); e != nil {
			writeRemoteError(w, e)
			return
		}
		_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE space_projects SET instructions=?,updated_at=? WHERE tenant_id=? AND slug=? AND space_id=(SELECT space_id FROM agents WHERE tenant_id=? AND id=?)`), b.Content, h.store.now(), principal(r).TenantID, chi.URLParam(r, "slug"), principal(r).TenantID, chi.URLParam(r, "id"))
		httpx.JSON(w, http.StatusOK, map[string]any{"config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug")), "path": "/workspace/projects/" + chi.URLParam(r, "slug") + "/" + b.File})
		return
	}
	_, dir, e := h.projectDir(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	if e = atomicWrite(filepath.Join(dir, b.File), []byte(b.Content), 0o640); e != nil {
		statusErr(w, e)
		return
	}
	_, _ = h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE space_projects SET instructions=?,updated_at=? WHERE tenant_id=? AND slug=? AND space_id=(SELECT space_id FROM agents WHERE tenant_id=? AND id=?)`), b.Content, h.store.now(), principal(r).TenantID, chi.URLParam(r, "slug"), principal(r).TenantID, chi.URLParam(r, "id"))
	httpx.JSON(w, http.StatusOK, map[string]any{"config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir), "path": "/workspace/projects/" + chi.URLParam(r, "slug") + "/" + b.File})
}

func (h *handler) listRuntimeNodes(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, e := h.deps.DB.QueryContext(r.Context(), h.store.q(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE tenant_id=? OR is_shared=true ORDER BY is_shared,name`), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		x, e := scanRuntimeNode(rows)
		if e == nil {
			if shared, _ := x["isShared"].(bool); shared {
				x["access"] = "shared"
			} else {
				x["access"] = "owned"
			}
			out = append(out, x)
		}
	}
	canLocal := p.IsPlatformAdmin || !h.deps.MultiTenant
	if !canLocal && !p.APIKey {
		_ = h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT can_use_local_runner FROM users WHERE id=?`), p.UserID).Scan(&canLocal)
	}
	httpx.JSON(w, 200, map[string]any{"nodes": out, "canUseLocalRunner": canLocal})
}
func scanRuntimeNode(row interface{ Scan(...any) error }) (map[string]any, error) {
	var id, name, slug, kind, status, storage, caps, host, labels string
	var endpoint, version *string
	var seen sql.NullString
	var shared bool
	var c, u flexibleTime
	e := row.Scan(&id, &name, &slug, &kind, &status, &endpoint, &caps, &host, &storage, &version, &seen, &labels, &shared, &c, &u)
	return map[string]any{"id": id, "name": name, "slug": slug, "kind": kind, "status": status, "endpoint": endpoint, "capabilities": json.RawMessage(caps), "hostInfo": json.RawMessage(host), "storageRoot": storage, "agentVersion": version, "lastSeenAt": seen.String, "labels": json.RawMessage(labels), "isShared": shared, "createdAt": c.Time, "updatedAt": u.Time}, e
}
func (h *handler) getRuntimeNode(w http.ResponseWriter, r *http.Request) {
	x, e := scanRuntimeNode(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE (tenant_id=? OR is_shared=true) AND id=?`), principal(r).TenantID, chi.URLParam(r, "id")))
	if errors.Is(e, sql.ErrNoRows) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"node": x})
}
func (h *handler) createRuntimeNode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Slug, Kind, Endpoint, StorageRoot string
		Capabilities, Labels                    json.RawMessage
		IsShared                                bool `json:"isShared"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Name == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	if b.Slug == "" {
		b.Slug = slugify(b.Name)
	}
	if b.Kind == "" {
		b.Kind = "computer"
	}
	if b.StorageRoot == "" {
		b.StorageRoot = "/var/lib/zakura"
	}
	p := principal(r)
	if b.IsShared && !p.IsPlatformAdmin {
		httpx.Error(w, 403, "platform admin required for shared nodes")
		return
	}
	now := h.store.now()
	id := h.store.id()
	token, hash, e := newRunnerToken()
	if e != nil {
		statusErr(w, e)
		return
	}
	var createdBy any = p.UserID
	if p.APIKey {
		createdBy = nil
	}
	_, e = h.deps.DB.ExecContext(r.Context(), h.store.q(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,token_hash,labels_json,is_shared,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'offline',?,?,'{}',?,NULL,NULL,?,?,?, ?, ?,?)`), id, p.TenantID, b.Name, b.Slug, b.Kind, nullString(b.Endpoint), validJSON(b.Capabilities, "{}"), b.StorageRoot, hash, validJSON(b.Labels, "{}"), b.IsShared, createdBy, now, now)
	if e != nil {
		statusErr(w, e)
		return
	}
	runnerTokenCache.Store(id, token)
	node, e := scanRuntimeNode(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE id=?`), id))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"node": node, "token": token, "install": h.runnerInstallPackage(node, token), "installTailscale": nil, "hostJoinsTailscale": false})
}
func (h *handler) patchRuntimeNode(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	sets := []string{}
	args := []any{}
	for k, col := range map[string]string{"name": "name", "endpoint": "endpoint", "labels": "labels_json"} {
		if v, ok := m[k]; ok {
			if k == "labels" {
				b, _ := json.Marshal(v)
				v = string(b)
			}
			sets = append(sets, col+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		h.getRuntimeNode(w, r)
		return
	}
	sets = append(sets, "updated_at=?")
	args = append(args, h.store.now(), principal(r).TenantID, chi.URLParam(r, "id"))
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE runtime_nodes SET `+strings.Join(sets, ",")+` WHERE tenant_id=? AND id=?`), args...)
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getRuntimeNode(w, r)
}
func (h *handler) deleteRuntimeNode(w http.ResponseWriter, r *http.Request) {
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`DELETE FROM runtime_nodes WHERE tenant_id=? AND id=? AND is_shared=false`), principal(r).TenantID, chi.URLParam(r, "id"))
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
func (h *handler) runtimeHeartbeat(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeRunnerNode(r, chi.URLParam(r, "id"), false) {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	var b struct {
		AgentVersion           string `json:"agentVersion"`
		Capabilities, HostInfo json.RawMessage
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	now := h.store.now()
	res, e := h.deps.DB.ExecContext(r.Context(), h.store.q(`UPDATE runtime_nodes SET status='online',agent_version=?,capabilities_json=?,host_info_json=?,last_seen_at=?,updated_at=? WHERE id=?`), b.AgentVersion, validJSON(b.Capabilities, "{}"), validJSON(b.HostInfo, "{}"), now, now, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	node, e := scanRuntimeNode(h.deps.DB.QueryRowContext(r.Context(), h.store.q(`SELECT id,name,slug,kind,status,endpoint,capabilities_json,host_info_json,storage_root,agent_version,last_seen_at,labels_json,is_shared,created_at,updated_at FROM runtime_nodes WHERE id=?`), chi.URLParam(r, "id")))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"node": node})
}

var _ = fmt.Sprintf
var _ = strconv.Itoa
