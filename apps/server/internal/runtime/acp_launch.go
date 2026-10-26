// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (h *handler) acpSpaceRunner(ctx context.Context, tenant, space string) (*runnerSession, *resolvedExecution, error) {
	computer, err := h.serverComputerRecord(ctx, tenant, space)
	if err != nil {
		return nil, nil, err
	}
	run, _ := ctx.Value(computerRunKey{}).(string)
	exec, err := h.resolveWorkspaceExecution(ctx, computer, run)
	if err != nil {
		return nil, nil, err
	}
	if exec.nodeID == "" {
		return nil, nil, errors.New("no runtime node bound to this space")
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, exec.nodeID); err != nil {
		return nil, nil, err
	}
	runner, err := h.hub.get(exec.nodeID)
	return runner, exec, err
}

func (h *handler) probeSpaceACPCommand(ctx context.Context, tenant, space, command string) (map[string]any, error) {
	runner, exec, err := h.acpSpaceRunner(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	if exec.workspace != nil {
		return h.workspaceInstanceExec(ctx, exec, "", 30000, command, "--version")
	}
	s, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	params := map[string]any{"spaceId": space, "command": []string{command, "--version"}, "workingDir": "/workspace"}
	method := "host.exec"
	if s.WorkspaceKind != "host" {
		obs, err := h.observeSpaceWorkspace(ctx, s)
		if err != nil {
			return nil, err
		}
		if obs.Container.DockerID == "" || obs.Container.Status != "running" {
			return nil, errors.New("workspace container is not running")
		}
		method = "docker.exec"
		params = map[string]any{"id": obs.Container.DockerID, "command": []string{command, "--version"}, "workingDir": "/workspace"}
	}
	result := map[string]any{}
	if err = runner.call(ctx, method, params, &result); err != nil {
		return result, err
	}
	if code, ok := result["exitCode"].(float64); ok && code != 0 {
		return result, fmt.Errorf("command exited %d", int(code))
	}
	return result, nil
}

func (h *handler) acpGatewayModels(ctx context.Context, tenant string) ([]acpGatewayModel, string, error) {
	inventory, err := h.gatewayModels(ctx, tenant)
	if err != nil {
		return nil, "", err
	}
	models := make([]acpGatewayModel, 0, len(inventory))
	preferred := ""
	for _, item := range inventory {
		metadata := item.Metadata
		model := acpGatewayModel{ID: item.ID, Name: item.Route.Name}
		model.ContextLimit = gwInt(metadata["contextLimit"])
		model.OutputLimit = gwInt(metadata["outputLimit"])
		if value, ok := metadata["reasoning"].(bool); ok {
			model.Reasoning = &value
		}
		if value, ok := metadata["toolCall"].(bool); ok {
			model.ToolCall = &value
		}
		if value, ok := metadata["attachment"].(bool); ok {
			model.Attachment = &value
		}
		models = append(models, model)
		if item.Route.IsDefault && preferred == "" {
			preferred = item.ID
		}
	}
	return models, preferred, nil
}

// prepareACPFiles stores per-profile HOME beneath the server computer workspace,
// which is bind-mounted into adapter containers. Login state survives sessions;
// no host root or Docker socket is exposed to the adapter.
func (h *handler) requirePrivateAtomicFS(ctx context.Context, runner *runnerSession) error {
	var info struct {
		Capabilities struct {
			PrivateAtomicFS bool `json:"privateAtomicFS"`
		} `json:"capabilities"`
	}
	if err := runner.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return err
	}
	if !info.Capabilities.PrivateAtomicFS {
		return errors.New("runtime node requires an update for secure credential writes")
	}
	return nil
}

func (h *handler) prepareACPFiles(ctx context.Context, runner *runnerSession, exec *resolvedExecution, profileID string, setup acpSetup, preferredModel string) (map[string]string, error) {
	home := "/workspace/.zakura/acp/" + profileID + "/home"
	var models []acpGatewayModel
	if setup.ModelProvider == "zakura" {
		var defaultModel string
		var err error
		models, defaultModel, err = h.acpGatewayModels(ctx, exec.computer.TenantID)
		if err != nil {
			return nil, fmt.Errorf("cannot load gateway model inventory: %w", err)
		}
		if preferredModel == "" {
			preferredModel = defaultModel
		}
	}
	files, env := acpRuntimeFiles(home, setup, models, preferredModel)
	if env == nil {
		env = map[string]string{}
	}
	oauthEnv, err := acpNativeOAuthEnv(setup)
	if err != nil {
		return nil, err
	}
	for key, value := range oauthEnv {
		env[key] = value
	}
	for key, value := range acpProfileStorageEnv(profileID, home) {
		env[key] = value
	}
	remote := h.executionRemote(runner, exec)
	// The managed disk must already exist; its pinned mkdir never allocates it.
	if err := remote.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": exec.spaceID, "path": "/"}, nil); err != nil {
		return nil, errors.New("cannot create ACP workspace root")
	}
	// Callers already hold the shared profile writer lease. Reconcile only
	// signed, fingerprint-matching generated files; never overwrite user OAuth.
	scope, _ := json.Marshal([]string{exec.computer.TenantID, exec.spaceID, profileID})
	fs := acpManagedFS{call: remote.callAny, space: exec.spaceID, home: home, scope: string(scope), secret: h.deps.Secret}
	if err := fs.reconcile(ctx, setup, files); err != nil {
		return nil, err
	}
	var result map[string]any
	if err := remote.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": exec.spaceID, "path": strings.TrimPrefix(home, "/workspace")}, &result); err != nil {
		return nil, err
	}
	return env, nil
}

func (h *handler) startACPContainer(ctx context.Context, runner *runnerSession, exec *resolvedExecution, sid, profileID, image, workingDir string, env map[string]string) (string, error) {
	identity, _ := json.Marshal([]string{exec.computer.TenantID, exec.spaceID, sid, profileID, h.store.id()})
	digest := sha256.Sum256(identity)
	name := "zakura-acp-" + hex.EncodeToString(digest[:16])
	var created acpSidecarContainer
	err := h.createWorkspaceSidecar(ctx, runner, exec, map[string]any{
		"name": name, "image": image, "stdinOpen": true, "restart": "no",
		"workingDir": workingDir, "env": env,
		"labels": map[string]string{"zakura.purpose": "acp-adapter", "zakura.tenant": exec.computer.TenantID, "zakura.space": exec.spaceID, "zakura.computer": exec.computer.ID, "zakura.session": sid},
	}, &created)
	if err != nil {
		return "", err
	}
	if created.DockerID == "" {
		return "", errors.New("runner returned no ACP adapter container id")
	}
	return created.DockerID, nil
}
