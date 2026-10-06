// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

type handler struct {
	deps        *appdeps.Dependencies
	store       *Store
	service     *Service
	hub         *runnerHub
	acp         *acpRuntimeManager
	mcpMu       sync.Mutex
	mcpSessions map[string]agentMCPSession
}

func RegisterRoutes(r chi.Router, deps *appdeps.Dependencies) {
	h := &handler{deps: deps, store: NewStore(deps), mcpSessions: map[string]agentMCPSession{}}
	h.hub = newRunnerHub(deps)
	h.service = NewService(h.store)
	h.acp = newACPRuntimeManager(h)
	h.migrateLegacyComponentConfigs(deps.RunContext())
	h.service.acpRunner = func(ctx context.Context, tenant, agent, session, runID, content string) error {
		runtime, err := h.acp.ensure(ctx, tenant, agent, session)
		if err != nil {
			return err
		}
		return runtime.prompt(ctx, runID, content)
	}
	deps.BeforeTenantDelete = h.beforeTenantDelete
	deps.AfterMemberRemoved = h.afterMemberRemoved
	h.service.toolRunner = func(ctx context.Context, tenant, agent, name string, args json.RawMessage) (json.RawMessage, error) {
		parts := strings.SplitN(name, ":", 2)
		if len(parts) != 2 {
			return nil, errors.New("qualified tool name must be instanceId:tool")
		}
		inst, e := h.getMCPInstance(ctx, tenant, parts[0])
		if e != nil {
			return nil, e
		}
		return h.mcpRPC(ctx, inst, "tools/call", map[string]any{"name": parts[1], "arguments": json.RawMessage(args)})
	}
	_, _ = h.store.RecoverRuns(deps.RunContext())
	r.Post("/api/routines/{id}/hook", h.routineHook)
	r.Get("/api/files/shared/{token}", h.downloadSharedFile)
	r.Get("/api/mcp/upstream-oauth/callback", h.mcpOAuthCallback)
	r.Post("/api/runtime-nodes/register", h.registerRuntimeNode)
	r.Handle("/api/runtime-nodes/hub", http.HandlerFunc(h.runnerHubHTTP))
	r.Post("/api/runtime-nodes/{id}/heartbeat", h.runtimeHeartbeat)
	r.Get("/api/runtime-nodes/{id}/install.sh", h.runtimeInstallSh)
	r.Get("/api/runtime-nodes/{id}/install.ps1", h.runtimeInstallPS)
	r.Get("/api/runtime-nodes/{id}/bootstrap.sh", h.runtimeBootstrapSh)
	r.Get("/api/otel/config", h.getOTelConfig)
	r.Post("/api/otel/v1/logs", h.ingestOTelLogs)
	r.Get("/api/zakurabot/ws", h.zakuraBotWS)
	r.Get("/api/agents/{id}/desktop-proxy", h.desktopProxy)
	r.Get("/api/agents/{id}/terminal-proxy", h.terminalProxy)
	r.Get("/api/runtime-nodes/agent-binaries/{os}/{arch}", h.runtimeAgentBinary)
	r.Handle("/api/socket.io", http.HandlerFunc(h.socketIO))
	r.Handle("/api/socket.io/", http.HandlerFunc(h.socketIO))
	r.Handle("/mcp", http.HandlerFunc(h.mcpEntry))
	r.Handle("/mcp/*", http.HandlerFunc(h.mcpEntry))
	r.Route("/api", func(api chi.Router) {
		api.Use(httpx.Auth(deps))
		api.Use(RequireAPIScope)
		h.registerCore(api)
		h.registerAutomation(api)
		h.registerInteractions(api)
		h.registerZakuraBotApp(api)
		h.registerSkills(api)
		h.registerMCP(api)
		h.registerWorkspace(api)
	})
	h.startScheduler(deps.RunContext())
	r.Group(func(g chi.Router) {
		g.Use(httpx.Auth(deps))
		g.Get("/v1/models", h.listGatewayModels)
		g.Post("/v1/responses", h.gateway("chat", "responses"))
		g.Post("/v1/chat/completions", h.gateway("chat", "chat"))
		g.Post("/v1/messages", h.gateway("chat", "messages"))
	})
}

