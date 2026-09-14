package rpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"

	"zakura.dev/agent/internal/docker"
	"zakura.dev/agent/internal/host"
	"zakura.dev/agent/internal/sys"
)

type Handler struct {
	Kind        string
	StorageRoot string
	jobs        *host.Registry
	ptys        map[string]*host.LiveStream
	mu          sync.Mutex
}

func New(kind, storageRoot string) *Handler {
	return &Handler{
		Kind:        kind,
		StorageRoot: storageRoot,
		jobs:        host.NewRegistry(),
		ptys:        map[string]*host.LiveStream{},
	}
}

func (h *Handler) workspace(agentID string) string {
	return host.AgentWorkspace(h.StorageRoot, agentID)
}

func (h *Handler) Dispatch(ctx context.Context, msg Msg, send func(Msg)) {
	var err error
	var result any
	switch msg.Method {
	case "sys.info":
		var p struct {
			Light bool `json:"light"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		if p.Light {
			result = sys.VersionInfo()
		} else {
			result = sys.Collect(h.Kind, h.StorageRoot)
		}
	case "sys.update":
		var p sys.UpdateParams
		if err = json.Unmarshal(msg.Params, &p); err != nil {
			break
		}
		var progress func(sys.UpdateProgress)
		if p.ProgressStream != "" {
			progress = func(event sys.UpdateProgress) {
				data, _ := json.Marshal(event)
				send(Msg{Type: "stream", Stream: p.ProgressStream, Chan: "progress", Data: base64.StdEncoding.EncodeToString(data)})
			}
		}
		result, err = sys.Apply(ctx, p, progress)
	case "host.fs.stat":
		result, err = h.fsStat(msg.Params)
	case "host.fs.list":
		result, err = h.fsList(msg.Params)
	case "host.fs.read":
		result, err = h.fsRead(msg.Params)
	case "host.fs.write":
		result, err = h.fsWrite(msg.Params)
	case "host.fs.mkdir":
		result, err = h.fsMkdir(msg.Params)
	case "host.fs.remove":
		result, err = h.fsRemove(msg.Params)
	case "host.fs.rename":
		result, err = h.fsRename(msg.Params)
	case "host.exec":
		result, err = h.hostExec(msg.Params)
	case "host.exec.start":
		result, err = h.hostExecStart(msg.Params)
	case "host.exec.get":
		result, err = h.hostExecGet(msg.Params)
	case "host.exec.kill":
		result, err = h.hostExecKill(msg.Params)
	case "host.pty.start":
		result, err = h.ptyStart(msg.Params, send)
	case "host.pty.write":
		err = h.ptyWrite(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "host.pty.resize":
		err = h.ptyResize(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "host.pty.close":
		err = h.ptyClose(msg.Params)
		result = map[string]bool{"ok": true}
	case "docker.ping":
		result = docker.Probe()
	case "docker.pull":
		var p struct {
			Image          string `json:"image"`
			ProgressStream string `json:"progressStream"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		var progress func(docker.PullEvent)
		if p.ProgressStream != "" {
			progress = func(event docker.PullEvent) {
				data, _ := json.Marshal(event)
				send(Msg{Type: "stream", Stream: p.ProgressStream, Chan: "progress", Data: base64.StdEncoding.EncodeToString(data)})
			}
		}
		err = docker.PullWithProgress(ctx, p.Image, progress)
		result = map[string]string{"image": p.Image}
	case "docker.run":
		var spec docker.RunSpec
		_ = json.Unmarshal(msg.Params, &spec)
		result, err = docker.Run(ctx, spec)
	case "docker.stop":
		var p struct {
			ID     string `json:"id"`
			Remove bool   `json:"remove"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		err = docker.Stop(ctx, p.ID, p.Remove)
		result = map[string]bool{"ok": err == nil}
	case "docker.inspect":
		var p struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		result, err = docker.Inspect(ctx, p.ID)
	case "docker.exec":
		result, err = h.dockerExec(ctx, msg.Params)
	case "docker.logs":
		var p struct {
			ID   string `json:"id"`
			Tail int    `json:"tail"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		if p.Tail == 0 {
			p.Tail = 200
		}
		var logs string
		logs, err = docker.Logs(ctx, p.ID, p.Tail)
		result = map[string]string{"logs": logs}
	case "docker.copy":
		var p struct {
			Src  string `json:"src"`
			Dest string `json:"dest"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		err = docker.Copy(ctx, p.Src, p.Dest)
		result = map[string]bool{"ok": err == nil}
	case "docker.list":
		var p struct {
			Label string `json:"label"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		result, err = docker.List(ctx, p.Label)
	case "docker.images":
		var p struct {
			Images []string `json:"images"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		result = docker.InspectImages(ctx, p.Images)
	case "docker.recreate":
		var p struct {
			Image string `json:"image"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		result, err = docker.RecreateStale(ctx, p.Image)
	case "docker.exec.start":
		result, err = h.dockerStdioStart(msg.Params, send)
	case "docker.attach":
		result, err = h.dockerAttach(msg.Params, send)
	case "docker.exec.write":
		err = h.ptyWrite(msg.Params)
		result = map[string]bool{"ok": err == nil}
	case "docker.exec.close":
		err = h.ptyClose(msg.Params)
		result = map[string]bool{"ok": true}
	default:
		send(Err(msg.ID, "未知方法: "+msg.Method))
		return
	}
	if err != nil {
		message := err.Error()
		if strings.HasPrefix(msg.Method, "host.fs.") {
			var p agentPath
			_ = json.Unmarshal(msg.Params, &p)
			message = host.ScrubHostPathsInMessage(h.rootOf(p), message)
		}
		send(Err(msg.ID, message))
		return
	}
	send(Ok(msg.ID, result))
	if update, ok := result.(sys.UpdateResult); ok {
		update.AfterReply()
	}
}

type agentPath struct {
	AgentID string `json:"agentId"`
	Path    string `json:"path"`
	Root    string `json:"root,omitempty"`
}

func (h *Handler) rootOf(p agentPath) string {
	if p.Root != "" {
		return p.Root
	}
	if p.AgentID != "" {
		return h.workspace(p.AgentID)
	}
	return h.StorageRoot
}

// Called after the filesystem operation has validated the path with Jail.
func (h *Handler) apiPath(p agentPath, path string) string {
	root := h.rootOf(p)
	abs, err := host.Jail(root, path)
	if err != nil {
		return path
	}
	return host.WorkspacePath(root, abs)
}

func (h *Handler) fsStat(raw json.RawMessage) (any, error) {
	var p agentPath
	_ = json.Unmarshal(raw, &p)
	return host.Stat(h.rootOf(p), p.Path)
}

func (h *Handler) fsList(raw json.RawMessage) (any, error) {
	var p agentPath
	_ = json.Unmarshal(raw, &p)
	ents, err := host.List(h.rootOf(p), p.Path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p, p.Path), "entries": ents}, nil
}

func (h *Handler) fsRead(raw json.RawMessage) (any, error) {
	var p struct {
		agentPath
		Max int64 `json:"max"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.Max == 0 {
		p.Max = 8 << 20
	}
	b, err := host.ReadFile(h.rootOf(p.agentPath), p.Path, p.Max)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":    h.apiPath(p.agentPath, p.Path),
		"content": string(b),
		"base64":  base64.StdEncoding.EncodeToString(b),
		"size":    len(b),
	}, nil
}

func (h *Handler) fsWrite(raw json.RawMessage) (any, error) {
	var p struct {
		agentPath
		Content string `json:"content"`
		Base64  string `json:"base64"`
	}
	_ = json.Unmarshal(raw, &p)
	data := []byte(p.Content)
	if p.Base64 != "" {
		var err error
		data, err = base64.StdEncoding.DecodeString(p.Base64)
		if err != nil {
			return nil, err
		}
	}
	rev, err := host.WriteFile(h.rootOf(p.agentPath), p.Path, data)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p.agentPath, p.Path), "ok": true, "revision": rev}, nil
}

func (h *Handler) fsMkdir(raw json.RawMessage) (any, error) {
	var p agentPath
	_ = json.Unmarshal(raw, &p)
	root := h.rootOf(p)
	if err := host.Mkdir(root, p.Path); err != nil {
		return nil, err
	}
	abs, err := host.Jail(root, p.Path)
	if err != nil {
		abs = root
	}
	return map[string]any{"path": h.apiPath(p, p.Path), "ok": true, "abs": abs}, nil
}

func (h *Handler) fsRemove(raw json.RawMessage) (any, error) {
	var p struct {
		agentPath
		Recursive bool `json:"recursive"`
	}
	_ = json.Unmarshal(raw, &p)
	if err := host.Remove(h.rootOf(p.agentPath), p.Path, p.Recursive); err != nil {
		return nil, err
	}
	return map[string]any{"path": h.apiPath(p.agentPath, p.Path), "ok": true}, nil
}

func (h *Handler) fsRename(raw json.RawMessage) (any, error) {
	var p struct {
		agentPath
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	_ = json.Unmarshal(raw, &p)
	if err := host.Rename(h.rootOf(p.agentPath), p.OldPath, p.NewPath); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "path": h.apiPath(p.agentPath, p.NewPath)}, nil
}

func (h *Handler) hostExec(raw json.RawMessage) (any, error) {
	var p struct {
		host.ExecParams
		AgentID string `json:"agentId"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.AgentID != "" {
		root = h.workspace(p.AgentID)
		_ = host.EnsureDir(root)
	}
	return host.Run(root, p.ExecParams)
}

func (h *Handler) hostExecStart(raw json.RawMessage) (any, error) {
	var p struct {
		host.ExecParams
		AgentID string `json:"agentId"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.AgentID != "" {
		root = h.workspace(p.AgentID)
		_ = host.EnsureDir(root)
	}
	return h.jobs.Start(root, p.ExecParams)
}

func (h *Handler) hostExecGet(raw json.RawMessage) (any, error) {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	snap := h.jobs.Get(p.ID)
	if snap == nil {
		return nil, fmt.Errorf("job 不存在")
	}
	return snap, nil
}

func (h *Handler) hostExecKill(raw json.RawMessage) (any, error) {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	snap := h.jobs.Kill(p.ID)
	if snap == nil {
		return nil, fmt.Errorf("job 不存在")
	}
	return snap, nil
}

func (h *Handler) ptyStart(raw json.RawMessage, send func(Msg)) (any, error) {
	var p struct {
		host.ExecParams
		AgentID string `json:"agentId"`
		Cols    int    `json:"cols"`
		Rows    int    `json:"rows"`
	}
	_ = json.Unmarshal(raw, &p)
	root := h.StorageRoot
	if p.AgentID != "" {
		root = h.workspace(p.AgentID)
		_ = host.EnsureDir(root)
	}
	sess, err := host.StartPty(root, p.ExecParams, p.Cols, p.Rows)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{
					Type:   "stream",
					Stream: sess.ID,
					Chan:   "stdout",
					Data:   base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				if err != io.EOF && !strings.Contains(err.Error(), "file already closed") {
					send(Msg{Type: "stream", Stream: sess.ID, Chan: "stderr", Data: err.Error()})
				}
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}

func (h *Handler) ptyWrite(raw json.RawMessage) error {
	var p struct {
		ID     string `json:"id"`
		Base64 string `json:"base64"`
		Data   string `json:"data"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	h.mu.Unlock()
	if s == nil {
		return fmt.Errorf("pty 不存在")
	}
	b := []byte(p.Data)
	if p.Base64 != "" {
		var err error
		b, err = base64.StdEncoding.DecodeString(p.Base64)
		if err != nil {
			return err
		}
	}
	_, err := s.Write(b)
	return err
}

func (h *Handler) ptyResize(raw json.RawMessage) error {
	var p struct {
		ID   string `json:"id"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	h.mu.Unlock()
	if s == nil {
		return fmt.Errorf("pty 不存在")
	}
	return s.Resize(p.Cols, p.Rows)
}

func (h *Handler) ptyClose(raw json.RawMessage) error {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	h.mu.Lock()
	s := h.ptys[p.ID]
	delete(h.ptys, p.ID)
	h.mu.Unlock()
	if s != nil {
		return s.Close()
	}
	return nil
}

func (h *Handler) dockerStdioStart(raw json.RawMessage, send func(Msg)) (any, error) {
	if err := docker.Require(); err != nil {
		return nil, err
	}
	var p struct {
		ID         string            `json:"id"`
		Command    []string          `json:"command"`
		WorkingDir string            `json:"workingDir"`
		Env        map[string]string `json:"env"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.ID == "" || len(p.Command) == 0 {
		return nil, fmt.Errorf("id 与 command 必填")
	}
	sess, err := host.StartDockerExec(p.ID, p.Command, p.WorkingDir, p.Env)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "stdout", Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}

func (h *Handler) dockerAttach(raw json.RawMessage, send func(Msg)) (any, error) {
	if err := docker.Require(); err != nil {
		return nil, err
	}
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.ID == "" {
		return nil, fmt.Errorf("id 必填")
	}
	sess, err := host.StartDockerAttach(p.ID)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.ptys[sess.ID] = sess
	h.mu.Unlock()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "stdout", Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				send(Msg{Type: "stream", Stream: sess.ID, Chan: "exit"})
				return
			}
		}
	}()
	return map[string]any{"id": sess.ID, "mode": sess.Mode}, nil
}

func (h *Handler) dockerExec(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		ID         string            `json:"id"`
		Command    []string          `json:"command"`
		WorkingDir string            `json:"workingDir"`
		Env        map[string]string `json:"env"`
	}
	_ = json.Unmarshal(raw, &p)
	out, errb, code, err := docker.Exec(ctx, p.ID, p.Command, p.WorkingDir, p.Env)
	if err != nil {
		return nil, err
	}
	return map[string]any{"exitCode": code, "stdout": out, "stderr": errb}, nil
}
