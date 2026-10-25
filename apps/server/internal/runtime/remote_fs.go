// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type remoteWorkspace struct {
	runner  *runnerSession
	spaceID string
	// root, when set, scopes host.fs.* RPCs to a computer's own workspace
	// directory instead of the legacy Space workspace.
	root          string
	privateWrites bool
	workspace     *protocol.Binding
	validate      func(context.Context) error
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
	if exec := pinnedExecution(ctx); exec != nil {
		if err := h.authorizeContextLocalNode(ctx, tenant, exec.nodeID); err != nil {
			return nil, true, err
		}
	}
	if exec := pinnedExecution(ctx); exec != nil && !exec.legacy {
		if !exec.computer.Has(computers.Files) || strings.TrimSpace(exec.hostRoot) == "" {
			return nil, true, errors.New("files are not available on this computer")
		}
		runner, err := h.hub.get(exec.nodeID)
		if err != nil {
			return nil, true, err
		}
		return &remoteWorkspace{runner: runner, spaceID: exec.spaceID, root: exec.hostRoot}, true, nil
	}
	if exec := pinnedExecution(ctx); exec != nil && exec.workspace != nil {
		remote, err := h.remotePinnedWorkspace(ctx, exec)
		return remote, true, err
	}
	if exec := pinnedExecution(ctx); exec != nil && exec.legacy {
		if strings.TrimSpace(exec.nodeID) == "" {
			return nil, true, errors.New("pinned Space server has no runtime node")
		}
		if h.hub == nil {
			return nil, true, errors.New("runtime node is offline")
		}
		runner, err := h.hub.get(exec.nodeID)
		if err != nil {
			return nil, true, err
		}
		return &remoteWorkspace{runner: runner, spaceID: exec.spaceID, root: exec.hostRoot}, true, nil
	}
	var spaceID, nodeID string
	var rec struct {
		SpaceID string `gorm:"column:space_id"`
		NodeID  string `gorm:"column:node_id"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("agents AS a").Select("a.space_id AS space_id, COALESCE(s.runtime_node_id,'') AS node_id").Joins("JOIN spaces s ON s.id=a.space_id AND s.tenant_id=a.tenant_id").Where("a.tenant_id=? AND a.id=?", tenant, agent).Take(&rec).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	spaceID, nodeID = rec.SpaceID, rec.NodeID
	exec, err := h.resolveServerComputer(ctx, tenant, spaceID)
	if err != nil {
		return nil, true, err
	}
	if exec.workspace != nil {
		remote, err := h.remotePinnedWorkspace(ctx, exec)
		return remote, true, err
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, nodeID); err != nil {
		return nil, true, err
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
	remote, selected, err := h.requestRemoteWorkspace(r)
	if err != nil {
		writeRemoteError(w, err)
		return nil, selected, false
	}
	return remote, selected, true
}

func (h *handler) remoteProject(r *http.Request) (*remoteWorkspace, bool, error) {
	remote, selected, err := h.requestRemoteWorkspace(r)
	if err != nil || !selected {
		return remote, selected, err
	}
	space, err := h.workspaceRequestSpace(r)
	if err != nil {
		return nil, selected, err
	}
	var count int64
	err = h.deps.Gorm.WithContext(r.Context()).Table("space_projects").Where("tenant_id=? AND space_id=? AND slug=?", principal(r).TenantID, space, chi.URLParam(r, "slug")).Count(&count).Error
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
	return projectSnapshotFromReader(slug, r.projectReader(ctx, slug))
}

func remotePathParams(spaceID, raw string) (map[string]any, error) {
	safe, err := runnerWorkspacePath(raw)
	if err != nil {
		return nil, err
	}
	return map[string]any{"spaceId": spaceID, "path": safe}, nil
}

// pathParams adds the computer workspace root when this workspace is scoped to
// a pinned computer rather than the legacy Space directory.
func (r *remoteWorkspace) pathParams(raw string) (map[string]any, error) {
	params, err := remotePathParams(r.spaceID, raw)
	if err != nil {
		return nil, err
	}
	if r.workspace != nil {
		params["workspace"] = *r.workspace
	} else if r.root != "" {
		params["root"] = r.root
	}
	return params, nil
}

func (r *remoteWorkspace) call(ctx context.Context, method string, params map[string]any, out any) error {
	if r.validate != nil {
		if err := r.validate(ctx); err != nil {
			return err
		}
	}
	if r.workspace != nil {
		copyParams := make(map[string]any, len(params)+1)
		for key, value := range params {
			copyParams[key] = value
		}
		copyParams["workspace"] = *r.workspace
		params = copyParams
	}
	return r.runner.call(ctx, method, params, out)
}

func (r *remoteWorkspace) callAny(ctx context.Context, method string, params any, out any) error {
	values, ok := params.(map[string]any)
	if !ok {
		return errors.New("invalid workspace RPC parameters")
	}
	return r.call(ctx, method, values, out)
}

func writeRemoteError(w http.ResponseWriter, err error) {
	if marker, ok := w.(interface{ markWorkspaceWriteError(error) }); ok {
		marker.markWorkspaceWriteError(err)
	}
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, 404, "Not found")
		return
	}
	if errors.Is(err, workspaces.ErrTargetRevoked) || errors.Is(err, workspaces.ErrConflict) || errors.Is(err, workspaces.ErrUnverified) {
		httpx.Error(w, http.StatusConflict, err.Error())
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
	params, err := r.pathParams(target)
	if err != nil {
		return "", nil, err
	}
	var result struct {
		Path    string          `json:"path"`
		Entries []runnerFSEntry `json:"entries"`
	}
	err = r.call(ctx, "host.fs.list", params, &result)
	return result.Path, result.Entries, err
}

func (r *remoteWorkspace) read(ctx context.Context, target string, max int64) ([]byte, map[string]any, error) {
	params, err := r.pathParams(target)
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
	if err = r.call(ctx, "host.fs.read", params, &result); err != nil {
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
	params, err := r.pathParams(target)
	if err != nil {
		return nil, err
	}
	params["base64"] = base64.StdEncoding.EncodeToString(data)
	if r.privateWrites {
		params["mode"], params["atomic"] = 0o600, true
	}
	var result map[string]any
	err = r.call(ctx, "host.fs.write", params, &result)
	if err == nil && r.privateWrites && (gwInt(result["mode"]) != 0o600 || result["atomic"] != true) {
		err = errors.New("runtime node did not confirm secure workspace write")
	}
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
		params, err := r.pathParams(safe)
		if err != nil {
			return err
		}
		var stat runnerFSEntry
		if err = r.call(ctx, "host.fs.stat", params, &stat); err != nil {
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
			params, err := r.pathParams(target)
			if err != nil {
				return err
			}
			return r.call(ctx, "host.fs.mkdir", params, nil)
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
