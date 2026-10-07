// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
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
var devicePolls sync.Map

func (h *handler) registerACP(r chi.Router) {
	r.Get("/acp/registry", h.acpRegistry)
	r.Get("/agents/{id}/acp/adapters", h.acpAdapters)
	r.Post("/agents/{id}/acp/adapters/{registryId}/install", h.installACPAdapter)
	r.Delete("/agents/{id}/acp/adapters/{registryId}", h.deleteACPAdapter)
	r.Post("/agents/{id}/acp/adapters/gc", h.gcACPAdapters)
	r.Post("/agents/{id}/acp/adapters/{registryId}/adopt", h.installACPAdapter)
	r.Get("/agents/{id}/acp/config", h.getACPConfig)
	r.Put("/agents/{id}/acp/config", h.putACPConfig)
	r.Put("/agents/{id}/acp/agents/{profileId}", h.putACPProfile)
	r.Delete("/agents/{id}/acp/agents/{profileId}", h.deleteACPProfile)
	r.Post("/agents/{id}/acp/agents/{profileId}/probe", h.probeACPProfile)
	r.Post("/agents/{id}/acp/agents/{profileId}/install", h.installACPProfile)
	r.Get("/agents/{id}/acp/installs", h.acpInstalls)
	r.Post("/agents/{id}/acp/draft", h.acpDraft)
	r.Get("/agents/{id}/sessions/{sid}/acp-runtime", h.getACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/mode", h.patchACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/model", h.patchACPRuntime)
	r.Patch("/agents/{id}/sessions/{sid}/acp-runtime/config", h.patchACPRuntime)
	r.Post("/agents/{id}/sessions/{sid}/acp/permission", h.resolveACPDecision)
	r.Post("/agents/{id}/sessions/{sid}/acp/elicitation", h.resolveACPDecision)
	r.Post("/agents/{id}/sessions/{sid}/acp/authenticate", h.acpAuthenticate)
	r.Post("/agents/{id}/sessions/{sid}/acp/logout", h.acpLogout)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/start", h.deviceStart)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/poll", h.devicePoll)
	r.Post("/agents/{id}/acp/agents/{profileId}/oauth/device/cancel", h.deviceCancel)
}
func (h *handler) acpRegistry(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"adapters": acpRegistry})
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
	_, cfg, e := h.agentConfig(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	a := acpMap(cfg)
	installed, _ := a["adapters"].(map[string]any)
	if installed == nil {
		installed = map[string]any{}
	}
	items := []map[string]any{}
	for _, adapter := range acpRegistry {
		versions := []string{}
		if raw, ok := installed[adapter.ID].(map[string]any); ok {
			if version := strings.TrimSpace(fmt.Sprint(raw["version"])); version != "" && version != "<nil>" {
				versions = append(versions, version)
			}
		}
		items = append(items, map[string]any{"id": adapter.ID, "profileId": adapter.ID, "installed": versions, "latest": nil, "updateAvailable": false, "diskKb": map[string]int{}, "source": "workspace"})
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
	var nodeID, spaceID, workspaceKind string
	var rec struct {
		NodeID        string `gorm:"column:node_id"`
		SpaceID       string `gorm:"column:space_id"`
		WorkspaceKind string `gorm:"column:workspace_kind"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("agents AS a").Select("n.id AS node_id, s.id AS space_id, s.workspace_kind AS workspace_kind").Joins("JOIN spaces s ON s.id=a.space_id").Joins("JOIN runtime_nodes n ON n.id=s.runtime_node_id").Where("a.tenant_id=? AND a.id=? AND n.status IN ('online','draining')", tenant, agent).Take(&rec).Error
	if err != nil {
		return nil, errors.New("agent runtime node is not online")
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
	p := principal(r)
	id := chi.URLParam(r, "registryId")
	adapter, ok := findAdapter(id)
	if !ok {
		httpx.Error(w, 404, "Adapter not found")
		return
	}
	result, e := h.runtimeExec(r.Context(), p.TenantID, chi.URLParam(r, "id"), adapter.Command, "--version")
	if e != nil {
		httpx.Error(w, 409, e.Error())
		return
	}
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	installed, _ := acp["adapters"].(map[string]any)
	if installed == nil {
		installed = map[string]any{}
	}
	installed[id] = map[string]any{"id": id, "command": adapter.Command, "installedAt": h.store.now(), "version": result["stdout"]}
	acp["adapters"] = installed
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, map[string]any{"adapter": installed[id]})
}
func (h *handler) deleteACPAdapter(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	installed, _ := acp["adapters"].(map[string]any)
	id := chi.URLParam(r, "registryId")
	if _, ok := installed[id]; !ok {
		statusErr(w, ErrNotFound)
		return
	}
	delete(installed, id)
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) gcACPAdapters(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	installed, _ := acp["adapters"].(map[string]any)
	removed := []string{}
	for id, raw := range installed {
		v, _ := raw.(map[string]any)
		cmd, _ := v["command"].(string)
		if cmd == "" {
			if adapter, ok := findAdapter(id); ok {
				cmd = adapter.Command
			}
		}
		if _, e := h.runtimeExec(r.Context(), p.TenantID, a.ID, cmd, "--version"); e != nil {
			delete(installed, id)
			removed = append(removed, id)
		}
	}
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"removed": removed})
}
func (h *handler) getACPConfig(w http.ResponseWriter, r *http.Request) {
	_, cfg, e := h.agentConfig(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	httpx.JSON(w, http.StatusOK, map[string]any{"config": acp, "profiles": acpProfiles(acp)})
}
func acpProfiles(acp map[string]any) []map[string]any {
	profiles := []map[string]any{}
	configured, _ := acp["profiles"].(map[string]any)
	if configured == nil {
		configured, _ = acp["agents"].(map[string]any)
	}
	for id, raw := range configured {
		profile, _ := raw.(map[string]any)
		copy := map[string]any{"id": id, "name": id}
		for key, value := range profile {
			copy[key] = value
		}
		profiles = append(profiles, copy)
	}
	return profiles
}
func (h *handler) putACPConfig(w http.ResponseWriter, r *http.Request) {
	var acp map[string]any
	if httpx.DecodeJSON(r, &acp) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg["acp"] = acp
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": acp, "profiles": acpProfiles(acp)})
}
func (h *handler) putACPProfile(w http.ResponseWriter, r *http.Request) {
	var profile map[string]any
	if httpx.DecodeJSON(r, &profile) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	profiles, _ := acp["profiles"].(map[string]any)
	if profiles == nil {
		profiles = map[string]any{}
	}
	profiles[chi.URLParam(r, "profileId")] = profile
	acp["profiles"] = profiles
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"profile": profile})
}
func (h *handler) deleteACPProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, cfg, e := h.agentConfig(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	acp := acpMap(cfg)
	profiles, _ := acp["profiles"].(map[string]any)
	id := chi.URLParam(r, "profileId")
	if _, ok := profiles[id]; !ok {
		statusErr(w, ErrNotFound)
		return
	}
	delete(profiles, id)
	e = h.saveAgentConfig(r.Context(), p.TenantID, a, cfg)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) acpProfile(ctx context.Context, tenant, agent, id string) (map[string]any, error) {
	_, cfg, e := h.agentConfig(ctx, tenant, agent)
	if e != nil {
		return nil, e
	}
	profiles, _ := acpMap(cfg)["profiles"].(map[string]any)
	profile, _ := profiles[id].(map[string]any)
	if profile == nil {
		return nil, ErrNotFound
	}
	return profile, nil
}
func (h *handler) probeACPProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	profile, e := h.acpProfile(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "profileId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	command, _ := profile["command"].(string)
	if command == "" {
		httpx.Error(w, 400, "profile command required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, e := h.runtimeExec(ctx, p.TenantID, chi.URLParam(r, "id"), command, "--version")
	output := ""
	if result != nil {
		output = fmt.Sprint(result["stdout"])
	}
	httpx.JSON(w, 200, map[string]any{"installed": e == nil, "command": command, "output": output, "error": func() any {
		if e != nil {
			return e.Error()
		}
		return nil
	}()})
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

func (h *handler) saveACPInstall(ctx context.Context, tenant, agent, profile string, install map[string]any) error {
	a, cfg, err := h.agentConfig(ctx, tenant, agent)
	if err != nil {
		return err
	}
	acp := acpMap(cfg)
	installs, _ := acp["installs"].(map[string]any)
	if installs == nil {
		installs = map[string]any{}
	}
	installs[profile] = install
	acp["installs"] = installs
	return h.saveAgentConfig(ctx, tenant, a, cfg)
}

func (h *handler) listACPInstallState(ctx context.Context, tenant, agent string) ([]map[string]any, error) {
	_, cfg, err := h.agentConfig(ctx, tenant, agent)
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
	p := principal(r)
	profile := chi.URLParam(r, "profileId")
	adapter, exists := findAdapter(profile)
	if !exists {
		httpx.Error(w, http.StatusBadRequest, "ACP profile has no trusted installation specification")
		return
	}
	version := strings.TrimSpace(r.URL.Query().Get("version"))
	command, args, err := acpInstallCommand(profile, version)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := h.store.now()
	agentID := chi.URLParam(r, "id")
	install := map[string]any{"profileId": profile, "state": "queued", "percent": 0, "downloadedBytes": 0, "totalBytes": 0, "message": "Queued", "startedAt": now, "updatedAt": now, "finishedAt": nil, "output": nil, "error": nil, "version": nullString(version)}
	if err = h.saveACPInstall(r.Context(), p.TenantID, agentID, profile, install); err != nil {
		statusErr(w, err)
		return
	}
	progress := map[string]any{}
	for key, value := range install {
		progress[key] = value
	}
	go func() {
		ctx, cancel := context.WithTimeout(h.deps.RunContext(), 5*time.Minute)
		defer cancel()
		progress["state"], progress["percent"], progress["message"], progress["updatedAt"] = "running", 10, "Installing", h.store.now()
		_ = h.saveACPInstall(ctx, p.TenantID, agentID, profile, progress)
		result, runErr := h.runtimeExec(ctx, p.TenantID, agentID, command, args...)
		if runErr == nil {
			result, runErr = h.runtimeExec(ctx, p.TenantID, agentID, adapter.Command, "--version")
		}
		progress["percent"], progress["updatedAt"], progress["finishedAt"] = 100, h.store.now(), h.store.now()
		if runErr != nil {
			progress["state"], progress["message"], progress["error"] = "failed", runErr.Error(), runErr.Error()
		} else {
			progress["state"], progress["message"], progress["output"], progress["error"] = "completed", "Installed", result["stdout"], nil
		}
		_ = h.saveACPInstall(context.WithoutCancel(ctx), p.TenantID, agentID, profile, progress)
	}()
	httpx.JSON(w, http.StatusAccepted, map[string]any{"ok": true, "accepted": true, "install": install})
}
func (h *handler) acpInstalls(w http.ResponseWriter, r *http.Request) {
	installs, err := h.listACPInstallState(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
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
		ctx, cancel := context.WithTimeout(h.deps.RunContext(), 45*time.Second)
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
	sess, e := h.store.GetSession(r.Context(), p.TenantID, agent, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	if sess.Kind == "acp" {
		ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
		defer cancel()
		if live, startErr := h.acp.ensure(ctx, p.TenantID, agent, sid); startErr == nil {
			httpx.JSON(w, http.StatusOK, live.snapshot())
			return
		}
	}
	events, e := h.store.ListEvents(r.Context(), p.TenantID, agent, sid, 0, 1000)
	if e != nil {
		statusErr(w, e)
		return
	}
	state := map[string]any{"runtimeId": sid, "sessionId": sid, "profileId": "", "state": "closed", "models": map[string]any{"currentId": sess.Model, "available": []any{}}, "modes": map[string]any{"currentId": "default", "available": []any{}}, "config": map[string]any{}}
	for _, ev := range events {
		if ev.Type == "acp.runtime.updated" {
			_ = json.Unmarshal(ev.Payload, &state)
		}
	}
	httpx.JSON(w, http.StatusOK, state)
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
func (h *handler) runACPCommand(w http.ResponseWriter, r *http.Request, arg string) {
	p := principal(r)
	sess, e := h.store.GetSession(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		statusErr(w, e)
		return
	}
	var origin struct {
		ProfileID string `json:"acpProfileId"`
	}
	_ = json.Unmarshal(sess.Origin, &origin)
	profile, e := h.acpProfile(r.Context(), p.TenantID, sess.AgentID, origin.ProfileID)
	if e != nil {
		statusErr(w, e)
		return
	}
	command, _ := profile["command"].(string)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	result, e := h.runtimeExec(ctx, p.TenantID, sess.AgentID, command, arg)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "output": result["stdout"]})
}
func (h *handler) acpAuthenticate(w http.ResponseWriter, r *http.Request) {
	h.runACPCommand(w, r, "login")
}
func (h *handler) acpLogout(w http.ResponseWriter, r *http.Request) { h.runACPCommand(w, r, "logout") }
func (h *handler) deviceStart(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	profile, e := h.acpProfile(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "profileId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	deviceURL, _ := profile["deviceAuthorizationUrl"].(string)
	clientID, _ := profile["clientId"].(string)
	if deviceURL == "" || clientID == "" {
		httpx.Error(w, 400, "deviceAuthorizationUrl and clientId required")
		return
	}
	form := url.Values{"client_id": []string{clientID}}
	if scope, _ := profile["scope"].(string); scope != "" {
		form.Set("scope", scope)
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, deviceURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpx.Error(w, 502, string(raw))
		return
	}
	var result any
	if json.Unmarshal(raw, &result) != nil {
		httpx.Error(w, 502, "invalid device response")
		return
	}
	httpx.JSON(w, 200, map[string]any{"device": result})
}
func (h *handler) devicePoll(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	profile, e := h.acpProfile(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "profileId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	var b struct {
		DeviceCode string `json:"deviceCode"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.DeviceCode == "" {
		httpx.Error(w, 400, "deviceCode required")
		return
	}
	tokenURL, _ := profile["tokenUrl"].(string)
	clientID, _ := profile["clientId"].(string)
	if tokenURL == "" || clientID == "" {
		httpx.Error(w, 400, "tokenUrl and clientId required")
		return
	}
	key := p.TenantID + ":" + chi.URLParam(r, "id") + ":" + chi.URLParam(r, "profileId")
	ctx, cancel := context.WithCancel(r.Context())
	devicePolls.Store(key, cancel)
	defer devicePolls.Delete(key)
	form := url.Values{"client_id": []string{clientID}, "device_code": []string{b.DeviceCode}, "grant_type": []string{"urn:ietf:params:oauth:grant-type:device_code"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, bytes.NewBufferString(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		if errors.Is(e, context.Canceled) {
			httpx.Error(w, 409, "poll cancelled")
			return
		}
		httpx.Error(w, 502, e.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var result any
	_ = json.Unmarshal(raw, &result)
	httpx.JSON(w, resp.StatusCode, map[string]any{"token": result})
}
func (h *handler) deviceCancel(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	key := p.TenantID + ":" + chi.URLParam(r, "id") + ":" + chi.URLParam(r, "profileId")
	v, ok := devicePolls.Load(key)
	if !ok {
		httpx.Error(w, 404, "no active device poll")
		return
	}
	v.(context.CancelFunc)()
	httpx.JSON(w, 200, map[string]any{"cancelled": true})
}
