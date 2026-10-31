package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/host"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

// workspaceProtocolV2 relies on every writer participating in fencing: pinned
// requests go through here, unpinned ones are kept out of disk storage by
// rejectUnpinnedDiskAccess.
func (h *Handler) dispatchWorkspace(ctx context.Context, msg Msg, send func(Msg)) bool {
	var fields map[string]json.RawMessage
	if strings.HasPrefix(msg.Method, "workspace.") {
		value, err := h.workspaceControl(ctx, msg.Method, msg.Params)
		if err != nil {
			send(Err(msg.ID, err.Error()))
		} else {
			send(Ok(msg.ID, value))
		}
		return true
	}
	if json.Unmarshal(msg.Params, &fields) != nil {
		send(Err(msg.ID, "invalid RPC parameters"))
		return true
	}
	rawBinding, present := fields["workspace"]
	if !present {
		return false
	}
	var binding protocol.Binding
	if err := decodeDockerCreate(rawBinding, &binding); err != nil || binding.Validate() != nil {
		send(Err(msg.ID, "invalid pinned workspace identity"))
		return true
	}
	var value any
	var err error
	if strings.HasPrefix(msg.Method, "host.fs.") && msg.Method != "host.fs.migration" {
		value, err = h.workspaceFS(ctx, binding, msg.Method, msg.Params)
	} else if msg.Method == "docker.create" {
		value, err = h.workspaceDockerCreate(ctx, binding, msg.Params)
	} else if msg.Method == "docker.exec.write" || msg.Method == "docker.exec.resize" || msg.Method == "docker.exec.close" {
		value, err = h.workspaceStream(ctx, binding, msg.Method, msg.Params)
	} else if strings.HasPrefix(msg.Method, "docker.") {
		value, err = h.workspaceDocker(ctx, binding, msg.Method, msg.Params, send)
	} else {
		err = fmt.Errorf("%s does not yet support pinned workspace execution", msg.Method)
	}
	if err != nil {
		send(Err(msg.ID, host.ScrubHostPathsInMessage(h.StorageRoot, err.Error())))
	} else {
		send(Ok(msg.ID, value))
	}
	return true
}

func (h *Handler) workspaceControl(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	s := h.workspaceState
	switch method {
	case "workspace.identity":
		var empty struct{}
		if err := decodeDockerCreate(raw, &empty); err != nil {
			return nil, err
		}
		return s.Identity(ctx)
	case "workspace.disk.allocate", "workspace.disk.verify", "workspace.disk.usage":
		var d protocol.Disk
		if err := decodeDockerCreate(raw, &d); err != nil {
			return nil, err
		}
		if method == "workspace.disk.allocate" {
			if err := s.Allocate(ctx, d); err != nil {
				return nil, err
			}
		} else if err := s.Verify(ctx, d); err != nil {
			return nil, err
		}
		used, err := s.Usage(ctx, d)
		if err != nil {
			return nil, err
		}
		return map[string]any{"disk": d, "usedBytes": used}, nil
	case "workspace.disk.delete":
		var request struct {
			Disk      protocol.Disk `json:"disk"`
			RequestID string        `json:"requestId"`
		}
		if err := decodeDockerCreate(raw, &request); err != nil {
			return nil, err
		}
		if err := s.Delete(ctx, request.Disk, request.RequestID); err != nil {
			return nil, err
		}
		return map[string]any{"disk": request.Disk, "deleted": true}, nil
	case "workspace.mount":
		var b protocol.Binding
		if err := decodeDockerCreate(raw, &b); err != nil {
			return nil, err
		}
		guard, err := s.Begin(ctx, b)
		if err != nil {
			return nil, err
		}
		defer guard.Close()
		mount, err := s.Mount(b.Disk)
		return map[string]any{"target": b.Target, "mount": mount}, err
	case "workspace.release":
		var b protocol.Binding
		if err := decodeDockerCreate(raw, &b); err != nil {
			return nil, err
		}
		return h.releaseWorkspace(ctx, b)
	case "workspace.attach", "workspace.revoke":
		var b protocol.Binding
		if err := decodeDockerCreate(raw, &b); err != nil {
			return nil, err
		}
		var err error
		if method == "workspace.attach" {
			err = s.Attach(ctx, b)
		} else {
			err = s.Revoke(ctx, b)
		}
		return map[string]any{"target": b.Target, "ok": err == nil}, err
	default:
		return nil, fmt.Errorf("unsupported workspace method")
	}
}