func (h *handler) registerCore(r chi.Router) {
	r.Get("/spaces", h.listSpaces)
	r.Post("/spaces", h.createSpace)
	r.Get("/spaces/{id}", h.getSpace)
	r.Patch("/spaces/{id}", h.patchSpace)
	r.Delete("/spaces/{id}", h.deleteSpace)
	r.Get("/agents", h.listAgents)
	r.Post("/agents", h.createAgent)
	r.Get("/agents/{id}", h.getAgent)
	r.Patch("/agents/{id}", h.patchAgent)
	r.Delete("/agents/{id}", h.deleteAgent)
	r.Post("/agents/{id}/duplicate", h.duplicateAgent)
	r.Get("/cloud/search", h.searchSessions)
	r.Get("/agents/{id}/cloud/sessions", h.listSessions)
	r.Get("/agents/{id}/gateway/sessions", h.listSessions)
	r.Post("/agents/{id}/cloud/sessions", h.createSession)
	r.Get("/agents/{id}/cloud/sessions/{sid}", h.getSession)
	r.Patch("/agents/{id}/cloud/sessions/{sid}", h.patchSession)
	r.Delete("/agents/{id}/cloud/sessions/{sid}", h.deleteSession)
	r.Post("/agents/{id}/cloud/sessions/{sid}/messages", h.sendMessage)
	r.Post("/agents/{id}/cloud/sessions/{sid}/cancel", h.cancelRun)
	r.Post("/agents/{id}/cloud/sessions/{sid}/retry", h.retryRun)
	r.Post("/agents/{id}/cloud/sessions/{sid}/regenerate", h.retryRun)
	r.Post("/agents/{id}/cloud/sessions/{sid}/continue", h.continueRun)
	r.Post("/agents/{id}/cloud/sessions/{sid}/compact", h.compactSession)
	r.Post("/agents/{id}/cloud/sessions/{sid}/fork", h.forkSession)
	r.Get("/agents/{id}/cloud/sessions/{sid}/tools", h.sessionTools)
	r.Patch("/agents/{id}/cloud/sessions/{sid}/queue/{messageId}", h.patchQueue)
	r.Delete("/agents/{id}/cloud/sessions/{sid}/queue/{messageId}", h.deleteQueue)
	r.Post("/agents/{id}/cloud/sessions/{sid}/queue/{messageId}/interrupt", h.interruptQueue)
	r.Get("/agents/{id}/cloud/config", h.cloudConfig)
	r.Put("/agents/{id}/cloud/config", h.updateCloudConfig)
	r.Get("/agents/{id}/cloud/composer", h.composer)
	r.Get("/agents/{id}/memory", h.memoryOverview)
	r.Get("/agents/{id}/memory/items", h.listMemory)
	r.Get("/agents/{id}/memory/search", h.listMemory)
	r.Post("/agents/{id}/memory/items", h.createMemory)
	r.Patch("/agents/{id}/memory/items/{memId}", h.patchMemory)
	r.Delete("/agents/{id}/memory/items/{memId}", h.deleteMemory)
	r.Delete("/agents/{id}/memory", h.clearMemory)
	r.Get("/agents/{id}/memory/graph", h.memoryGraph)
	r.Post("/agents/{id}/memory/edges", h.createMemoryEdge)
	r.Delete("/agents/{id}/memory/edges/{edgeId}", h.deleteMemoryEdge)
	r.Post("/agents/{id}/memory/reembed", h.reembedMemory)
	r.Get("/agents/{id}/memory/embedding-stats", h.memoryEmbeddingStats)
	r.Get("/model-router/meta", h.modelMeta)
	r.Get("/model-upstreams", h.listUpstreams)
	r.Post("/model-upstreams", h.createUpstream)
	r.Get("/model-upstreams/{id}", h.getUpstream)
	r.Patch("/model-upstreams/{id}", h.patchUpstream)
	r.Delete("/model-upstreams/{id}", h.deleteUpstream)
	r.Post("/model-upstreams/{id}/health", h.healthUpstream)
	r.Get("/model-upstreams/{id}/models", h.modelsForUpstream)
	r.Post("/model-upstreams/{id}/sync-models", h.syncUpstreamModels)
	r.Post("/model-upstreams/batch-delete", h.batchDeleteUpstreams)
	r.Get("/upstream-models", h.listUpstreamModels)
	r.Post("/upstream-models", h.createUpstreamModel)
	r.Patch("/upstream-models/{id}", h.patchUpstreamModel)
	r.Delete("/upstream-models/{id}", h.deleteUpstreamModel)
	r.Post("/upstream-models/batch-delete", h.batchDeleteUpstreamModels)
	r.Get("/model-catalog/match", h.matchModelCatalog)
	r.Post("/model-catalog/refresh", h.refreshModelCatalog)
	r.Post("/model-catalog/import", h.importModelCatalog)
	r.Get("/model-routes", h.listModelRoutes)
	r.Post("/model-routes", h.createModelRoute)
	r.Get("/model-routes/{id}", h.getModelRoute)
	r.Patch("/model-routes/{id}", h.patchModelRoute)
	r.Delete("/model-routes/{id}", h.deleteModelRoute)
	r.Post("/model-router/chat", h.gateway("chat", "chat"))
	r.Post("/model-router/embed", h.gateway("embedding", "embeddings"))
	r.Post("/model-router/rerank", h.gateway("rerank", "rerank"))
	r.Post("/model-router/image", h.gateway("image", "images"))
	r.Get("/tool-calls", h.listToolCalls)
	r.Get("/tool-calls/stats", h.toolCallStats)
	r.Get("/tool-calls/{id}", h.getToolCall)
	r.Get("/agents/{id}/tool-calls", h.listToolCalls)
	r.Get("/agents/{id}/tool-calls/stats", h.toolCallStats)
	h.registerInstances(r)
	h.registerACP(r)
	h.registerNetwork(r)
	h.registerPlatformServices(r)
	h.registerMisc(r)
}
func principal(r *http.Request) httpx.Principal { p, _ := httpx.PrincipalFrom(r.Context()); return p }
func decodeMap(r *http.Request) (map[string]any, error) {
	var v map[string]any
	e := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20)).Decode(&v)
	return v, e
}
func statusErr(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, ErrNotFound):
		httpx.Error(w, 404, "Not found")
	case errors.Is(e, ErrConflict):
		httpx.Error(w, 409, "conflict")
	default:
		httpx.Error(w, 400, e.Error())
	}
}
func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

