// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	codemodeDefaultMS = 120000
	codemodeMinMS     = 1000
	codemodeMaxMS     = 600000
	codemodeCallMS    = 60000
)

const codemodeHarnessJS = `import readline from "node:readline";

const output = [];
const pending = new Map();
let seq = 0;

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const text = (value) => {
  output.push(typeof value === "string" ? value : JSON.stringify(value));
};

const tools = new Proxy(
  {},
  {
    get: (_target, name) => async (args) => {
      const id = ++seq;
      write({ op: "call", id, name, args: args ?? {} });
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
  }
);

const consoleShim = { log: text, error: text, warn: text, info: text, debug: text };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const finish = (message) => {
  process.stdout.write(JSON.stringify(message) + "\n", () => process.exit(0));
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.op === "result") {
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(String(message.error)));
    }
    return;
  }
  if (message.op === "run") {
    try {
      const fn = new AsyncFunction("tools", "text", "console", String(message.code ?? ""));
      const result = await fn(tools, text, consoleShim);
      if (result !== undefined) {
        text(result);
      }
      finish({ op: "done", ok: true, output });
    } catch (error) {
      finish({ op: "done", ok: false, error: String((error && error.message) || error) });
    }
  }
});
`

type codemodeEvent struct {
	data []byte
	exit bool
}

func (h *handler) runCodemodeTool(ctx context.Context, tenant, agent, session string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	code := builtinStringArg(parsed, "code")
	if strings.TrimSpace(code) == "" {
		return nil, errors.New("code required")
	}
	timeoutMS := builtinIntArg(parsed, "timeout_ms", codemodeDefaultMS)
	if timeoutMS < codemodeMinMS {
		timeoutMS = codemodeMinMS
	}
	if timeoutMS > codemodeMaxMS {
		timeoutMS = codemodeMaxMS
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()

	remote, selected, err := h.remoteWorkspace(runCtx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if !selected {
		return nil, errors.New("no runtime node bound to this space")
	}
	if _, err := remote.write(runCtx, "/.zakura/codemode/harness.mjs", []byte(codemodeHarnessJS)); err != nil {
		return nil, err
	}
	var kindRow struct {
		WorkspaceKind string `gorm:"column:workspace_kind"`
	}
	if err := h.deps.Gorm.WithContext(runCtx).Table("agents AS a").Select("s.workspace_kind AS workspace_kind").Joins("JOIN spaces s ON s.id=a.space_id").Where("a.tenant_id=? AND a.id=?", tenant, agent).Take(&kindRow).Error; err != nil {
		return nil, err
	}
	runner := remote.runner
	command := []string{"node", "/.zakura/codemode/harness.mjs"}
	startMethod, writeMethod, closeMethod := "host.pty.start", "host.pty.write", "host.pty.close"
	params := map[string]any{"spaceId": remote.spaceID, "command": command, "workingDir": "/workspace", "env": map[string]string{}, "cols": 120, "rows": 40}
	if kindRow.WorkspaceKind != "host" {
		var containers []struct {
			DockerID string            `json:"dockerId"`
			Labels   map[string]string `json:"labels"`
		}
		if err := runner.call(runCtx, "docker.list", map[string]any{"label": "zakura.space=" + remote.spaceID}, &containers); err != nil {
			return nil, err
		}
		dockerID := ""
		for _, container := range containers {
			if container.Labels["zakura.purpose"] == "workspace" || dockerID == "" {
				dockerID = container.DockerID
			}
		}
		if dockerID == "" {
			return nil, errors.New("workspace container is not running")
		}
		startMethod, writeMethod, closeMethod = "docker.exec.start", "docker.exec.write", "docker.exec.close"
		params = map[string]any{"id": dockerID, "command": command, "workingDir": "/workspace", "env": map[string]string{}}
	}
	var started struct {
		ID string `json:"id"`
	}
	if err := runner.call(runCtx, startMethod, params, &started); err != nil {
		return nil, err
	}
	if started.ID == "" {
		return nil, errors.New("workspace returned no process id")
	}
	processID := started.ID

	events := make(chan codemodeEvent, 256)
	var exitOnce sync.Once
	detach := runner.onStream(processID, func(channel string, data []byte) {
		switch channel {
		case "exit":
			exitOnce.Do(func() { events <- codemodeEvent{exit: true} })
		case "stdout":
			events <- codemodeEvent{data: append([]byte(nil), data...)}
		}
	})
	defer detach()
	defer func() {
		closeCtx, closeCancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer closeCancel()
		var ignored map[string]any
		_ = runner.call(closeCtx, closeMethod, map[string]any{"id": processID}, &ignored)
	}()

	writeMessage := func(message any) error {
		raw, err := json.Marshal(message)
		if err != nil {
			return err
		}
		raw = append(raw, '\n')
		var ignored map[string]any
		return runner.call(runCtx, writeMethod, map[string]any{"id": processID, "base64": base64.StdEncoding.EncodeToString(raw)}, &ignored)
	}
	if err := writeMessage(map[string]any{"op": "run", "code": code}); err != nil {
		return nil, err
	}

	startedAt := time.Now()
	var buffer []byte
	var output json.RawMessage
	finished := false
	for !finished {
		select {
		case <-runCtx.Done():
			return nil, errors.New("codemode script did not finish")
		case event := <-events:
			if event.exit {
				return nil, errors.New("codemode script did not finish")
			}
			buffer = append(buffer, event.data...)
			for {
				index := bytes.IndexByte(buffer, '\n')
				if index < 0 {
					break
				}
				line := bytes.TrimSpace(buffer[:index])
				buffer = buffer[index+1:]
				if len(line) == 0 {
					continue
				}
				var message struct {
					Op     string          `json:"op"`
					ID     int             `json:"id"`
					Name   string          `json:"name"`
					Args   json.RawMessage `json:"args"`
					OK     bool            `json:"ok"`
					Error  string          `json:"error"`
					Output json.RawMessage `json:"output"`
				}
				if json.Unmarshal(line, &message) != nil {
					continue
				}
				switch message.Op {
				case "call":
					if message.Name == "codemode" {
						_ = writeMessage(map[string]any{"op": "result", "id": message.ID, "ok": false, "error": "codemode cannot start codemode scripts"})
						continue
					}
					callArgs := message.Args
					if len(callArgs) == 0 {
						callArgs = json.RawMessage("{}")
					}
					callCtx, callCancel := context.WithTimeout(context.WithoutCancel(runCtx), codemodeCallMS*time.Millisecond)
					result, callErr := h.dispatchAgentTool(callCtx, tenant, agent, session, message.Name, callArgs)
					callCancel()
					if callErr != nil {
						_ = writeMessage(map[string]any{"op": "result", "id": message.ID, "ok": false, "error": callErr.Error()})
					} else {
						_ = writeMessage(map[string]any{"op": "result", "id": message.ID, "ok": true, "result": json.RawMessage(result)})
					}
				case "done":
					if !message.OK {
						return nil, errors.New("codemode script failed: " + message.Error)
					}
					output = message.Output
					if len(output) == 0 {
						output = json.RawMessage("[]")
					}
					finished = true
				}
				if finished {
					break
				}
			}
		}
	}
	return builtinJSON(map[string]any{"output": output, "wallMs": time.Since(startedAt).Milliseconds()})
}
