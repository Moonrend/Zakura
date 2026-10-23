// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type acpAdapter struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Command     string `json:"command"`
	Description string `json:"description"`
}

var acpRegistry = []acpAdapter{{ID: "codex", Name: "OpenAI Codex", Command: "codex", Description: "Codex ACP adapter"}, {ID: "claude-code", Name: "Claude Code", Command: "claude", Description: "Claude Code ACP adapter"}, {ID: "gemini-cli", Name: "Gemini CLI", Command: "gemini", Description: "Gemini CLI ACP adapter"}}

func (h *handler) registerACP(r chi.Router) {
	h.registerSpaceACP(r)
	r.Post("/spaces/{spaceId}/acp/agents/{profileId}/terminal-ticket", h.acpTerminalTicket)
	r.Get("/acp/registry", h.acpRegistry)
	r.Get("/agents/{id}/acp/adapters", h.acpAdapters)
	r.Post("/agents/{id}/acp/adapters/{registryId}/install", h.installACPAdapter)
	r.Delete("/agents/{id}/acp/adapters/{registryId}", h.deleteACPAdapter)
	r.Post("/agents/{id}/acp/adapters/gc", h.gcACPAdapters)
	r.Post("/agents/{id}/acp/adapters/{registryId}/adopt", h.adoptACPAdapter)
	r.Get("/agents/{id}/acp/config", h.getACPConfig)
	r.Put("/agents/{id}/acp/config", h.putACPConfig)
	r.Put("/agents/{id}/acp/agents/{profileId}", h.putACPProfile)
	r.Delete("/agents/{id}/acp/agents/{profileId}", h.deleteACPProfile)
	r.Post("/agents/{id}/acp/agents/{profileId}/probe", h.probeACPProfile)
	r.Post("/agents/{id}/acp/agents/{profileId}/install", h.installACPProfile)
	r.Get("/agents/{id}/acp/installs", h.acpInstalls)
	r.Post("/agents/{id}/acp/draft", h.acpDraft)
	r.Get("/agents/{id}/sessions/{sid}/acp-runtime", h.getACPRuntime)
	r.Post("/agents/{id}/sessions/{sid}/acp-runtime/reconnect", h.reconnectACPRuntime)
	r.Post("/agents/{id}/sessions/{sid}/acp-runtime/close", h.closeACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/mode", h.patchACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/model", h.patchACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/config", h.patchACPRuntime)
	r.Post("/agents/{id}/sessions/{sid}/acp/permission", h.resolveACPDecision)
	r.Post("/agents/{id}/sessions/{sid}/acp/elicitation", h.resolveACPDecision)
	r.Post("/agents/{id}/sessions/{sid}/acp/authenticate", h.acpAuthenticate)
	r.Post("/agents/{id}/sessions/{sid}/acp/terminal-ticket", h.acpTerminalAuthTicket)
	r.Post("/agents/{id}/sessions/{sid}/acp/logout", h.acpLogout)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/start", h.codexDeviceStart)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/poll", h.codexDevicePoll)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/cancel", h.codexDeviceCancel)
}
func (h *handler) acpRegistry(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{"adapters": acpCatalogOnce().Agents})
}
func (h *handler) agentConfig(ctx context.Context, tenant, agent string) (Agent, map[string]any, error) {
	a, e := h.store.GetAgent(ctx, tenant, agent)
	if e != nil {
		return a, nil, e
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(a.Config, &cfg)
	return a, cfg, nil
}
func (h *handler) saveAgentConfig(ctx context.Context, tenant string, a Agent, cfg map[string]any) error {
	return h.store.saveAgentConfigChanges(ctx, tenant, a, cfg)
}
func acpMap(cfg map[string]any) map[string]any {
	v, ok := cfg["acp"].(map[string]any)
	if !ok {
		v = map[string]any{}
		cfg["acp"] = v
	}
	return v
}
func (h *handler) acpAdapters(w http.ResponseWriter, r *http.Request) {
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	parsed := parseACPConfig(acpMap(cfg))
	items := []map[string]any{}
	runner, _, runnerErr := h.acpSpaceRunner(r.Context(), s.TenantID, s.ID)
	images := []string{}
	for _, adapter := range acpCatalogOnce().Agents {
		images = append(images, acpAdapterImage(adapter.ProfileID, parsed.Agents[adapter.ProfileID].PinnedVersion))
	}
	var imageState []struct {
		Image string `json:"image"`
		ID    string `json:"id"`
		Error string `json:"error"`
	}
	if runnerErr == nil {
		runnerErr = runner.call(r.Context(), "docker.images", map[string]any{"images": images}, &imageState)
	}
	readyImages := map[string]bool{}
	for _, state := range imageState {
		readyImages[state.Image] = state.ID != "" && state.Error == ""
	}
	for _, adapter := range acpCatalogOnce().Agents {
		setup := parsed.Agents[adapter.ProfileID]
		image := acpAdapterImage(adapter.ProfileID, setup.PinnedVersion)
		item := map[string]any{"id": adapter.ID, "profileId": adapter.ProfileID, "installed": []string{}, "latest": adapter.Version, "updateAvailable": setup.PinnedVersion != "" && setup.PinnedVersion != adapter.Version, "diskKb": map[string]int{}, "source": "container", "image": image, "pinnedVersion": nullString(setup.PinnedVersion)}
		if runnerErr != nil {
			item["checkError"] = runnerErr.Error()
		} else {
			ready := readyImages[image]
			item["imageReady"] = ready
			if ready {
				version := setup.PinnedVersion
				if version == "" {
					version = adapter.Version
				}
				item["installed"] = []string{version}
			}
		}
		items = append(items, item)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"adapters": items})
}

