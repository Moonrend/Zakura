package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func workspaceEffectMatches(effect workspacestate.Effect, target protocol.Target) bool {
	r := effect.Create
	return effect.Kind == "container" && r != nil && r.OperationID == effect.ID && r.TenantID == target.TenantID && r.SpaceID == target.SpaceID && r.InstanceID == target.InstanceID && r.Generation == target.Generation && r.DiskID == target.DiskID && r.LocatorVersion == target.LocatorVersion && r.NodeIncarnation == target.NodeIncarnation
}

// Container IDs are accepted only from this instance's durable create ledger.
// Names, prefixes and labels alone cannot authorize starting another writer.
func (h *Handler) workspaceContainer(ctx context.Context, guard *workspacestate.Guard, b protocol.Binding, id string) (docker.ContainerInfo, error) {
	effects, err := guard.Effects()
	if err != nil {
		return docker.ContainerInfo{}, err
	}
	for _, effect := range effects {
		if effect.Released || !workspaceEffectMatches(effect, b.Target) {
			continue
		}
		status, err := docker.CreateReceiptStatus(ctx, h.workspaceState.StateRoot, *effect.Create)
		if err != nil {
			return docker.ContainerInfo{}, err
		}
		if status.State != "committed" || status.Container == nil {
			return docker.ContainerInfo{}, fmt.Errorf("workspace creation is still unconfirmed")
		}
		expected := *status.Container
		if expected.DockerID != id {
			continue
		}
		if effect.ExternalID != "" && effect.ExternalID != id {
			return docker.ContainerInfo{}, workspacestate.ErrConflict
		}
		actual, err := docker.Inspect(ctx, id)
		if err != nil {
			return docker.ContainerInfo{}, err
		}
		if actual.DockerID != id || actual.Name != expected.Name {
			return docker.ContainerInfo{}, workspacestate.ErrConflict
		}
		for key, value := range expected.Labels {
			if actual.Labels[key] != value {
				return docker.ContainerInfo{}, workspacestate.ErrConflict
			}
		}
		return actual, nil
	}
	return docker.ContainerInfo{}, fmt.Errorf("container does not belong to the pinned workspace instance")
}

func (h *Handler) workspaceDocker(ctx context.Context, b protocol.Binding, method string, raw json.RawMessage, send func(Msg)) (any, error) {
	if requested, err := h.sandboxRequested(raw); err != nil || requested {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("workspace container execution is unavailable in sandbox mode")
	}
	var p struct {
		Workspace  protocol.Binding  `json:"workspace"`
		ID         string            `json:"id"`
		Command    []string          `json:"command"`
		WorkingDir string            `json:"workingDir"`
		Env        map[string]string `json:"env"`
		TTY        bool              `json:"tty"`
		Cols       int               `json:"cols"`
		Rows       int               `json:"rows"`
		Remove     bool              `json:"remove"`
		Tail       int               `json:"tail"`
		TimeoutMS  int64             `json:"timeoutMs"`
		Stdin string `json:"stdin"`
		MaxOutputBytes int `json:"maxOutputBytes"`
	}
	if err := decodeDockerCreate(raw, &p); err != nil {
		return nil, err
	}
	if p.ID == "" || p.Remove && method != "docker.stop" {
		return nil, fmt.Errorf("exact container ID required; only docker.stop can remove it")
	}
	if p.Remove {
		err := h.cleanupWorkspaceContainer(ctx, b, p.ID)
		return map[string]bool{"ok": err == nil}, err
	}
	if p.TimeoutMS < 0 || p.TimeoutMS > int64((24*time.Hour)/time.Millisecond) {
		return nil, fmt.Errorf("invalid workspace execution timeout")
	}
	if p.TimeoutMS > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
		defer cancel()
	}
	guard, err := h.workspaceState.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	container, err := h.workspaceContainer(ctx, guard, b, p.ID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "docker.inspect":
		return container, nil
	case "docker.logs":
		if p.Tail <= 0 {
			p.Tail = 200
		}
		logs, err := docker.Logs(ctx, p.ID, p.Tail)
		return map[string]string{"logs": logs}, err
	case "docker.start":
		return docker.Start(ctx, p.ID)
	case "docker.stop":
		err := docker.Stop(ctx, p.ID, false)
		return map[string]bool{"ok": err == nil}, err
	case "docker.exec":
		return h.dockerExec(ctx, raw)
	case "docker.exec.start", "docker.attach":
		var result any
		if method == "docker.attach" {
			result, err = h.dockerAttach(raw, send)
		} else {
			result, err = h.dockerStdioStart(raw, send)
		}
		if err != nil {
			return nil, err
		}
		value, ok := result.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid workspace stream result")
		}
		id, _ := value["id"].(string)
		h.mu.Lock()
		if h.ptys[id] != nil {
			h.workspaceStreams[id] = b
		}
		h.mu.Unlock()
		if ctx.Err() != nil {
			params, _ := json.Marshal(map[string]string{"id": id})
			_ = h.ptyClose(params)
			return nil, ctx.Err()
		}
		return result, nil
	default:
		return nil, fmt.Errorf("unsupported workspace container method")
	}
}

