// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type spaceWorkspaceRequestKey struct{}

// Canonical management APIs always address the Space server, not the computer
// selected for an executing tool. Legacy Agent routes are authorized adapters.
func (h *handler) workspaceRequestSpace(r *http.Request) (string, error) {
	if space, ok := r.Context().Value(spaceWorkspaceRequestKey{}).(string); ok {
		return space, nil
	}
	agent := chi.URLParam(r, "id")
	if err := httpx.AuthorizeResource(r.Context(), h.deps, principal(r), "", agent); err != nil {
		return "", ErrNotFound
	}
	return h.spaceForAgent(r.Context(), principal(r).TenantID, agent)
}
func (h *handler) legacyWorkspaceRoute(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		space, err := h.workspaceRequestSpace(r)
		if err != nil {
			statusErr(w, err)
			return
		}
		h.withWorkspaceWrite(w, r, space, next)
	}
}

func (h *handler) spaceWorkspaceRoute(next http.HandlerFunc) http.HandlerFunc {
	return h.spaceWorkspaceScope(func(w http.ResponseWriter, r *http.Request) {
		h.withWorkspaceWrite(w, r, chi.URLParam(r, "id"), next)
	})
}

// Lifecycle routes own their durable lease. Apply the same authorization and
// Space binding without first claiming a conflicting shared-write lease.
func (h *handler) spaceWorkspaceScope(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		space := chi.URLParam(r, "id")
		if err := httpx.AuthorizeResource(r.Context(), h.deps, principal(r), space, ""); err != nil {
			statusErr(w, ErrNotFound)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), spaceWorkspaceRequestKey{}, space))
		next(w, r)
	}
}
func (h *handler) registerSpaceWorkspace(r chi.Router) {
	for _, route := range []struct {
		method, path string
		handler      http.HandlerFunc
	}{
		{"GET", "/fs", h.fsInfo}, {"GET", "/fs/list", h.fsList}, {"GET", "/fs/read", h.fsRead}, {"GET", "/fs/download", h.fsDownload},
		{"POST", "/fs/write", h.fsWrite}, {"POST", "/fs/upload", h.fsUpload}, {"POST", "/fs/mkdir", h.fsMkdir}, {"POST", "/fs/delete", h.fsDelete}, {"POST", "/fs/rename", h.fsRename}, {"POST", "/fs/archive", h.fsArchive}, {"POST", "/fs/extract", h.fsExtract},
		{"GET", "/projects", h.listProjects}, {"POST", "/projects", h.createProject}, {"PATCH", "/projects/{slug}", h.patchProject}, {"DELETE", "/projects/{slug}", h.deleteProject},
		{"GET", "/projects/{slug}/config", h.getProjectConfig}, {"PUT", "/projects/{slug}/instructions", h.putProjectInstructions}, {"PUT", "/projects/{slug}/hooks", h.putProjectHooks}, {"POST", "/projects/{slug}/skills", h.putProjectSkill}, {"PUT", "/projects/{slug}/skills/{name}", h.putProjectSkill}, {"DELETE", "/projects/{slug}/skills/{name}", h.deleteProjectSkill}, {"GET", "/projects/{slug}/skills/{name}/file", h.getProjectSkillFile},
	} {
		r.Method(route.method, "/spaces/{id}"+route.path, h.spaceWorkspaceRoute(route.handler))
	}
}
func (h *handler) workspaceForSpace(ctx context.Context, tenant, space string) (workspaceFS, error) {
	if _, err := h.store.GetSpace(ctx, tenant, space); err != nil {
		return workspaceFS{}, err
	}
	base := os.Getenv("ZAKURA_WORKSPACE_ROOT")
	if base == "" {
		base = filepath.Join("data", "workspaces")
	}
	root, err := filepath.Abs(filepath.Join(base, tenant, space))
	if err != nil {
		return workspaceFS{}, err
	}
	if err = os.MkdirAll(root, 0o750); err != nil {
		return workspaceFS{}, err
	}
	return workspaceFS{root: root}, nil
}
func (h *handler) requestWorkspace(r *http.Request) (workspaceFS, error) {
	space, err := h.workspaceRequestSpace(r)
	if err != nil {
		return workspaceFS{}, err
	}
	return h.workspaceForSpace(r.Context(), principal(r).TenantID, space)
}
func (h *handler) remoteSpaceWorkspace(ctx context.Context, tenant, space string) (*remoteWorkspace, bool, error) {
	record, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return nil, false, err
	}
	node := ""
	if record.RuntimeNodeID != nil {
		node = strings.TrimSpace(*record.RuntimeNodeID)
	}
	if node == "" {
		return nil, false, nil
	}
	if h.hub == nil {
		return nil, true, errors.New("runtime node is offline")
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, node); err != nil {
		return nil, true, err
	}
	runner, err := h.hub.get(node)
	if err != nil {
		return nil, true, err
	}
	return &remoteWorkspace{runner: runner, spaceID: space}, true, nil
}
func (h *handler) requestRemoteWorkspace(r *http.Request) (*remoteWorkspace, bool, error) {
	space, err := h.workspaceRequestSpace(r)
	if err != nil {
		return nil, false, err
	}
	return h.remoteSpaceWorkspace(r.Context(), principal(r).TenantID, space)
}