func findAdapter(id string) (acpAdapter, bool) {
	for _, a := range acpRegistry {
		if a.ID == id {
			return a, true
		}
	}
	return acpAdapter{}, false
}
func (h *handler) runtimeExec(ctx context.Context, tenant, agent, command string, args ...string) (map[string]any, error) {
	return h.runtimeExecWithMode(ctx, tenant, agent, "", command, args...)
}

func (h *handler) runtimeExecWithMode(ctx context.Context, tenant, agent, mode, command string, args ...string) (map[string]any, error) {
	return h.runtimeExecWithModeTimeout(ctx, tenant, agent, mode, 0, command, args...)
}

// Execution budget is independent of RPC observation and container cleanup.
func (h *handler) runtimeExecWithModeTimeout(ctx context.Context, tenant, agent, mode string, executionTimeoutMS int64, command string, args ...string) (map[string]any, error) {
	if mode != "" && mode != "host" && mode != "sandbox" {
		return nil, errors.New("execution_mode must be host or sandbox")
	}
	if exec := pinnedExecution(ctx); exec != nil && !exec.legacy {
		return h.computerContainerExec(ctx, exec, mode, executionTimeoutMS, command, args...)
	}
	var nodeID, spaceID, workspaceKind string
	var rec struct {
		NodeID        string `gorm:"column:node_id"`
		SpaceID       string `gorm:"column:space_id"`
		WorkspaceKind string `gorm:"column:workspace_kind"`
	}
	query := h.deps.Gorm.WithContext(ctx).Table("spaces s").Select("n.id AS node_id, s.id AS space_id, s.workspace_kind AS workspace_kind").Joins("JOIN runtime_nodes n ON n.id=s.runtime_node_id").Where("s.tenant_id=? AND n.status IN ('online','draining')", tenant)
	if exec := pinnedExecution(ctx); exec != nil && exec.legacy {
		query = query.Where("s.id=? AND n.id=?", exec.spaceID, exec.nodeID)
	} else {
		query = query.Joins("JOIN agents a ON a.space_id=s.id AND a.tenant_id=s.tenant_id").Where("a.id=?", agent)
	}
	err := query.Take(&rec).Error
	if err != nil {
		return nil, errors.New("workspace runtime node is not online")
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, rec.NodeID); err != nil {
		return nil, err
	}
	nodeID, spaceID, workspaceKind = rec.NodeID, rec.SpaceID, rec.WorkspaceKind
	if mode == "sandbox" && workspaceKind != "host" {
		return nil, errors.New("sandbox execution requires a host workspace; this workspace mode is unsupported")
	}
	session, err := h.hub.get(nodeID)
	if err != nil {
		return nil, err
	}
	if mode == "sandbox" || (workspaceKind == "host" && executionTimeoutMS > 0) {
		requested := mode == "sandbox"
		var policy struct {
			Enforced bool `json:"enforced"`
			Sandbox  struct {
				Enabled bool `json:"enabled"`
			} `json:"sandbox"`
		}
		policyErr := session.call(ctx, "sandbox.policy", map[string]any{}, &policy)
		if policyErr != nil {
			// Pre-policy runners explicitly reject the unknown method. A timeout,
			// disconnect or other error is not evidence that enforcement is off.
			legacyUnsupported := strings.Contains(policyErr.Error(), "未知方法: sandbox.policy") || strings.Contains(policyErr.Error(), "unknown method: sandbox.policy")
			if requested || !legacyUnsupported {
				return nil, errors.New("runner execution policy could not be confirmed")
			}
		} else if requested || policy.Enforced {
			if !policy.Sandbox.Enabled {
				return nil, errors.New("runner does not support sandbox execution; upgrade or configure the runner")
			}
			mode = "sandbox"
		}
	}
	argv := append([]string{command}, args...)
	timeoutMS := executionTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 30_000
	}
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline).Milliseconds(); remaining > 0 {
			if executionTimeoutMS <= 0 || remaining < timeoutMS {
				timeoutMS = remaining
			}
		} else {
			return nil, context.DeadlineExceeded
		}
	}
	if mode != "sandbox" && executionTimeoutMS > 0 {
		// Preserve legacy RPC deadline behavior; only verified restricted jobs
		// receive additional observation time for bounded terminal cleanup.
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
		defer cancel()
	}
	result := map[string]any{}
	if workspaceKind == "host" {
		params := map[string]any{"spaceId": spaceID, "command": argv, "workingDir": "/workspace", "timeoutMs": timeoutMS, "executionMode": mode}
		if mode == "sandbox" {
			result, err = runSandboxCommand(ctx, session, params)
		} else {
			err = session.call(ctx, "host.exec", params, &result)
		}
	} else {
		var containers []struct {
			DockerID string            `json:"dockerId"`
			Labels   map[string]string `json:"labels"`
		}
		if err = session.call(ctx, "docker.list", map[string]any{"label": "zakura.space=" + spaceID}, &containers); err == nil {
			var dockerID string
			for _, container := range containers {
				if container.Labels["zakura.purpose"] == "workspace" || (dockerID == "" && container.Labels["zakura.purpose"] == "") {
					dockerID = container.DockerID
				}
			}
			if dockerID == "" {
				return nil, errors.New("workspace container is not running")
			}
			err = session.call(ctx, "docker.exec", map[string]any{"id": dockerID, "command": argv, "workingDir": "/workspace"}, &result)
		}
	}
	if err != nil && result == nil {
		return nil, err
	}
	executionErr := err
	// Describe the transport that actually ran the command. A normal workspace
	// container provides container isolation but does not apply the restricted
	// sandbox policy (network, read-only mount, resource limits, and cleanup).
	if mode == "sandbox" && (result["executionMode"] != "sandbox" || result["isolated"] != true) {
		return nil, errors.New("runner did not confirm sandbox execution")
	}
	switch {
	case workspaceKind != "host":
		result["executionMode"] = "workspace-container"
		result["isolated"] = true
		result["restrictedPolicyApplied"] = false
	case result["executionMode"] == "sandbox":
		// Operator enforcement may select sandbox even for a legacy host call.
		if result["isolated"] != true {
			return nil, errors.New("runner did not confirm sandbox execution")
		}
		result["restrictedPolicyApplied"] = true
	default:
		result["executionMode"] = "host"
		result["isolated"] = false
		result["restrictedPolicyApplied"] = false
	}
	if executionErr != nil {
		return result, executionErr
	}
	if code, ok := result["exitCode"].(float64); ok && code != 0 {
		return result, fmt.Errorf("command exited %d: %v", int(code), result["stderr"])
	}
	return result, nil
}
func (h *handler) installACPAdapter(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "registryId")
	for _, adapter := range acpCatalogOnce().Agents {
		if adapter.ID == id {
			h.installACPProfileID(w, r, adapter.ProfileID)
			return
		}
	}
	statusErr(w, ErrNotFound)
}
func (h *handler) deleteACPAdapter(w http.ResponseWriter, r *http.Request) {
	// Deleting shared images can break other sessions. Clear the Space pin only;
	// image garbage collection remains the runner operator's responsibility.
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	_, err = h.mutateSpaceACP(r.Context(), s.TenantID, s.ID, acpMap(cfg), func(acp map[string]any) (map[string]any, error) {
		profileID := ""
		for _, adapter := range acpCatalogOnce().Agents {
			if adapter.ID == chi.URLParam(r, "registryId") {
				profileID = adapter.ProfileID
				break
			}
		}
		if profileID == "" {
			return nil, ErrNotFound
		}
		parsed := parseACPConfig(acp)
		if setup, exists := parsed.Agents[profileID]; exists {
			setup.PinnedVersion = ""
			parsed.Agents[profileID] = setup
		}
		return acpConfigJSON(parsed, acp), nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
func (h *handler) gcACPAdapters(w http.ResponseWriter, r *http.Request) {
	if _, _, err := h.requestACPSpace(r); err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"removed": []string{}})
}
func (h *handler) getACPConfig(w http.ResponseWriter, r *http.Request) {
	_, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, acpConfigResponse(acpMap(cfg)))
}
func acpProfiles(raw map[string]any) []acpPublicProfile {
	return acpCatalogForConfig(parseACPConfig(raw))
}
func (h *handler) putACPConfig(w http.ResponseWriter, r *http.Request) {
	var incoming map[string]any
	if httpx.DecodeJSON(r, &incoming) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	next, err := h.mutateSpaceACP(r.Context(), s.TenantID, s.ID, acpMap(cfg), func(previous map[string]any) (map[string]any, error) {
		return acpConfigJSON(mergeACPConfig(parseACPConfig(previous), parseACPConfig(incoming)), previous), nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	if err = h.acp.enforceApprovalPolicies(s.TenantID, "", s.ID); err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, acpConfigResponse(next))
}
func (h *handler) putACPProfile(w http.ResponseWriter, r *http.Request) {
	var profile map[string]any
	if httpx.DecodeJSON(r, &profile) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	id := chi.URLParam(r, "profileId")
	if !acpProfileIDPattern.MatchString(id) {
		httpx.Error(w, 400, "invalid profile id")
		return
	}
	var saved acpSetup
	_, err = h.mutateSpaceACP(r.Context(), s.TenantID, s.ID, acpMap(cfg), func(previous map[string]any) (map[string]any, error) {
		parsed := parseACPConfig(previous)
		// The legacy profile endpoint implies enabled unless explicitly disabled.
		one := acpConfig{Agents: map[string]acpSetup{id: parseACPSetup(id, profile, true)}}
		saved = mergeACPConfig(parsed, one).Agents[id]
		parsed.Agents[id] = saved
		return acpConfigJSON(parsed, previous), nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"profile": scrubACPConfig(acpConfig{Agents: map[string]acpSetup{id: saved}}).Agents[id]})
}
func (h *handler) deleteACPProfile(w http.ResponseWriter, r *http.Request) {
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	id := chi.URLParam(r, "profileId")
	_, err = h.mutateSpaceACP(r.Context(), s.TenantID, s.ID, acpMap(cfg), func(previous map[string]any) (map[string]any, error) {
		parsed := parseACPConfig(previous)
		if _, exists := parsed.Agents[id]; !exists {
			return nil, ErrNotFound
		}
		delete(parsed.Agents, id)
		if parsed.DefaultRuntime == id {
			parsed.DefaultRuntime = acpZakuraRuntimeID
		}
		return acpConfigJSON(parsed, previous), nil
	})
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
func (h *handler) acpProfile(ctx context.Context, tenant, agent, id string) (map[string]any, error) {
	_, cfg, err := h.acpSpace(ctx, tenant, agent, "")
	if err != nil {
		return nil, err
	}
	return acpRuntimeProfile(acpMap(cfg), id)
}
func (h *handler) probeACPProfile(w http.ResponseWriter, r *http.Request) {
	s, profile, err := h.requestACPProfile(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	command, _ := profile["command"].(string)
	if image, _ := profile["image"].(string); image != "" {
		runner, _, runErr := h.acpSpaceRunner(r.Context(), s.TenantID, s.ID)
		var images []struct {
			Image string `json:"image"`
			ID    string `json:"id"`
			Error string `json:"error"`
		}
		if runErr == nil {
			runErr = runner.call(r.Context(), "docker.images", map[string]any{"images": []string{image}}, &images)
		}
		ready := false
		for _, state := range images {
			if state.Image == image && state.ID != "" && state.Error == "" {
				ready = true
			}
		}
		output := image
		if runErr != nil {
			output = runErr.Error()
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"installed": runErr == nil && ready, "command": command, "output": output})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := h.probeSpaceACPCommand(ctx, s.TenantID, s.ID, command)
	output := ""
	if result != nil {
		output = fmt.Sprint(result["stdout"])
	}
	var failure any
	if err != nil {
		failure = err.Error()
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"installed": err == nil, "command": command, "output": output, "error": failure})
}

func acpInstallCommand(profileID, version string) (string, []string, error) {
	packageName := map[string]string{
		"codex":       "@openai/codex",
		"claude-code": "@anthropic-ai/claude-code",
		"gemini-cli":  "@google/gemini-cli",
	}[profileID]
	if packageName == "" {
		return "", nil, errors.New("ACP profile has no trusted installation specification")
	}
	if version != "" {
		packageName += "@" + version
	}
	return "npm", []string{"install", "--global", "--no-audit", "--no-fund", packageName}, nil
}

func (h *handler) saveACPInstall(ctx context.Context, tenant, space, profile string, install map[string]any) error {
	_, err := h.mutateSpaceACP(ctx, tenant, space, nil, func(acp map[string]any) (map[string]any, error) {
		installs, _ := acp["installs"].(map[string]any)
		if installs == nil {
			installs = map[string]any{}
		}
		installs[profile] = install
		acp["installs"] = installs
		return acp, nil
	})
	return err
}

func (h *handler) listACPInstallState(ctx context.Context, tenant, space string) ([]map[string]any, error) {
	_, cfg, err := h.acpSpace(ctx, tenant, "", space)
	if err != nil {
		return nil, err
	}
	installs, _ := acpMap(cfg)["installs"].(map[string]any)
	out := []map[string]any{}
	for profile, raw := range installs {
		item, _ := raw.(map[string]any)
		copy := map[string]any{"profileId": profile}
		for key, value := range item {
			copy[key] = value
		}
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["profileId"]) < fmt.Sprint(out[j]["profileId"]) })
	return out, nil
}