func (h *Handler) workspaceStream(ctx context.Context, b protocol.Binding, method string, raw json.RawMessage) (any, error) {
	var p struct {
		Workspace   protocol.Binding `json:"workspace"`
		ID          string           `json:"id"`
		Data        string           `json:"data"`
		Base64      string           `json:"base64"`
		Cols        int              `json:"cols"`
		Rows        int              `json:"rows"`
		StreamOwner string           `json:"streamOwner"`
	}
	if err := decodeDockerCreate(raw, &p); err != nil {
		return nil, err
	}
	if p.StreamOwner != "" && p.StreamOwner != h.streamOwner {
		return nil, fmt.Errorf("stream executor changed; cleanup is unconfirmed")
	}
	if method == "docker.exec.close" {
		// Closing a transport creates no writer and must also work after revoke.
		// A missing stream is conclusive only within the same executor lifetime;
		// container effects remain in the durable instance ledger until release.
		if p.StreamOwner != h.streamOwner {
			return nil, fmt.Errorf("stream executor identity required")
		}
		h.mu.Lock()
		binding, managed := h.workspaceStreams[p.ID]
		stream := h.ptys[p.ID]
		h.mu.Unlock()
		if managed && binding != b || !managed && stream != nil {
			return nil, workspacestate.ErrConflict
		}
		err := h.ptyClose(raw)
		return map[string]bool{"ok": err == nil}, err
	}
	guard, err := h.workspaceState.Begin(ctx, b)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	h.mu.Lock()
	binding, ok := h.workspaceStreams[p.ID]
	h.mu.Unlock()
	if !ok || binding != b {
		return nil, workspacestate.ErrConflict
	}
	switch method {
	case "docker.exec.write":
		err = h.ptyWrite(raw)
	case "docker.exec.resize":
		err = h.ptyResize(raw)
	case "docker.exec.close":
		err = h.ptyClose(raw)
	default:
		err = fmt.Errorf("unsupported workspace stream method")
	}
	return map[string]bool{"ok": err == nil}, err
}

func (h *Handler) rejectUnpinnedContainer(ctx context.Context, method string, raw json.RawMessage) error {
	switch method {
	case "docker.start", "docker.stop", "docker.exec", "docker.exec.start", "docker.attach", "docker.exec.write", "docker.exec.resize", "docker.exec.close", "host.pty.write", "host.pty.resize", "host.pty.close":
	default:
		return nil
	}
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	switch method {
	case "docker.start", "docker.stop", "docker.exec", "docker.exec.start", "docker.attach":
		container, err := docker.Inspect(ctx, p.ID)
		if err != nil {
			return err
		}
		if container.Labels["zakura.workspace-instance"] != "" {
			return fmt.Errorf("workspace container requires a pinned workspace binding")
		}
	case "docker.exec.write", "docker.exec.resize", "docker.exec.close", "host.pty.write", "host.pty.resize", "host.pty.close":
		h.mu.Lock()
		_, managed := h.workspaceStreams[p.ID]
		h.mu.Unlock()
		if managed {
			return fmt.Errorf("workspace stream requires a pinned workspace binding")
		}
	}
	return nil
}
