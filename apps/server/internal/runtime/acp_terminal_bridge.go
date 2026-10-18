// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

func acpLoginLabels(t acpLoginTicket, name string) map[string]string {
	return map[string]string{"zakura.purpose": "acp-login", "zakura.tenant": t.Tenant, "zakura.space": t.Space, "zakura.computer": t.Computer, "zakura.adapter": t.Profile, "zakura.login": name}
}

func (h *handler) startACPLogin(ctx context.Context, target *acpLoginTarget, name string) (string, error) {
	fileEnv, err := h.prepareACPFiles(ctx, target.runner, target.exec, target.ticket.Profile, target.setup, "")
	if err != nil {
		return "", err
	}
	launch := resolveACPLaunch(acpProfileForSetup(target.setup), target.setup)
	env := map[string]string{}
	for k, v := range launch.Env {
		env[k] = v
	}
	for k, v := range fileEnv {
		env[k] = v
	}
	// Storage identity wins over user-provided HOME. This is exactly the runtime
	// profile root, not the old browser-side /workspace/data/acp staging layout.
	home := "/workspace/.zakura/acp/" + target.ticket.Profile + "/home"
	env["HOME"], env["XDG_CONFIG_HOME"], env["XDG_DATA_HOME"] = home, home+"/.config", home+"/.local/share"
	root, err := h.serverComputerHostRoot(ctx, target.exec)
	if err != nil {
		return "", err
	}
	var pulled map[string]any
	if err = target.runner.call(ctx, "docker.pull", map[string]any{"image": target.image}, &pulled); err != nil {
		return "", err
	}
	var container acpSidecarContainer
	// The adapter PID1 waits on its open stdin. Login happens in a distinct exec
	// TTY; JSON-RPC attach remains non-TTY. No socket, ports, privilege or arbitrary
	// host path is granted, and no runtime/chat container is reused or removed.
	err = target.runner.call(ctx, "docker.create", map[string]any{
		"name": name, "image": target.image, "stdinOpen": true, "restart": "no", "workingDir": "/workspace", "env": env,
		"labels": acpLoginLabels(target.ticket, name), "volumes": []map[string]any{{"hostPath": root, "containerPath": "/workspace"}},
	}, &container)
	if err != nil {
		return "", err
	}
	if container.DockerID == "" {
		return "", errors.New("login container unavailable")
	}
	return container.DockerID, nil
}

func (h *handler) bridgeACPLogin(ctx context.Context, bridge *workspaceBridge, target *acpLoginTarget) {
	name := "zakura-acp-login-" + acpLoginDigest([]byte(target.ticket.Nonce))[:24]
	cleanupKnown := true
	defer func() {
		if h.finalizeACPLoginContainer(target, name) != nil || !cleanupKnown {
			return
		}
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.releaseACPAuthLock(releaseCtx, target.ticket.Tenant, target.ticket.Space, target.ticket.Profile, target.ticket.Nonce)
	}()
	setupCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	container, err := h.startACPLogin(setupCtx, target, name)
	cancel()
	if err != nil {
		// A timed-out create or credential write may still complete remotely.
		cleanupKnown = false
		message := acpLoginStartMessage(err, "ACP login terminal could not start")
		raw, _ := json.Marshal(map[string]any{"type": "error", "message": message})
		_ = bridge.write(0x1, raw)
		return
	}
	var started struct {
		ID   string `json:"id"`
		Mode string `json:"mode"`
	}
	if err = target.runner.call(ctx, "docker.exec.start", map[string]any{"id": container, "command": []string{"bash", "--noprofile", "--norc", "-i"}, "workingDir": "/workspace", "tty": true, "cols": 80, "rows": 24}, &started); err != nil || started.ID == "" {
		_ = bridge.write(0x1, []byte(`{"type":"error","message":"interactive TTY unavailable"}`))
		return
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = target.runner.call(closeCtx, "docker.exec.close", map[string]any{"id": started.ID}, nil)
	}()
	unsubscribe := target.runner.onStream(started.ID, func(channel string, data []byte) {
		switch channel {
		case "stdout":
			raw, _ := json.Marshal(map[string]any{"type": "output", "data": string(data)})
			if bridge.write(0x1, raw) != nil {
				_ = bridge.conn.Close()
			}
		case "error":
			_ = bridge.write(0x1, []byte(`{"type":"error","message":"terminal connection lost"}`))
			_ = bridge.conn.Close()
		case "exit":
			var status struct {
				ExitCode *int `json:"exitCode"`
			}
			_ = json.Unmarshal(data, &status)
			raw, _ := json.Marshal(map[string]any{"type": "exit", "code": status.ExitCode})
			_ = bridge.write(0x1, raw)
			_ = bridge.conn.Close()
		}
	})
	defer unsubscribe()
	// Recheck membership/config periodically while an authorized shell is open.
	// A revoked key/member cannot retain an indefinite long-running session.
	watchCtx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				if _, err := h.workspaceTicketActor(watchCtx, target.ticket); err != nil {
					_ = bridge.conn.Close()
					return
				}
				if h.renewACPAuthLock(watchCtx, target.ticket.Tenant, target.ticket.Space, target.ticket.Profile, target.ticket.Nonce, acpLoginSessionLimit) != nil {
					_ = bridge.conn.Close()
					return
				}
				current, e := h.resolveACPLogin(watchCtx, target.ticket.Tenant, target.ticket.Space, target.ticket.Profile)
				if e != nil || current.ticket.ConfigHash != target.ticket.ConfigHash || current.ticket.Node != target.ticket.Node || current.ticket.Computer != target.ticket.Computer {
					_ = bridge.conn.Close()
					return
				}
			}
		}
	}()
	if bridge.write(0x1, []byte(`{"type":"ready","command":"bash --noprofile --norc -i"}`)) != nil {
		return
	}
	for {
		opcode, payload, err := readWSFrameSized(bridge.rw.Reader, 64<<10)
		if err != nil || opcode == 0x8 {
			return
		}
		if opcode == 0x9 {
			if bridge.write(0xA, payload) != nil {
				return
			}
			continue
		}
		if opcode != 0x1 {
			continue
		}
		var message struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(payload, &message) != nil {
			continue
		}
		switch message.Type {
		case "input":
			err = target.runner.call(ctx, "docker.exec.write", map[string]any{"id": started.ID, "base64": base64.StdEncoding.EncodeToString([]byte(message.Data))}, nil)
		case "resize":
			if message.Cols < 1 || message.Rows < 1 || message.Cols > 1000 || message.Rows > 1000 {
				continue
			}
			err = target.runner.call(ctx, "docker.exec.resize", map[string]any{"id": started.ID, "cols": message.Cols, "rows": message.Rows}, nil)
		}
		if err != nil {
			return
		}
	}
}
