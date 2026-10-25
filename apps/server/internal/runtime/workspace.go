// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
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

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

const maxWorkspaceUpload = 100 << 20

type workspaceFS struct{ root string }

func (h *handler) workspaceFor(ctx context.Context, tenant, agent string) (workspaceFS, error) {
	var m models.Agent
	e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, agent).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return workspaceFS{}, ErrNotFound
	}
	if e != nil {
		return workspaceFS{}, e
	}
	space := m.SpaceID
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
	h.registerSpaceWorkspace(r)
	r.Get("/agents/{id}/fs", h.fsInfo)
	r.Get("/agents/{id}/fs/list", h.fsList)
	r.Get("/agents/{id}/fs/read", h.fsRead)
	r.Get("/agents/{id}/fs/download", h.fsDownload)
	r.Post("/agents/{id}/fs/write", h.legacyWorkspaceRoute(h.fsWrite))
	r.Post("/agents/{id}/fs/upload", h.legacyWorkspaceRoute(h.fsUpload))
	r.Post("/agents/{id}/fs/mkdir", h.legacyWorkspaceRoute(h.fsMkdir))
	r.Post("/agents/{id}/fs/delete", h.legacyWorkspaceRoute(h.fsDelete))
	r.Post("/agents/{id}/fs/rename", h.legacyWorkspaceRoute(h.fsRename))
	r.Post("/agents/{id}/fs/archive", h.legacyWorkspaceRoute(h.fsArchive))
	r.Post("/agents/{id}/fs/extract", h.legacyWorkspaceRoute(h.fsExtract))
	r.Post("/agents/{id}/fs/share", h.createFileShare)
	r.Delete("/agents/{id}/fs/shares/{shareId}", h.legacyWorkspaceRoute(h.revokeFileShare))
	r.Get("/agents/{id}/projects", h.listProjects)
	r.Post("/agents/{id}/projects", h.legacyWorkspaceRoute(h.createProject))
	r.Patch("/agents/{id}/projects/{slug}", h.legacyWorkspaceRoute(h.patchProject))
	r.Delete("/agents/{id}/projects/{slug}", h.legacyWorkspaceRoute(h.deleteProject))
	r.Get("/agents/{id}/projects/{slug}/config", h.getProjectConfig)
	r.Put("/agents/{id}/projects/{slug}/instructions", h.legacyWorkspaceRoute(h.putProjectInstructions))
	r.Put("/agents/{id}/projects/{slug}/hooks", h.legacyWorkspaceRoute(h.putProjectHooks))
	r.Post("/agents/{id}/projects/{slug}/skills", h.legacyWorkspaceRoute(h.putProjectSkill))
	r.Put("/agents/{id}/projects/{slug}/skills/{name}", h.legacyWorkspaceRoute(h.putProjectSkill))
	r.Delete("/agents/{id}/projects/{slug}/skills/{name}", h.legacyWorkspaceRoute(h.deleteProjectSkill))
	r.Get("/agents/{id}/projects/{slug}/skills/{name}/file", h.getProjectSkillFile)
	r.Get("/agents/{id}/desktop", h.agentDesktop)
	r.Post("/agents/{id}/desktop-ticket", h.desktopTicket)
	r.Post("/agents/{id}/terminal-ticket", h.terminalTicket)
	r.Get("/spaces/{id}/graph", h.spaceGraph)
	r.Get("/agents/{id}/migrations", h.listWorkspaceMigrations)
	r.Get("/spaces/{id}/migrations", h.spaceWorkspaceRoute(h.listWorkspaceMigrations))
	r.Post("/spaces/{id}/migrations", h.spaceWorkspaceScope(h.createWorkspaceMigration))
	r.Get("/spaces/{id}/migrations/{jobId}", h.spaceWorkspaceRoute(h.getWorkspaceMigration))
	r.Get("/spaces/{id}/migrations/{jobId}/events", h.spaceWorkspaceRoute(h.workspaceMigrationEvents))
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
	f, e := h.requestWorkspace(r)
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
		if e = remote.call(r.Context(), "host.fs.stat", params, &result); e != nil {
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
	info, e := f.statLocal(reqPath)
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
	dir, e := f.openLocal(reqPath)
	if e != nil {
		statusErr(w, e)
		return
	}
	defer dir.Close()
	entries, e := dir.ReadDir(-1)
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
	file, e := f.openLocal(r.URL.Query().Get("path"))
	if e != nil {
		statusErr(w, e)
		return
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || !info.Mode().IsRegular() {
		httpx.Error(w, 400, "path is not a file")
		return
	}
	if info.Size() > 5<<20 {
		httpx.Error(w, 413, "file too large for text read")
		return
	}
	raw, e := io.ReadAll(io.LimitReader(file, (5<<20)+1))
	if e != nil {
		statusErr(w, e)
		return
	}
	if len(raw) > 5<<20 {
		httpx.Error(w, 413, "file too large for text read")
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
	file, e := f.openLocal(r.URL.Query().Get("path"))
	if e != nil {
		statusErr(w, e)
		return
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil || !info.Mode().IsRegular() {
		httpx.Error(w, 400, "path is not a file")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(filepath.Base(r.URL.Query().Get("path")), `"`, "")+`"`)
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
	mode := os.FileMode(0640)
	if b.Mode != nil {
		mode = os.FileMode(*b.Mode) & 0777
	}
	written, e := f.writeLocal(b.Path, []byte(b.Content), b.Append, b.ExpectedRevision, mode)
	if errors.Is(e, ErrConflict) {
		httpx.Error(w, 409, "revision conflict")
		return
	}
	if e != nil {
		statusErr(w, e)
		return
	}
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
				target = filepath.ToSlash(filepath.Join(base, filepath.Base(head.Filename)))
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
		e = h.saveUpload(f, strings.TrimSuffix(base, "/")+"/", head.Filename, file)
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
	target := base
	if strings.HasSuffix(base, "/") || base == "" {
		target = filepath.ToSlash(filepath.Join(base, name))
	}
	return f.uploadLocal(target, src)
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
			e = remote.call(r.Context(), "host.fs.mkdir", params, &result)
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
	e := f.mkdirLocal(b.Path)
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
			e = remote.call(r.Context(), "host.fs.remove", params, &result)
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
	e := f.removeLocal(b.Path, b.Recursive)
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
				e = remote.call(r.Context(), "host.fs.rename", map[string]any{"spaceId": remote.spaceID, "oldPath": from, "newPath": to}, &result)
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
	e := f.renameLocal(b.From, b.To)
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
	return archiveRootedWorkspace(f, paths)
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
	e := extractRootedWorkspace(f, b.Archive, b.Destination)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "destination": b.Destination})
}

func (h *handler) spaceForAgent(ctx context.Context, tenant, agent string) (string, error) {
	var m models.Agent
	e := h.deps.Gorm.WithContext(ctx).Where("tenant_id = ? AND id = ?", tenant, agent).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	return m.SpaceID, e
}
func (h *handler) listProjects(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	space, e := h.workspaceRequestSpace(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	var ms []models.SpaceProject
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? AND space_id = ?", p.TenantID, space).Order("name").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	presence, e := h.projectDiskPresence(r.Context(), p.TenantID, space, ms)
	if e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		m.HasWorkspace = presence[m.Slug]
		item := projectDTO(m)
		item["createdAt"], item["updatedAt"] = parseTime(m.CreatedAt), parseTime(m.UpdatedAt)
		out = append(out, item)
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
	if b.Slug == "" || b.Slug != slugify(b.Slug) {
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
	space, e := h.workspaceRequestSpace(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	// A pending rename owns both source and destination until reconciliation.
	currentSpace, e := h.store.GetSpace(r.Context(), p.TenantID, space)
	if e != nil {
		statusErr(w, e)
		return
	}
	accepted, ok := r.Context().Value(workspaceRequestTargetKey{}).(Space)
	if !ok {
		accepted = currentSpace
	}
	for _, value := range nestedMap(configMap(currentSpace.Config), projectIntentsKey) {
		op, err := decodeProjectIntent(value)
		if err != nil {
			statusErr(w, err)
			return
		}
		if projectIntentMatches(op, accepted.CurrentWorkspaceInstanceID, accepted.WorkspaceGeneration) && (op.Slug == b.Slug || op.Next == b.Slug) {
			statusErr(w, ErrConflict)
			return
		}
	}
	nowStr := runtimeTimeString(h.store.now())
	id := h.store.id()
	sp := models.SpaceProject{ID: &id, TenantID: p.TenantID, SpaceID: space, Slug: b.Slug, Name: b.Name, Description: b.Description, Instructions: b.Instructions, HasWorkspace: b.HasWorkspace, CreatedAt: nowStr, UpdatedAt: nowStr}
	if e = h.deps.Gorm.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if err := lockWorkspaceInstance(tx, p.TenantID, space, accepted.CurrentWorkspaceInstanceID, accepted.WorkspaceGeneration); err != nil {
			return err
		}
		return tx.Create(&sp).Error
	}); e != nil {
		statusErr(w, e)
		return
	}
	if b.HasWorkspace {
		e = h.createProjectWorkspace(r, space, b.Slug, b.GitURL)
		if e != nil {
			_ = h.deps.Gorm.WithContext(context.WithoutCancel(r.Context())).Where("tenant_id=? AND id=?", p.TenantID, id).Delete(&models.SpaceProject{}).Error
			httpx.Error(w, http.StatusBadGateway, e.Error())
			return
		}
	}
	presence, e := h.projectDiskPresence(r.Context(), p.TenantID, space, []models.SpaceProject{sp})
	if e != nil {
		statusErr(w, e)
		return
	}
	sp.HasWorkspace = presence[sp.Slug]
	httpx.JSON(w, http.StatusOK, map[string]any{"project": projectDTO(sp)})
}
func (h *handler) patchProject(w http.ResponseWriter, r *http.Request) {
	h.mutateProject(w, r, false)
}
func (h *handler) deleteProject(w http.ResponseWriter, r *http.Request) {
	h.mutateProject(w, r, true)
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
		// Directory instruction files are independent of the project's conversation
		// instructions column; never silently overwrite that separate setting.
		httpx.JSON(w, http.StatusOK, map[string]any{"config": remote.projectSnapshot(r.Context(), chi.URLParam(r, "slug")), "path": "/workspace/projects/" + chi.URLParam(r, "slug") + "/" + b.File})
		return
	}
	_, dir, e := h.projectDir(r)
	if e != nil {
		statusErr(w, e)
		return
	}
	if e = writeProjectFile(dir, b.File, []byte(b.Content)); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": projectConfigSnapshot(chi.URLParam(r, "slug"), dir), "path": "/workspace/projects/" + chi.URLParam(r, "slug") + "/" + b.File})
}

func (h *handler) listRuntimeNodes(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var ms []models.RuntimeNode
	if e := h.deps.Gorm.WithContext(r.Context()).Where("tenant_id = ? OR is_shared = true", p.TenantID).Order("is_shared, name").Find(&ms).Error; e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		x := runtimeNodeFromModel(m)
		h.projectRuntimeNode(x)
		if m.IsShared {
			x["access"] = "shared"
		} else {
			x["access"] = "owned"
		}
		out = append(out, x)
	}
	canLocal := p.IsPlatformAdmin || !h.deps.MultiTenant
	if !canLocal && !p.APIKey {
		var u models.User
		_ = h.deps.Gorm.WithContext(r.Context()).Where("id = ?", p.UserID).Take(&u).Error
		canLocal = u.CanUseLocalRunner
	}
	httpx.JSON(w, 200, map[string]any{"nodes": out, "canUseLocalRunner": canLocal})
}
func runtimeNodeFromModel(m models.RuntimeNode) map[string]any {
	id := ""
	if m.ID != nil {
		id = *m.ID
	}
	lastSeen := ""
	if m.LastSeenAt != nil {
		lastSeen = *m.LastSeenAt
	}
	return map[string]any{"id": id, "name": m.Name, "slug": m.Slug, "kind": m.Kind, "status": m.Status, "endpoint": m.Endpoint, "capabilities": json.RawMessage(m.CapabilitiesJSON), "hostInfo": json.RawMessage(m.HostInfoJSON), "storageRoot": m.StorageRoot, "agentVersion": m.AgentVersion, "lastSeenAt": lastSeen, "labels": json.RawMessage(m.LabelsJSON), "isShared": m.IsShared, "createdAt": parseTime(m.CreatedAt), "updatedAt": parseTime(m.UpdatedAt)}
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
	var m models.RuntimeNode
	e := h.deps.Gorm.WithContext(r.Context()).Where("(tenant_id = ? OR is_shared = true) AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Take(&m).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		e = ErrNotFound
	}
	if e != nil {
		statusErr(w, e)
		return
	}
	node := runtimeNodeFromModel(m)
	h.projectRuntimeNode(node)
	httpx.JSON(w, 200, map[string]any{"node": node})
}
func (h *handler) createRuntimeNode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Slug, Kind, Endpoint, StorageRoot string
		Capabilities, Labels                    json.RawMessage
		IsShared                                bool `json:"isShared"`
		EnableTailscale                         bool `json:"enableTailscale"`
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
	if b.Kind != "computer" && b.Kind != "server" || b.StorageRoot != "" {
		httpx.Error(w, http.StatusBadRequest, "runtime nodes must use the managed Agent installation")
		return
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
	var createdBy *string
	if !p.APIKey {
		createdBy = &p.UserID
	}
	nowStr := runtimeTimeString(now)
	rn := models.RuntimeNode{ID: &id, TenantID: p.TenantID, Name: b.Name, Slug: b.Slug, Kind: b.Kind, Status: "offline", CapabilitiesJSON: validJSON(b.Capabilities, "{}"), HostInfoJSON: "{}", StorageRoot: b.StorageRoot, TokenHash: &hash, LabelsJSON: validJSON(b.Labels, "{}"), IsShared: b.IsShared, CreatedByUserID: createdBy, CreatedAt: nowStr, UpdatedAt: nowStr}
	if b.Endpoint != "" {
		rn.Endpoint = &b.Endpoint
	}
	if e = h.deps.Gorm.WithContext(r.Context()).Create(&rn).Error; e != nil {
		statusErr(w, e)
		return
	}
	runnerTokenCache.Store(id, token)
	var loaded models.RuntimeNode
	if e = h.deps.Gorm.WithContext(r.Context()).Where("id = ?", id).Take(&loaded).Error; e != nil {
		statusErr(w, e)
		return
	}
	node := runtimeNodeFromModel(loaded)
	loginServer, tsAvailable := h.runnerTailscaleMeta(r.Context(), p.TenantID)
	install := h.runnerInstallPackage(node, token, "")
	var installTailscale any
	if tsAvailable {
		installTailscale = h.runnerInstallPackage(node, token, loginServer)
	}
	var meshProvider any
	if tsAvailable {
		meshProvider = "headscale-platform"
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"node": node, "token": token, "install": install, "installTailscale": installTailscale, "hostJoinsTailscale": tsAvailable, "meshProvider": meshProvider})
}
func (h *handler) patchRuntimeNode(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	updates := map[string]any{}
	for k, col := range map[string]string{"name": "name", "endpoint": "endpoint", "labels": "labels_json"} {
		if v, ok := m[k]; ok {
			if k == "labels" {
				b, _ := json.Marshal(v)
				v = string(b)
			}
			updates[col] = v
		}
	}
	if len(updates) == 0 {
		h.getRuntimeNode(w, r)
		return
	}
	updates["updated_at"] = runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("tenant_id = ? AND id = ?", principal(r).TenantID, chi.URLParam(r, "id")).Updates(updates)
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	h.getRuntimeNode(w, r)
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
	now := runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("id = ?", chi.URLParam(r, "id")).Updates(map[string]any{"agent_version": b.AgentVersion, "capabilities_json": validJSON(b.Capabilities, "{}"), "host_info_json": validJSON(b.HostInfo, "{}"), "last_seen_at": now, "updated_at": now})
	if res.Error != nil {
		statusErr(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		statusErr(w, ErrNotFound)
		return
	}
	var node models.RuntimeNode
	if e := h.deps.Gorm.WithContext(r.Context()).Where("id = ?", chi.URLParam(r, "id")).Take(&node).Error; e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"node": runtimeNodeFromModel(node)})
}

var _ = fmt.Sprintf
var _ = strconv.Itoa
