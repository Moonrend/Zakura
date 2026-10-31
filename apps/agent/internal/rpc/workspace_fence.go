package rpc

import (
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/host"
)

// Managed disks and their ownership metadata are reachable only through a
// pinned binding. Unpinned file and container requests must not resolve into
// them, otherwise a retired writer could bypass revocation fencing.
func (h *Handler) managedStorage() []string {
	roots := []string{filepath.Join(h.StorageRoot, "disks")}
	for _, base := range []string{h.StorageRoot, h.workspaceState.StateRoot} {
		if base != "" {
			roots = append(roots, filepath.Join(base, ".workspaces"))
		}
	}
	return roots
}

func (h *Handler) insideManagedStorage(target string) bool {
	abs, err := filepath.Abs(target)
	if err != nil {
		return true
	}
	for _, root := range h.managedStorage() {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			return true
		}
		rel, err := filepath.Rel(rootAbs, abs)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func (h *Handler) rejectUnpinnedDiskAccess(method string, raw json.RawMessage) error {
	denied := fmt.Errorf("managed workspace disks require a pinned workspace binding")
	switch {
	case strings.HasPrefix(method, "host.fs.") && method != "host.fs.migration":
		var p struct {
			spacePath
			OldPath string `json:"oldPath"`
			NewPath string `json:"newPath"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return nil
		}
		root := h.rootOf(p.spacePath)
		if h.insideManagedStorage(root) {
			return denied
		}
		for _, rel := range []string{p.Path, p.OldPath, p.NewPath} {
			if abs, err := host.Jail(root, rel); err == nil && h.insideManagedStorage(abs) {
				return denied
			}
		}
	case method == "host.exec" || method == "host.exec.start" || method == "host.pty.start":
		var p struct {
			SpaceID    string `json:"spaceId"`
			WorkingDir string `json:"workingDir"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return nil
		}
		root := h.StorageRoot
		if p.SpaceID != "" {
			root = h.workspace(p.SpaceID)
		}
		if abs, err := host.Jail(root, p.WorkingDir); err == nil && h.insideManagedStorage(abs) {
			return denied
		}
	case method == "docker.create" || method == "docker.run":
		var p docker.RunSpec
		if json.Unmarshal(raw, &p) != nil {
			return nil
		}
		for _, v := range p.Volumes {
			if v.HostPath != "" && h.insideManagedStorage(v.HostPath) {
				return denied
			}
			if v.VolumeName != "" && v.VolumeName == h.workspaceState.VolumeName && (v.VolumeSubpath == "" || managedSubpath(v.VolumeSubpath)) {
				return denied
			}
		}
	}
	return nil
}

func managedSubpath(subpath string) bool {
	first := strings.SplitN(path.Clean(subpath), "/", 2)[0]
	return first == "disks" || first == ".workspaces"
}