func (h *handler) installACPProfile(w http.ResponseWriter, r *http.Request) {
	h.installACPProfileID(w, r, chi.URLParam(r, "profileId"))
}
func (h *handler) installACPProfileID(w http.ResponseWriter, r *http.Request, profile string) {
	s, cfg, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	adapter, exists := acpRegistryAgentFor(profile)
	if !exists {
		httpx.Error(w, http.StatusBadRequest, "ACP profile has no trusted installation specification")
		return
	}
	setup := parseACPConfig(acpMap(cfg)).Agents[profile]
	version := strings.TrimSpace(r.URL.Query().Get("version"))
	if version == "" {
		version = setup.PinnedVersion
	}
	image := acpAdapterImage(profile, version)
	runner, exec, err := h.acpSpaceRunner(r.Context(), s.TenantID, s.ID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	now := h.store.now()
	install := map[string]any{"profileId": profile, "registryId": adapter.ID, "computerId": exec.computer.ID, "image": image, "state": "queued", "percent": nil, "downloadedBytes": 0, "totalBytes": 0, "message": "Queued", "startedAt": now, "updatedAt": now, "finishedAt": nil, "output": nil, "error": nil, "version": nullString(version)}
	if err = h.saveACPInstall(r.Context(), s.TenantID, s.ID, profile, install); err != nil {
		statusErr(w, err)
		return
	}
	progress := map[string]any{}
	for key, value := range install {
		progress[key] = value
	}
	go func() {
		ctx, cancel := context.WithTimeout(h.deps.RunContext(), 10*time.Minute)
		defer cancel()
		progress["state"], progress["message"], progress["updatedAt"] = "pulling", "Pulling adapter image", h.store.now()
		_ = h.saveACPInstall(ctx, s.TenantID, s.ID, profile, progress)
		var result map[string]any
		runErr := runner.call(ctx, "docker.pull", map[string]any{"image": image}, &result)
		progress["percent"], progress["updatedAt"], progress["finishedAt"] = 100, h.store.now(), h.store.now()
		if runErr != nil {
			progress["state"], progress["message"], progress["error"] = "failed", runErr.Error(), runErr.Error()
		} else {
			progress["state"], progress["message"], progress["output"], progress["error"] = "completed", "Adapter image ready", image, nil
		}
		_ = h.saveACPInstall(context.WithoutCancel(ctx), s.TenantID, s.ID, profile, progress)
	}()
	httpx.JSON(w, http.StatusAccepted, map[string]any{"ok": true, "accepted": true, "install": install})
}
func (h *handler) acpInstalls(w http.ResponseWriter, r *http.Request) {
	s, _, err := h.requestACPSpace(r)
	if err != nil {
		statusErr(w, err)
		return
	}
	installs, err := h.listACPInstallState(r.Context(), s.TenantID, s.ID)
	if err != nil {
		statusErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"installs": installs})
}
func (h *handler) acpDraft(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var b struct {
		Title, ProfileID, Model string
		Project                 *string `json:"project"`
	}
	_ = httpx.DecodeJSON(r, &b)
	if b.ProfileID == "" {
		httpx.Error(w, http.StatusBadRequest, "profileId required")
		return
	}
	profile, err := h.acpProfile(r.Context(), p.TenantID, chi.URLParam(r, "id"), b.ProfileID)
	if err != nil {
		statusErr(w, err)
		return
	}
	if b.Title == "" {
		display, _ := profile["displayName"].(string)
		if display == "" {
			display = b.ProfileID
		}
		b.Title = "ACP · " + display
	}
	origin, _ := json.Marshal(map[string]any{"runtime": "acp", "acpProfileId": b.ProfileID})
	model := &b.Model
	if b.Model == "" {
		model = nil
	}
	user := p.UserID
	if p.APIKey {
		user = ""
	}
	sess, e := h.store.CreateSession(r.Context(), p.TenantID, user, chi.URLParam(r, "id"), Session{Title: b.Title, Kind: "acp", Origin: origin, Model: model, Project: b.Project})
	if e != nil {
		statusErr(w, e)
		return
	}
	runtime := map[string]any{"runtimeId": "", "sessionId": sess.ID, "profileId": b.ProfileID, "state": "starting"}
	go func() {
		ctx, cancel := context.WithTimeout(httpx.WithPrincipal(h.deps.RunContext(), p), 45*time.Second)
		defer cancel()
		if _, startErr := h.acp.ensure(ctx, p.TenantID, sess.AgentID, sess.ID); startErr != nil {
			_, _ = h.store.AppendEvent(context.WithoutCancel(ctx), p.TenantID, sess.AgentID, sess.ID, "acp.runtime.updated", nil, map[string]any{"runtimeId": "", "sessionId": sess.ID, "profileId": b.ProfileID, "state": "error", "error": startErr.Error()})
		}
	}()
	httpx.JSON(w, http.StatusCreated, map[string]any{"session": sess, "runtime": runtime})
}
func (h *handler) getACPRuntime(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	state, err := h.acp.snapshot(r.Context(), p.TenantID, agent, sid)
	if err != nil {
		statusErr(w, err)
		return
	}
	if state != nil {
		httpx.JSON(w, http.StatusOK, state)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	live, err := h.acp.ensure(ctx, p.TenantID, agent, sid)
	if err != nil {
		// A failed startup is still a readable runtime state. Preserve its cause
		// instead of reporting a status-query failure or starting it again on GET.
		if state, snapshotErr := h.acp.snapshot(r.Context(), p.TenantID, agent, sid); snapshotErr == nil && state != nil {
			httpx.JSON(w, http.StatusOK, state)
			return
		}
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, live.snapshot())
}
func (h *handler) patchACPRuntime(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	var patch map[string]any
	if httpx.DecodeJSON(r, &patch) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	live, e := h.acp.ensure(r.Context(), p.TenantID, agent, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	if e = live.patch(r.Context(), patch); e != nil {
		httpx.Error(w, http.StatusConflict, e.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, live.snapshot())
}
func (h *handler) resolveACPDecision(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	var body map[string]any
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	live, e := h.acp.ensure(r.Context(), p.TenantID, agent, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	permission := strings.Contains(r.URL.Path, "/permission")
	if e = live.resolveDecision(body, permission); e != nil {
		httpx.Error(w, http.StatusConflict, e.Error())
		return
	}
	ev, e := h.store.AppendEvent(r.Context(), p.TenantID, agent, sid, "acp.decision", nil, body)
	if e != nil {
		statusErr(w, e)
		return
	}
	resolvedType := "permission_resolved"
	if !permission {
		resolvedType = "elicitation_resolved"
	}
	_, _ = h.store.AppendEvent(r.Context(), p.TenantID, agent, sid, resolvedType, nil, body)
	httpx.JSON(w, 200, map[string]any{"ok": true, "event": ev})
}
func (h *handler) acpAuthenticate(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if p.APIKey && p.AgentID != "" {
		httpx.Error(w, http.StatusNotFound, "resource not found")
		return
	}
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, "", agent); err != nil {
		statusErr(w, err)
		return
	}
	var body struct {
		MethodID string `json:"methodId"`
	}
	if httpx.DecodeJSON(r, &body) != nil || strings.TrimSpace(body.MethodID) == "" {
		httpx.Error(w, http.StatusBadRequest, "ACP authentication methodId required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	live, err := h.acp.ensure(ctx, p.TenantID, agent, sid)
	if err != nil {
		statusErr(w, err)
		return
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, p.TenantID, live.spaceID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	defer lease.release()
	exec, err := resolveACPHost(ctx, h, p.TenantID, agent, sid)
	if err != nil || exec.spaceID != live.spaceID || exec.computer.ID != live.computerID || exec.nodeID != live.runner.nodeID {
		httpx.Error(w, http.StatusConflict, "ACP authentication target changed")
		return
	}
	if err = httpx.AuthorizeResource(ctx, h.deps, p, exec.spaceID, ""); err != nil {
		statusErr(w, err)
		return
	}
	token := h.store.id()
	if err = h.acquireACPAuthLock(ctx, p.TenantID, exec.spaceID, live.profileID, "protocol", token, 3*time.Minute, exec); err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	if err = lease.bindSharedProfile(ctx, live.profileID); err != nil {
		_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, exec.spaceID, live.profileID, token)
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	retain := false
	defer func() {
		if !retain {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = h.releaseACPAuthLock(cleanupCtx, p.TenantID, exec.spaceID, live.profileID, token)
		}
	}()
	live.mu.Lock()
	valid, active := false, live.currentRunID != ""
	methods, _ := live.state["authMethods"].([]any)
	for _, raw := range methods {
		method, _ := raw.(map[string]any)
		kind, _ := method["type"].(string)
		if method["id"] == body.MethodID && (kind == "" || kind == "agent") {
			valid = true
		}
	}
	live.mu.Unlock()
	if !valid || active {
		httpx.Error(w, http.StatusConflict, "unsupported ACP authentication method or active session")
		return
	}
	if err = lease.check(ctx); err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	if err = live.authenticate(ctx, body.MethodID); err != nil {
		// An RPC error or cancellation is not proof that shared HOME was untouched.
		retain = true
		_ = lease.uncertain(err)
		httpx.Error(w, http.StatusConflict, "ACP authentication outcome unknown; reconcile profile authentication: "+err.Error())
		return
	}
	if err = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, exec.spaceID, live.profileID, token); err != nil {
		retain = true
		_ = lease.uncertain(err)
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, live.snapshot())
}
func (h *handler) acpLogout(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	if p.APIKey && p.AgentID != "" {
		httpx.Error(w, http.StatusNotFound, "resource not found")
		return
	}
	if err := httpx.AuthorizeResource(r.Context(), h.deps, p, "", agent); err != nil {
		statusErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	live, err := h.acp.ensure(ctx, p.TenantID, agent, sid)
	if err != nil {
		statusErr(w, err)
		return
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, p.TenantID, live.spaceID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	defer lease.release()
	exec, err := resolveACPHost(ctx, h, p.TenantID, agent, sid)
	if err != nil || exec.spaceID != live.spaceID || exec.computer.ID != live.computerID || exec.nodeID != live.runner.nodeID {
		httpx.Error(w, http.StatusConflict, "ACP logout target changed")
		return
	}
	if err = httpx.AuthorizeResource(ctx, h.deps, p, exec.spaceID, ""); err != nil {
		statusErr(w, err)
		return
	}
	token := h.store.id()
	if err = h.acquireACPAuthLock(ctx, p.TenantID, exec.spaceID, live.profileID, "protocol", token, time.Minute, exec); err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	if err = lease.bindSharedProfile(ctx, live.profileID); err != nil {
		_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, exec.spaceID, live.profileID, token)
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	retain := false
	defer func() {
		if !retain {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = h.releaseACPAuthLock(cleanupCtx, p.TenantID, exec.spaceID, live.profileID, token)
		}
	}()
	live.mu.Lock()
	supported, active := live.state["logoutSupported"] == true, live.currentRunID != ""
	live.mu.Unlock()
	if !supported || active {
		httpx.Error(w, http.StatusConflict, "ACP logout unsupported or session active")
		return
	}
	if err = lease.check(ctx); err != nil {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	if err = live.logout(ctx); err != nil {
		retain = true
		_ = lease.uncertain(err)
		httpx.Error(w, http.StatusConflict, "ACP logout outcome unknown; reconcile profile authentication: "+err.Error())
		return
	}
	if err = h.releaseACPAuthLock(context.WithoutCancel(ctx), p.TenantID, exec.spaceID, live.profileID, token); err != nil {
		retain = true
		_ = lease.uncertain(err)
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, live.snapshot())
}