func (h *Handler) workspaceFS(ctx context.Context, binding protocol.Binding, method string, raw json.RawMessage) (any, error) {
	var p struct {
		Workspace *protocol.Binding `json:"workspace"`
		SpaceID   string            `json:"spaceId"`
		Root      string            `json:"root"`
		Path      string            `json:"path"`
		Max       int64             `json:"max"`
		Content   string            `json:"content"`
		Base64    string            `json:"base64"`
		Mode      *uint32           `json:"mode"`
		Atomic    *bool             `json:"atomic"`
		NoFollow  json.RawMessage   `json:"noFollow"`
		Recursive bool              `json:"recursive"`
		OldPath   string            `json:"oldPath"`
		NewPath   string            `json:"newPath"`
	}
	if err := decodeDockerCreate(raw, &p); err != nil {
		return nil, err
	}
	if p.Root != "" || p.SpaceID != "" && p.SpaceID != binding.Target.SpaceID {
		return nil, workspacestate.ErrConflict
	}
	guard, err := h.workspaceState.Begin(ctx, binding)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	fs := host.PinnedFS{Root: guard.Root, HostPath: guard.Path}
	apiPath := func(path string) (string, error) {
		absolute, err := host.Jail(guard.Path, path)
		if err != nil {
			return "", err
		}
		return host.WorkspacePath(guard.Path, absolute), nil
	}
	canonical, err := apiPath(p.Path)
	if err != nil {
		return nil, err
	}
	switch method {
	case "host.fs.stat":
		switch strings.TrimSpace(string(p.NoFollow)) {
		case "true":
			return fs.Stat(p.Path, true)
		case "", "false":
			return fs.Stat(p.Path, false)
		default:
			return nil, fmt.Errorf("noFollow must be a boolean")
		}
	case "host.fs.list":
		entries, err := fs.List(p.Path)
		return map[string]any{"path": canonical, "entries": entries}, err
	case "host.fs.read":
		if p.Max == 0 {
			p.Max = 8 << 20
		}
		if p.Max < 0 || p.Max > 16<<20 {
			return nil, fmt.Errorf("invalid workspace read limit")
		}
		data, err := fs.ReadFile(p.Path, p.Max)
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": canonical, "content": string(data), "base64": base64.StdEncoding.EncodeToString(data), "size": len(data)}, nil
	case "host.fs.write":
		var options map[string]json.RawMessage
		if err := json.Unmarshal(raw, &options); err != nil {
			return nil, err
		}
		_, modeSet := options["mode"]
		_, atomicSet := options["atomic"]
		secure := modeSet || atomicSet
		if secure && (p.Mode == nil || *p.Mode != 0600 || p.Atomic == nil || !*p.Atomic) {
			return nil, fmt.Errorf("secure writes require mode 0600 and atomic true")
		}
		data := []byte(p.Content)
		if p.Base64 != "" {
			data, err = base64.StdEncoding.DecodeString(p.Base64)
			if err != nil {
				return nil, err
			}
		}
		write := fs.WriteFile
		if secure {
			write = fs.WritePrivateFile
		}
		revision, err := write(p.Path, data)
		if err != nil {
			return nil, err
		}
		result := map[string]any{"path": canonical, "ok": true, "revision": revision}
		if secure {
			result["mode"], result["atomic"] = 0600, true
		}
		return result, nil
	case "host.fs.mkdir":
		if err := fs.Mkdir(p.Path); err != nil {
			return nil, err
		}
		absolute, err := host.Jail(guard.Path, p.Path)
		return map[string]any{"path": canonical, "ok": true, "abs": absolute}, err
	case "host.fs.remove":
		err := fs.Remove(p.Path, p.Recursive)
		return map[string]any{"path": canonical, "ok": err == nil}, err
	case "host.fs.rename":
		if err := fs.Rename(p.OldPath, p.NewPath); err != nil {
			return nil, err
		}
		canonical, err := apiPath(p.NewPath)
		return map[string]any{"path": canonical, "ok": true}, err
	default:
		return nil, fmt.Errorf("unsupported pinned workspace file operation")
	}
}