func object(v any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}
func (h *handler) spaceDTO(ctx context.Context, tenant string, x Space) map[string]any {
	out := object(x)
	var count int64
	_ = h.deps.Gorm.WithContext(ctx).Model(&models.Agent{}).Where("tenant_id=? AND space_id=?", tenant, x.ID).Count(&count).Error
	out["agentCount"] = count
	root := os.Getenv("ZAKURA_WORKSPACE_ROOT")
	if root == "" {
		root = filepath.Join("data", "workspaces")
	}
	out["workspaceRevision"] = nil
	out["lastMigrationId"] = nil
	out["workspaceHostPath"] = filepath.Join(root, tenant, x.ID)
	out["isDefault"] = x.Slug == "default"
	return out
}
func (h *handler) agentDTO(ctx context.Context, tenant string, a Agent) map[string]any {
	out := object(a)
	space, e := h.store.GetSpace(ctx, tenant, a.SpaceID)
	if e == nil {
		root := os.Getenv("ZAKURA_WORKSPACE_ROOT")
		if root == "" {
			root = filepath.Join("data", "workspaces")
		}
		needs := space.EnableComputer && space.WorkspaceKind == "container"
		status := space.WorkspaceStatus
		if status == "" {
			status = "none"
			if needs {
				status = "idle"
			}
		}
		var container struct {
			DockerID sql.NullString `gorm:"column:docker_id"`
			Image    sql.NullString `gorm:"column:image"`
			Status   sql.NullString `gorm:"column:status"`
		}
		if err := h.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("docker_id,image,status").Where("tenant_id=? AND space_id=? AND purpose='workspace'", tenant, space.ID).Order("created_at DESC").Take(&container).Error; err == nil {
			status = container.Status.String
		}
		out["spaceName"] = space.Name
		out["enableComputer"] = space.EnableComputer
		out["workspaceImage"] = space.WorkspaceImage
		out["runtimeNodeId"] = space.RuntimeNodeID
		out["workspaceKind"] = space.WorkspaceKind
		out["workspaceStatus"] = space.WorkspaceStatus
		out["workspaceRevision"] = nil
		out["lastMigrationId"] = nil
		out["workspaceHostPath"] = filepath.Join(root, tenant, space.ID)
		out["needsContainer"] = needs
		if space.EnableComputer {
			out["stackMode"] = "display"
		} else {
			out["stackMode"] = "none"
		}
		profile := "lite"
		if space.EnableComputer {
			profile = "full"
		}
		workspaceImage := any(space.WorkspaceImage)
		if container.Image.Valid {
			workspaceImage = container.Image.String
		}
		out["workspace"] = map[string]any{"status": status, "dockerId": nullableString(container.DockerID), "image": workspaceImage, "running": status == "running", "profile": profile}
	}
	out["mcpAgentUrl"] = strings.TrimRight(h.deps.PublicURL, "/") + "/mcp/agents/" + a.Slug
	return out
}
func (h *handler) createAgentAPIKey(ctx context.Context, p httpx.Principal, a Agent) (map[string]any, error) {
	secretBytes := make([]byte, 32)
	if _, e := rand.Read(secretBytes); e != nil {
		return nil, e
	}
	rawKey := "zak_" + base64.RawURLEncoding.EncodeToString(secretBytes)
	sum := sha256.Sum256([]byte(rawKey))
	prefix := rawKey
	if len(prefix) > 11 {
		prefix = prefix[:11]
	}
	id := h.store.id()
	name := "agent:" + a.Slug
	var user any = p.UserID
	if p.APIKey {
		user = nil
	}
	e := h.deps.Gorm.WithContext(ctx).Table("api_keys").Create(map[string]any{"id": id, "tenant_id": p.TenantID, "user_id": user, "agent_id": a.ID, "space_id": a.SpaceID, "name": name, "key_prefix": prefix, "key_hash": hex.EncodeToString(sum[:]), "scopes": `["*"]`, "expires_at": nil, "last_used_at": nil, "revoked_at": nil, "created_at": h.store.now()}).Error
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": id, "name": name, "keyPrefix": prefix, "rawKey": rawKey}, nil
}
func (h *handler) agentCreateResponse(ctx context.Context, p httpx.Principal, a Agent, withKey bool) (map[string]any, error) {
	out := h.agentDTO(ctx, p.TenantID, a)
	out["starting"] = false
	out["apiKey"] = nil
	if withKey {
		key, e := h.createAgentAPIKey(ctx, p, a)
		if e != nil {
			return nil, e
		}
		out["apiKey"] = key
	}
	return out, nil
}

func (h *handler) listSpaces(w http.ResponseWriter, r *http.Request) {
	x, e := h.store.ListSpaces(r.Context(), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	out := make([]map[string]any, 0, len(x))
	for _, space := range x {
		out = append(out, h.spaceDTO(r.Context(), principal(r).TenantID, space))
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) createSpace(w http.ResponseWriter, r *http.Request) {
	var in Space
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	x, e := h.store.CreateSpace(r.Context(), principal(r).TenantID, in)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, h.spaceDTO(r.Context(), principal(r).TenantID, x))
}
func (h *handler) getSpace(w http.ResponseWriter, r *http.Request) {
	x, e := h.store.GetSpace(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.spaceDTO(r.Context(), principal(r).TenantID, x))
}
func (h *handler) patchSpace(w http.ResponseWriter, r *http.Request) {
	p, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	x, e := h.store.UpdateSpace(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"), p)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.spaceDTO(r.Context(), principal(r).TenantID, x))
}
func (h *handler) deleteSpace(w http.ResponseWriter, r *http.Request) {
	e := h.store.DeleteSpace(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) listAgents(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, e := h.store.ListAgents(r.Context(), p.TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	spaceFilter := strings.TrimSpace(r.URL.Query().Get("spaceId"))
	out := make([]map[string]any, 0, len(x))
	for _, a := range x {
		if spaceFilter != "" && a.SpaceID != spaceFilter {
			continue
		}
		out = append(out, h.agentDTO(r.Context(), p.TenantID, a))
	}
	httpx.JSON(w, 200, out)
}
func (h *handler) createAgent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name             string          `json:"name"`
		SpaceID          string          `json:"spaceId"`
		Description      string          `json:"description"`
		Config           json.RawMessage `json:"config"`
		EnableMemory     *bool           `json:"enableMemory"`
		MemoryProviderID *string         `json:"memoryProviderId"`
		CreateAPIKey     *bool           `json:"createApiKey"`
		EnableComputer   *bool           `json:"enableComputer"`
		WorkspaceImage   *string         `json:"workspaceImage"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	if b.SpaceID == "" {
		spaces, e := h.store.ListSpaces(r.Context(), p.TenantID)
		if e != nil {
			statusErr(w, e)
			return
		}
		if len(spaces) == 0 {
			space, e := h.store.CreateSpace(r.Context(), p.TenantID, Space{Name: "Default", Slug: "default", EnableComputer: b.EnableComputer != nil && *b.EnableComputer, WorkspaceImage: b.WorkspaceImage, WorkspaceKind: "container", WorkspaceStatus: "ready"})
			if e != nil {
				statusErr(w, e)
				return
			}
			b.SpaceID = space.ID
		} else {
			b.SpaceID = spaces[0].ID
		}
	}
	enableMemory := true
	if b.EnableMemory != nil {
		enableMemory = *b.EnableMemory
	}
	x, e := h.store.CreateAgent(r.Context(), p.TenantID, Agent{Name: b.Name, SpaceID: b.SpaceID, Description: b.Description, Config: b.Config, EnableMemory: enableMemory, MemoryProviderID: b.MemoryProviderID})
	if e != nil {
		statusErr(w, e)
		return
	}
	withKey := true
	if b.CreateAPIKey != nil {
		withKey = *b.CreateAPIKey
	}
	out, e := h.agentCreateResponse(r.Context(), p, x, withKey)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, out)
}
func (h *handler) getAgent(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, e := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	out := h.agentDTO(r.Context(), p.TenantID, x)
	tools, resources, prompts, templates := h.agentMCPInventory(r.Context(), p.TenantID, x.ID)
	out["tools"] = tools
	out["resources"] = resources
	out["prompts"] = prompts
	out["resourceTemplates"] = templates
	var container struct {
		ID        string `gorm:"column:id"`
		DockerID  string `gorm:"column:docker_id"`
		Name      string `gorm:"column:name"`
		Image     string `gorm:"column:image"`
		Status    string `gorm:"column:status"`
		CreatedAt string `gorm:"column:created_at"`
		UpdatedAt string `gorm:"column:updated_at"`
	}
	if h.deps.Gorm.WithContext(r.Context()).Table("managed_containers").Select("id,COALESCE(docker_id,'') AS docker_id,name,image,status,created_at,updated_at").Where("tenant_id=? AND space_id=? AND purpose='workspace'", p.TenantID, x.SpaceID).Order("created_at DESC").Take(&container).Error == nil {
		out["workspaceContainer"] = map[string]any{"id": container.ID, "dockerId": container.DockerID, "name": container.Name, "image": container.Image, "status": container.Status, "createdAt": container.CreatedAt, "updatedAt": container.UpdatedAt}
	} else {
		out["workspaceContainer"] = nil
	}
	if space, err := h.store.GetSpace(r.Context(), p.TenantID, x.SpaceID); err == nil {
		supported := space.EnableComputer && space.WorkspaceKind != "host"
		out["desktop"] = map[string]any{"enabled": supported, "supported": supported, "computer": supported, "browser": supported, "display": func() any {
			if supported {
				return ":99"
			}
			return nil
		}(), "containerStatus": space.WorkspaceStatus, "dockerId": container.DockerID, "novncUrl": nil, "novncPort": nil, "cdpUrl": nil, "cdpPort": nil, "vncPort": nil, "width": 1280, "height": 720}
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *handler) agentMCPInventory(ctx context.Context, tenant, agentID string) ([]map[string]any, []map[string]any, []map[string]any, []map[string]any) {
	type bound struct {
		ID  string `gorm:"column:id"`
		Ref string `gorm:"column:component_ref"`
	}
	boundInstances := []bound{}
	_ = h.deps.Gorm.WithContext(ctx).Raw(`SELECT i.id AS id,i.component_ref AS component_ref FROM component_instances i JOIN agent_bindings b ON b.instance_id=i.id WHERE b.tenant_id=? AND b.agent_id=? AND i.component_type='mcp' AND i.status IN ('ready','running') ORDER BY i.name`, tenant, agentID).Scan(&boundInstances).Error
	tools := []map[string]any{}
	resources := []map[string]any{}
	prompts := []map[string]any{}
	templates := []map[string]any{}
	for _, item := range boundInstances {
		instance, err := h.getMCPInstance(ctx, tenant, item.ID)
		if err != nil {
			continue
		}
		call := func(method string, target any) {
			callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			if result, err := h.mcpRPC(callCtx, instance, method, map[string]any{}); err == nil {
				_ = json.Unmarshal(result, target)
			}
		}
		var listedTools struct {
			Tools []struct {
				Name, Description string
				InputSchema       map[string]any `json:"inputSchema"`
			} `json:"tools"`
		}
		call("tools/list", &listedTools)
		for _, tool := range listedTools.Tools {
			tools = append(tools, map[string]any{"name": "re_" + slugify(item.Ref) + "__" + tool.Name, "qualifiedName": "re_" + slugify(item.Ref) + "__" + tool.Name, "localName": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema, "providerId": item.Ref, "instanceId": item.ID, "agentScoped": true})
		}
		var listedResources struct {
			Resources []map[string]any `json:"resources"`
		}
		call("resources/list", &listedResources)
		for _, resource := range listedResources.Resources {
			resource["providerId"] = item.Ref
			resources = append(resources, resource)
		}
		var listedPrompts struct {
			Prompts []map[string]any `json:"prompts"`
		}
		call("prompts/list", &listedPrompts)
		for _, prompt := range listedPrompts.Prompts {
			prompt["providerId"] = item.Ref
			prompts = append(prompts, prompt)
		}
		var listedTemplates struct {
			ResourceTemplates []map[string]any `json:"resourceTemplates"`
		}
		call("resources/templates/list", &listedTemplates)
		for _, template := range listedTemplates.ResourceTemplates {
			template["providerId"] = item.Ref
			templates = append(templates, template)
		}
	}
	return tools, resources, prompts, templates
}
func (h *handler) patchAgent(w http.ResponseWriter, r *http.Request) {
	p, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	actor := principal(r)
	current, e := h.store.GetAgent(r.Context(), actor.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	spacePatch := map[string]any{}
	for _, key := range []string{"enableComputer", "workspaceImage", "runtimeNodeId", "workspaceKind"} {
		if v, ok := p[key]; ok {
			spacePatch[key] = v
			delete(p, key)
		}
	}
	delete(p, "restart")
	if len(spacePatch) > 0 {
		if _, e = h.store.UpdateSpace(r.Context(), actor.TenantID, current.SpaceID, spacePatch); e != nil {
			statusErr(w, e)
			return
		}
	}
	x, e := h.store.UpdateAgent(r.Context(), actor.TenantID, current.ID, p)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, h.agentDTO(r.Context(), actor.TenantID, x))
}
func (h *handler) deleteAgent(w http.ResponseWriter, r *http.Request) {
	e := h.store.DeleteAgent(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) duplicateAgent(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, e := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	a.ID = ""
	a.Name += " Copy"
	a.Slug = ""
	x, e := h.store.CreateAgent(r.Context(), p.TenantID, a)
	if e != nil {
		statusErr(w, e)
		return
	}
	out, e := h.agentCreateResponse(r.Context(), p, x, true)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, out)
}

func (h *handler) createSession(w http.ResponseWriter, r *http.Request) {
	var in Session
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	userID := p.UserID
	if p.APIKey {
		userID = ""
	}
	x, e := h.store.CreateSession(r.Context(), p.TenantID, userID, chi.URLParam(r, "id"), in)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, x)
}
func (h *handler) listSessions(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ks := strings.Split(strings.TrimSpace(r.URL.Query().Get("kinds")), ",")
	if len(ks) == 1 && (ks[0] == "" || ks[0] == "all") {
		ks = nil
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	x, e := h.store.ListSessions(r.Context(), p.TenantID, chi.URLParam(r, "id"), ks, limit, offset)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"sessions": x})
}
func (h *handler) getSession(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, sid := chi.URLParam(r, "id"), chi.URLParam(r, "sid")
	x, e := h.store.GetSession(r.Context(), p.TenantID, a, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("afterSeq"), 10, 64)
	events, e := h.store.ListEvents(r.Context(), p.TenantID, a, sid, after, 500)
	if e != nil {
		statusErr(w, e)
		return
	}
	queue, _ := h.store.PendingQueue(r.Context(), p.TenantID, a, sid)
	httpx.JSON(w, http.StatusOK, map[string]any{"session": x, "events": events, "hasMore": false, "hasMoreAfter": false, "queue": queue})
}
func (h *handler) patchSession(w http.ResponseWriter, r *http.Request) {
	m, e := decodeMap(r)
	if e != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	x, e := h.store.UpdateSession(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"), m)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, x)
}
func (h *handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	e := h.store.DeleteSession(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) searchSessions(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	x, e := h.store.SearchSessions(r.Context(), p.TenantID, r.URL.Query().Get("q"), limit)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"results": x})
}

type messageBody struct {
	Content      string          `json:"content"`
	Attachments  json.RawMessage `json:"attachments"`
	Options      json.RawMessage `json:"options"`
	FollowUpMode string          `json:"followUpMode"`
	FollowUp     string          `json:"followUp"`
	ParentRunID  *string         `json:"parentRunId"`
}

func (h *handler) sendMessage(w http.ResponseWriter, r *http.Request) {
	var b messageBody
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	mode := b.FollowUp
	if mode == "" {
		mode = b.FollowUpMode
	}
	run, q, e := h.service.StartTurn(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"), b.Content, b.Attachments, b.Options, mode != "interrupt")
	if e != nil {
		statusErr(w, e)
		return
	}
	if q != nil {
		httpx.JSON(w, 202, map[string]any{"queued": true, "messageId": q.ID, "mode": map[bool]string{true: "steer", false: "queue"}[mode == "steer"]})
		return
	}
	httpx.JSON(w, 202, map[string]any{"runId": run.ID})
}
func (h *handler) cancelRun(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	x, e := h.service.Cancel(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"))
	if e != nil {
		if errors.Is(e, ErrConflict) {
			httpx.JSON(w, 200, map[string]any{"ok": false, "runId": nil})
			return
		}
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "runId": x.ID})
}
func (h *handler) retryRun(w http.ResponseWriter, r *http.Request) {
	r.Body = http.NoBody
	h.startSynthetic(w, r, "Retry the previous request")
}
func (h *handler) continueRun(w http.ResponseWriter, r *http.Request) {
	h.startSynthetic(w, r, "Continue")
}
func (h *handler) startSynthetic(w http.ResponseWriter, r *http.Request, text string) {
	p := principal(r)
	run, _, e := h.service.StartTurn(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"), text, nil, nil, false)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 202, map[string]any{"runId": run.ID})
}
func (h *handler) patchQueue(w http.ResponseWriter, r *http.Request) {
	var b messageBody
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	x, e := h.store.UpdateQueued(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "sid"), chi.URLParam(r, "messageId"), QueueMessage{Content: b.Content, Attachments: b.Attachments, Options: b.Options})
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "item": x})
}
func (h *handler) deleteQueue(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, sid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "sid"), chi.URLParam(r, "messageId")
	items, e := h.store.PendingQueue(r.Context(), p.TenantID, a, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	var hit *QueueMessage
	for i := range items {
		if items[i].ID == mid {
			hit = &items[i]
			break
		}
	}
	if hit == nil {
		httpx.JSON(w, 200, map[string]any{"ok": true, "removed": false})
		return
	}
	if e = h.store.DeleteQueued(r.Context(), p.TenantID, a, sid, mid); e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "removed": true, "item": hit})
}
func (h *handler) interruptQueue(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	a, sid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "sid"), chi.URLParam(r, "messageId")
	items, e := h.store.PendingQueue(r.Context(), p.TenantID, a, sid)
	if e != nil {
		statusErr(w, e)
		return
	}
	var msg *QueueMessage
	for i := range items {
		if items[i].ID == mid {
			msg = &items[i]
		}
	}
	if msg == nil {
		statusErr(w, ErrNotFound)
		return
	}
	_, _ = h.service.Cancel(r.Context(), p.TenantID, a, sid)
	_ = h.store.DeleteQueued(r.Context(), p.TenantID, a, sid, mid)
	run, _, e := h.service.StartTurn(r.Context(), p.TenantID, a, sid, msg.Content, msg.Attachments, msg.Options, false)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "runId": run.ID})
}

func (h *handler) cloudConfig(w http.ResponseWriter, r *http.Request) {
	a, e := h.store.GetAgent(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	config := map[string]any{}
	_ = json.Unmarshal(a.Config, &config)
	cloud, _ := config["cloud"].(map[string]any)
	if cloud == nil {
		cloud = map[string]any{}
	}
	var routes int64
	_ = h.deps.Gorm.WithContext(r.Context()).Model(&models.ModelRoute{}).Where("tenant_id=? AND capability='chat' AND status='ready'", principal(r).TenantID).Count(&routes).Error
	httpx.JSON(w, 200, map[string]any{"cloud": cloud, "hasChatRoute": routes > 0})
}
func (h *handler) updateCloudConfig(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if json.NewDecoder(r.Body).Decode(&patch) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	a, e := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(a.Config, &cfg)
	cloud, _ := cfg["cloud"].(map[string]any)
	if cloud == nil {
		cloud = map[string]any{}
	}
	for k, v := range patch {
		if v == nil || v == "" {
			delete(cloud, k)
		} else {
			cloud[k] = v
		}
	}
	cfg["cloud"] = cloud
	a, e = h.store.UpdateAgent(r.Context(), p.TenantID, a.ID, map[string]any{"config": cfg})
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"cloud": cloud})
}
func (h *handler) composer(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, e := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	type skillRow struct {
		Name        string `gorm:"column:name"`
		Title       string `gorm:"column:title"`
		Description string `gorm:"column:description"`
	}
	var skillRows []skillRow
	if e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT s.name AS name,s.title AS title,s.description AS description FROM agent_skills a JOIN skills s ON s.id=a.skill_id WHERE a.tenant_id=? AND a.agent_id=? AND a.enabled=TRUE AND a.status<>'error' ORDER BY s.name`, p.TenantID, agent.ID).Scan(&skillRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	skills := []map[string]any{}
	for _, row := range skillRows {
		title := row.Title
		if strings.TrimSpace(title) == "" {
			title = row.Name
		}
		skills = append(skills, map[string]any{"name": row.Name, "title": title, "description": row.Description})
	}
	groups := []map[string]any{
		{"id": "builtin:sessions", "kind": "builtin", "label": "Sessions", "tools": []string{"list_sessions", "search_sessions", "get_messages", "import_session"}},
		{"id": "builtin:automation", "kind": "builtin", "label": "Routine", "tools": []string{"list_routines", "create_routine", "update_routine", "pause_routine", "delete_routine", "run_routine", "list_automation_runs"}},
		{"id": "builtin:ask-user", "kind": "builtin", "label": "Ask user", "tools": []string{"ask_user"}},
		{"id": "builtin:delegate", "kind": "builtin", "label": "Delegate agent", "tools": []string{"delegate_agent"}},
	}
	space, _ := h.store.GetSpace(r.Context(), p.TenantID, agent.SpaceID)
	if space.EnableComputer {
		groups = append(groups,
			map[string]any{"id": "builtin:computer", "kind": "builtin", "label": "Computer environment", "tools": []string{"fs_list", "fs_read", "fs_write", "shell_exec", "apply_patch"}},
			map[string]any{"id": "builtin:desktop", "kind": "builtin", "label": "Desktop control", "tools": []string{"computer_screenshot", "computer_click", "computer_type", "desktop_info"}},
			map[string]any{"id": "builtin:browser", "kind": "builtin", "label": "Browser", "tools": []string{"browser_open", "browser_click", "browser_type"}},
		)
	}
	if agent.EnableMemory {
		groups = append(groups, map[string]any{"id": "builtin:memory", "kind": "builtin", "label": "Memory", "tools": []string{"memory_search", "memory_remember"}})
	}
	connectorRefs := []string{}
	if e := h.deps.Gorm.WithContext(r.Context()).Model(&models.AgentConnectorInstallation{}).Where("tenant_id=? AND agent_id=? AND enabled=TRUE", p.TenantID, agent.ID).Order("connector_ref").Pluck("connector_ref", &connectorRefs).Error; e != nil {
		statusErr(w, e)
		return
	}
	for _, ref := range connectorRefs {
		var provider struct {
			ManifestJSON string `gorm:"column:manifest_json"`
		}
		if h.deps.Gorm.WithContext(r.Context()).Table("provider_catalog").Select("manifest_json").Where("id=? AND enabled=TRUE", ref).Take(&provider).Error == nil {
			var manifest struct {
				Tools []struct {
					Name string `json:"name"`
				} `json:"tools"`
			}
			_ = json.Unmarshal([]byte(provider.ManifestJSON), &manifest)
			tools := make([]string, 0, len(manifest.Tools))
			for _, tool := range manifest.Tools {
				if tool.Name != "" {
					tools = append(tools, "re_"+slugify(ref)+"__"+tool.Name)
				}
			}
			if len(tools) > 0 {
				groups = append(groups, map[string]any{"id": "connector:" + ref, "kind": "connector", "label": ref, "tools": tools})
			}
		}
	}
	type mcpSummary struct {
		ID   string `gorm:"column:id"`
		Name string `gorm:"column:name"`
		Ref  string `gorm:"column:component_ref"`
	}
	var mcpInstances []mcpSummary
	if e := h.deps.Gorm.WithContext(r.Context()).Raw(`SELECT i.id AS id,i.name AS name,i.component_ref AS component_ref FROM component_instances i JOIN agent_bindings b ON b.instance_id=i.id WHERE b.tenant_id=? AND b.agent_id=? AND i.component_type='mcp' AND i.status IN ('ready','running') ORDER BY i.name`, p.TenantID, agent.ID).Scan(&mcpInstances).Error; e != nil {
		statusErr(w, e)
		return
	}
	for _, summary := range mcpInstances {
		id, name, ref := summary.ID, summary.Name, summary.Ref
		instance, err := h.getMCPInstance(r.Context(), p.TenantID, id)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		result, err := h.mcpRPC(ctx, instance, "tools/list", map[string]any{})
		cancel()
		if err != nil {
			continue
		}
		var listed struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		_ = json.Unmarshal(result, &listed)
		tools := make([]string, 0, len(listed.Tools))
		for _, tool := range listed.Tools {
			if tool.Name != "" {
				tools = append(tools, "re_"+slugify(ref)+"__"+tool.Name)
			}
		}
		if len(tools) > 0 {
			groups = append(groups, map[string]any{"id": "mcp:" + id, "kind": "mcp", "label": name, "tools": tools})
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"skills": skills, "groups": groups})
}

func (h *handler) memoryOverview(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	agent, e := h.store.GetAgent(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	type providerRow struct {
		ID         string `gorm:"column:id"`
		Name       string `gorm:"column:name"`
		Kind       string `gorm:"column:kind"`
		ConfigJSON string `gorm:"column:config_json"`
		IsDefault  bool   `gorm:"column:is_default"`
		Status     string `gorm:"column:status"`
	}
	var providerRows []providerRow
	if e := h.deps.Gorm.WithContext(r.Context()).Table("memory_providers").Select("id,name,kind,config_json,is_default,status").Where("tenant_id=? AND enabled=TRUE", p.TenantID).Order("is_default DESC,name").Find(&providerRows).Error; e != nil {
		statusErr(w, e)
		return
	}
	providers := []map[string]any{}
	var resolved map[string]any
	for _, row := range providerRows {
		item := map[string]any{"id": row.ID, "name": row.Name, "kind": row.Kind, "isDefault": row.IsDefault, "status": row.Status, "meta": map[string]any{"name": row.Kind, "description": "", "storesLocally": row.Kind != "traditional"}}
		providers = append(providers, item)
		if (agent.MemoryProviderID != nil && *agent.MemoryProviderID == row.ID) || (agent.MemoryProviderID == nil && row.IsDefault) {
			cfg := map[string]any{}
			_ = json.Unmarshal([]byte(row.ConfigJSON), &cfg)
			resolved = map[string]any{"id": row.ID, "name": row.Name, "kind": row.Kind, "config": redactConfig(cfg), "storesLocally": row.Kind != "traditional"}
		}
	}
	byLayer := map[string]int{}
	var total, pinned int
	var statRows []struct {
		Layer       string `gorm:"column:layer"`
		Count       int    `gorm:"column:count"`
		PinnedCount int    `gorm:"column:pinned_count"`
	}
	if e := h.deps.Gorm.WithContext(r.Context()).Table("memories").Select("layer,COUNT(*) AS count,SUM(CASE WHEN pinned<>0 THEN 1 ELSE 0 END) AS pinned_count").Where("tenant_id=? AND agent_id=?", p.TenantID, agent.ID).Group("layer").Find(&statRows).Error; e == nil {
		for _, row := range statRows {
			byLayer[row.Layer], total, pinned = row.Count, total+row.Count, pinned+row.PinnedCount
		}
	}
	embeddingStats := h.memoryEmbeddingCounts(r.Context(), p.TenantID, agent.ID)
	embCfg, _ := h.agentEmbeddingConfig(r.Context(), p.TenantID, agent.ID)
	var embModel any
	if embCfg != nil {
		embModel = embCfg.Model
		if embCfg.RouteSlug != "" {
			embModel = embCfg.RouteSlug
		}
		if embCfg.RouteID != "" {
			embModel = embCfg.RouteID
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"enabled": agent.EnableMemory, "memoryProviderId": agent.MemoryProviderID, "provider": resolved, "providers": providers, "layers": []string{"identity", "preference", "project", "fact", "episode", "note"}, "stats": map[string]any{"total": total, "pinned": pinned, "byLayer": byLayer}, "embedding": map[string]any{"enabled": embCfg != nil, "model": embModel, "stats": embeddingStats}})
}
func (h *handler) listMemory(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, e := h.store.ListMemories(r.Context(), p.TenantID, chi.URLParam(r, "id"), r.URL.Query().Get("q"), r.URL.Query().Get("layer"), limit)
	if e != nil {
		statusErr(w, e)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/search") {
		httpx.JSON(w, http.StatusOK, map[string]any{"results": items})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "layers": []string{"identity", "preference", "project", "fact", "episode", "note"}})
}
func (h *handler) createMemory(w http.ResponseWriter, r *http.Request) {
	var in Memory
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	p := principal(r)
	x, e := h.store.CreateMemory(r.Context(), p.TenantID, chi.URLParam(r, "id"), in)
	if e != nil {
		statusErr(w, e)
		return
	}
	responseRaw, _ := json.Marshal(x)
	response := map[string]any{}
	_ = json.Unmarshal(responseRaw, &response)
	if cfg, cfgErr := h.agentEmbeddingConfig(r.Context(), p.TenantID, chi.URLParam(r, "id")); cfgErr == nil && cfg != nil {
		if vector, model, embedErr := h.embedMemoryText(r.Context(), p.TenantID, cfg, x.Content); embedErr != nil {
			response["embeddingWarning"] = embedErr.Error()
		} else if embedErr = h.setMemoryEmbedding(r.Context(), p.TenantID, chi.URLParam(r, "id"), x.ID, x.Content, vector, model); embedErr != nil {
			response["embeddingWarning"] = embedErr.Error()
		}
	}
	httpx.JSON(w, http.StatusCreated, response)
}
func (h *handler) deleteMemory(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	e := h.store.DeleteMemory(r.Context(), p.TenantID, chi.URLParam(r, "id"), chi.URLParam(r, "memId"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) clearMemory(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	n, e := h.store.ClearMemories(r.Context(), p.TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "deleted": n})
}

func (h *handler) modelMeta(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"protocols": []string{"openai", "anthropic", "openai-compatible"}, "capabilities": []string{"chat", "embedding", "rerank", "image"}})
}
func (h *handler) listUpstreams(w http.ResponseWriter, r *http.Request) {
	x, e := h.store.ListUpstreams(r.Context(), principal(r).TenantID)
	if e != nil {
		statusErr(w, e)
		return
	}
	for i := range x {
		x[i] = redactUpstream(x[i])
	}
	httpx.JSON(w, 200, map[string]any{"upstreams": x})
}
func (h *handler) createUpstream(w http.ResponseWriter, r *http.Request) {
	var in Upstream
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	x, e := h.store.CreateUpstream(r.Context(), principal(r).TenantID, in)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, redactUpstream(x))
}
func (h *handler) getUpstream(w http.ResponseWriter, r *http.Request) {
	x, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, redactUpstream(x))
}
func (h *handler) deleteUpstream(w http.ResponseWriter, r *http.Request) {
	e := h.store.DeleteUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) healthUpstream(w http.ResponseWriter, r *http.Request) {
	u, e := h.store.GetUpstream(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	var cfg upstreamConfig
	if json.Unmarshal(u.Config, &cfg) != nil || cfg.BaseURL == "" {
		httpx.Error(w, 400, "baseUrl not configured")
		return
	}
	target, e := safeProviderURL(cfg.BaseURL, "/v1/models")
	if e != nil {
		statusErr(w, e)
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	resp, e := h.service.gateway.client.Do(req)
	if e != nil {
		httpx.Error(w, 502, e.Error())
		return
	}
	resp.Body.Close()
	httpx.JSON(w, 200, map[string]any{"ok": resp.StatusCode < 500, "status": resp.StatusCode})
}
func (h *handler) listModelRoutes(w http.ResponseWriter, r *http.Request) {
	x, e := h.store.ListRoutes(r.Context(), principal(r).TenantID, r.URL.Query().Get("capability"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"routes": x, "capabilities": []string{"chat", "embedding", "rerank", "image"}})
}
func (h *handler) createModelRoute(w http.ResponseWriter, r *http.Request) {
	var in ModelRoute
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, 400, "invalid JSON")
		return
	}
	x, e := h.store.CreateRoute(r.Context(), principal(r).TenantID, in)
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 201, x)
}
func (h *handler) deleteModelRoute(w http.ResponseWriter, r *http.Request) {
	e := h.store.DeleteRoute(r.Context(), principal(r).TenantID, chi.URLParam(r, "id"))
	if e != nil {
		statusErr(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (h *handler) gateway(capability, operation string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gatewayPrincipalAllowed(principal(r)) {
			httpx.JSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"message": "API key is not bound to an agent or lacks Gateway permission", "type": "permission_error", "param": nil, "code": "insufficient_scope"}})
			return
		}
		var body []byte
		var v map[string]any
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&v) == nil {
			body, _ = json.Marshal(v)
		} else {
			httpx.Error(w, 400, "invalid JSON")
			return
		}
		model, _ := v["model"].(string)
		resp, e := h.service.gateway.Do(r.Context(), principal(r).TenantID, capability, operation, model, body)
		if e != nil {
			statusErr(w, e)
			return
		}
		_ = copyProviderResponse(w, resp)
	}
}
func (h *handler) listGatewayModels(w http.ResponseWriter, r *http.Request) {
	if !gatewayPrincipalAllowed(principal(r)) {
		httpx.JSON(w, http.StatusForbidden, map[string]any{"error": map[string]any{"message": "API key is not bound to an agent or lacks Gateway permission", "type": "permission_error", "param": nil, "code": "insufficient_scope"}})
		return
	}
	routes, e := h.store.ListRoutes(r.Context(), principal(r).TenantID, "")
	if e != nil {
		statusErr(w, e)
		return
	}
	data := make([]map[string]any, 0, len(routes))
	for _, x := range routes {
		id := x.Model
		if x.Alias != nil {
			id = *x.Alias
		}
		data = append(data, map[string]any{"id": id, "object": "model", "owned_by": "zakura"})
	}
	httpx.JSON(w, 200, map[string]any{"object": "list", "data": data})
}
