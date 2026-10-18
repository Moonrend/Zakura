// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// acp_catalog.json is generated from @zakura/shared by
// scripts/gen-acp-catalog.mjs. It carries the builtin profile catalog shown by
// the ACP settings page and the Moonrend/acp-registry index whose images run
// each builtin adapter as PID 1.
//
//go:embed acp_catalog.json
var acpCatalogJSON []byte

type acpManagedField struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Type        string `json:"type"`
	Required    bool   `json:"required,omitempty"`
	Sensitive   bool   `json:"sensitive,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Help        string `json:"help,omitempty"`
}

type acpPublicProfile struct {
	ID                  string            `json:"id"`
	DisplayName         string            `json:"displayName"`
	Description         string            `json:"description"`
	Managed             bool              `json:"managed"`
	Preinstalled        bool              `json:"preinstalled,omitempty"`
	Command             string            `json:"command"`
	Args                []string          `json:"args"`
	SetupModes          []string          `json:"setupModes"`
	ManagedFields       []acpManagedField `json:"managedFields"`
	InstallHint         string            `json:"installHint,omitempty"`
	SessionModeID       string            `json:"sessionModeId,omitempty"`
	ForceHTTPMcp        bool              `json:"forceHttpMcp,omitempty"`
	SupportsZakuraRoute bool              `json:"supportsZakuraRoute,omitempty"`
}

type acpRegistryAgent struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	ProfileID string `json:"profileId"`
	Image     string `json:"image"`
	Storage   struct {
		Env       map[string]string `json:"env"`
		Artifacts []struct {
			Durable string `json:"durable"`
			Runtime string `json:"runtime"`
		} `json:"artifacts"`
	} `json:"storage"`
	Auth struct {
		Modes        []string          `json:"modes"`
		APIKeyEnv    []string          `json:"apiKeyEnv"`
		NoBrowserEnv map[string]string `json:"noBrowserEnv"`
	} `json:"auth"`
	Integration struct {
		ZakuraRoute  bool              `json:"zakuraRoute"`
		Env          map[string]string `json:"env"`
		ModelPrefix  string            `json:"modelPrefix"`
		Dotenv       map[string]string `json:"dotenv"`
		RuntimeFiles map[string]string `json:"runtimeFiles"`
	} `json:"integration"`
}

type acpCatalogIndex struct {
	ImagePrefix string             `json:"imagePrefix"`
	Profiles    []acpPublicProfile `json:"profiles"`
	Agents      []acpRegistryAgent `json:"agents"`
}

var acpCatalogOnce = sync.OnceValue(func() acpCatalogIndex {
	var index acpCatalogIndex
	if err := json.Unmarshal(acpCatalogJSON, &index); err != nil {
		panic(fmt.Sprintf("acp_catalog.json: %v", err))
	}
	return index
})

func acpBuiltinProfile(id string) (acpPublicProfile, bool) {
	for _, profile := range acpCatalogOnce().Profiles {
		if profile.ID == id {
			return cloneACPProfile(profile), true
		}
	}
	return acpPublicProfile{}, false
}

func acpRegistryAgentFor(profileID string) (acpRegistryAgent, bool) {
	for _, agent := range acpCatalogOnce().Agents {
		if agent.ProfileID == profileID {
			return agent, true
		}
	}
	return acpRegistryAgent{}, false
}

// acpAdapterImage is the registry image whose PID 1 is the adapter. A pinned
// version is honoured only for an agent the index still knows.
func acpAdapterImage(profileID, pinnedVersion string) string {
	agent, ok := acpRegistryAgentFor(profileID)
	if !ok {
		return ""
	}
	if pinned := strings.TrimSpace(pinnedVersion); pinned != "" {
		return acpCatalogOnce().ImagePrefix + "/" + agent.ID + ":" + pinned
	}
	return agent.Image
}

func cloneACPProfile(p acpPublicProfile) acpPublicProfile {
	p.Args = append([]string{}, p.Args...)
	p.SetupModes = append([]string{}, p.SetupModes...)
	p.ManagedFields = append([]acpManagedField{}, p.ManagedFields...)
	return p
}

const acpZakuraRuntimeID = "zakura"

var acpProfileIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,47}$`)

type acpGrant struct {
	Kind       string `json:"kind"`
	PathPrefix string `json:"pathPrefix,omitempty"`
}

type acpSetup struct {
	ID            string            `json:"id"`
	Enabled       bool              `json:"enabled"`
	SetupMode     string            `json:"setupMode"`
	DisplayName   string            `json:"displayName,omitempty"`
	Command       string            `json:"command,omitempty"`
	Args          []string          `json:"args,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	Managed       map[string]string `json:"managed"`
	ModelProvider string            `json:"modelProvider"`
	PinnedVersion string            `json:"pinnedVersion,omitempty"`
}

type acpConfig struct {
	PermissionPolicy string              `json:"permissionPolicy"`
	PermissionGrants []acpGrant          `json:"permissionGrants"`
	DefaultRuntime   string              `json:"defaultRuntime"`
	Agents           map[string]acpSetup `json:"agents"`
}

func acpStrings(value any, limit int) []string {
	list, _ := value.([]any)
	out := []string{}
	for _, item := range list {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func acpStringMap(value any) map[string]string {
	object, _ := value.(map[string]any)
	out := map[string]string{}
	for key, item := range object {
		if text, ok := item.(string); ok {
			out[key] = text
		}
	}
	return out
}

func parseACPSetup(id string, raw map[string]any, legacyProfile bool) acpSetup {
	if raw == nil {
		raw = map[string]any{}
	}
	setup := acpSetup{ID: strings.ToLower(strings.TrimSpace(id)), Managed: acpStringMap(raw["managed"])}
	enabled, _ := raw["enabled"].(bool)
	// Profiles saved by the first Go server had no enabled flag at all; they
	// only existed because a user configured them.
	if _, explicit := raw["enabled"]; legacyProfile && !explicit {
		enabled = true
	}
	setup.Enabled = enabled
	switch mode, _ := raw["setupMode"].(string); mode {
	case "self", "oauth":
		setup.SetupMode = mode
	default:
		setup.SetupMode = "api_key"
	}
	setup.DisplayName, _ = raw["displayName"].(string)
	setup.DisplayName = strings.TrimSpace(setup.DisplayName)
	setup.Command, _ = raw["command"].(string)
	setup.Command = strings.TrimSpace(setup.Command)
	if args := acpStrings(raw["args"], 32); len(args) > 0 {
		setup.Args = args
	}
	if env := acpStringMap(raw["env"]); len(env) > 0 {
		setup.Env = env
	}
	setup.PinnedVersion, _ = raw["pinnedVersion"].(string)
	setup.PinnedVersion = strings.TrimSpace(setup.PinnedVersion)
	switch provider, _ := raw["modelProvider"].(string); provider {
	case "zakura", "native":
		setup.ModelProvider = provider
	default:
		// Older settings persisted only the zakura_* credentials.
		if strings.TrimSpace(setup.Managed["zakura_api_key"]) != "" || strings.TrimSpace(setup.Managed["zakura_base_url"]) != "" {
			setup.ModelProvider = "zakura"
		} else {
			setup.ModelProvider = "native"
		}
	}
	return setup
}

// parseACPConfig normalizes the persisted agent.config.acp object. The legacy
// "profiles" map written by the first Go server is folded into agents so
// existing sessions keep resolving their profile.
func parseACPConfig(raw map[string]any) acpConfig {
	cfg := acpConfig{PermissionPolicy: "ask", PermissionGrants: []acpGrant{}, DefaultRuntime: acpZakuraRuntimeID, Agents: map[string]acpSetup{}}
	if raw == nil {
		return cfg
	}
	if policy, _ := raw["permissionPolicy"].(string); policy == "allow" {
		cfg.PermissionPolicy = "allow"
	}
	if grants, ok := raw["permissionGrants"].([]any); ok {
		for _, item := range grants {
			rec, _ := item.(map[string]any)
			kind, _ := rec["kind"].(string)
			if strings.TrimSpace(kind) == "" {
				continue
			}
			prefix, _ := rec["pathPrefix"].(string)
			cfg.PermissionGrants = append(cfg.PermissionGrants, acpGrant{Kind: strings.TrimSpace(kind), PathPrefix: strings.ReplaceAll(strings.TrimSpace(prefix), `\`, "/")})
			if len(cfg.PermissionGrants) >= 200 {
				break
			}
		}
	}
	if runtimeID, _ := raw["defaultRuntime"].(string); runtimeID != "" {
		runtimeID = strings.ToLower(strings.TrimSpace(runtimeID))
		if runtimeID == acpZakuraRuntimeID || acpProfileIDPattern.MatchString(runtimeID) {
			cfg.DefaultRuntime = runtimeID
		}
	}
	add := func(source any, legacy bool) {
		entries, _ := source.(map[string]any)
		for rawID, value := range entries {
			id := strings.ToLower(strings.TrimSpace(rawID))
			if !acpProfileIDPattern.MatchString(id) {
				continue
			}
			if _, exists := cfg.Agents[id]; exists {
				continue
			}
			rec, _ := value.(map[string]any)
			cfg.Agents[id] = parseACPSetup(id, rec, legacy)
		}
	}
	add(raw["agents"], false)
	add(raw["profiles"], true)
	return cfg
}

// acpConfigJSON is the persisted form. Bookkeeping keys owned by other
// handlers (install progress, adapter versions) are carried over unchanged.
func acpConfigJSON(cfg acpConfig, previous map[string]any) map[string]any {
	agents := map[string]any{}
	for id, setup := range cfg.Agents {
		row := map[string]any{"enabled": setup.Enabled, "setupMode": setup.SetupMode, "managed": setup.Managed, "modelProvider": setup.ModelProvider}
		if setup.ModelProvider == "" {
			row["modelProvider"] = "native"
		}
		if setup.DisplayName != "" {
			row["displayName"] = setup.DisplayName
		}
		if setup.Command != "" {
			row["command"] = setup.Command
		}
		if len(setup.Args) > 0 {
			row["args"] = setup.Args
		}
		if len(setup.Env) > 0 {
			row["env"] = setup.Env
		}
		if setup.PinnedVersion != "" {
			row["pinnedVersion"] = setup.PinnedVersion
		}
		agents[id] = row
	}
	out := map[string]any{"permissionPolicy": cfg.PermissionPolicy, "defaultRuntime": cfg.DefaultRuntime, "agents": agents}
	if len(cfg.PermissionGrants) > 0 {
		out["permissionGrants"] = cfg.PermissionGrants
	}
	for _, key := range []string{"installs", "adapters"} {
		if value, ok := previous[key]; ok {
			out[key] = value
		}
	}
	return out
}

func acpProfileForSetup(setup acpSetup) acpPublicProfile {
	if builtin, ok := acpBuiltinProfile(setup.ID); ok {
		if setup.Command != "" {
			builtin.Command = setup.Command
		}
		if len(setup.Args) > 0 {
			builtin.Args = append([]string{}, setup.Args...)
		}
		return builtin
	}
	name := setup.DisplayName
	if name == "" {
		name = setup.ID
	}
	return acpPublicProfile{ID: setup.ID, DisplayName: name, Description: "自定义 ACP Agent", Command: setup.Command, Args: append([]string{}, setup.Args...), SetupModes: []string{"api_key", "oauth", "self"}, ManagedFields: []acpManagedField{{ID: "api_key", Label: "API key", Type: "password", Sensitive: true}}}
}

func acpCatalogForConfig(cfg acpConfig) []acpPublicProfile {
	byID := map[string]acpPublicProfile{}
	for _, profile := range acpCatalogOnce().Profiles {
		byID[profile.ID] = cloneACPProfile(profile)
	}
	for id, setup := range cfg.Agents {
		byID[id] = acpProfileForSetup(setup)
	}
	out := make([]acpPublicProfile, 0, len(byID))
	for _, profile := range byID {
		out = append(out, profile)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

var acpSensitiveKey = regexp.MustCompile(`(?i)key|token|secret|password|auth`)

func acpSensitiveFields(profile acpPublicProfile) map[string]bool {
	out := map[string]bool{}
	for _, field := range profile.ManagedFields {
		if field.Sensitive || field.Type == "password" {
			out[field.ID] = true
		}
	}
	return out
}

func maskACPSecret(value string) string {
	v := strings.TrimSpace(value)
	switch {
	case v == "":
		return ""
	case strings.HasPrefix(v, "sk-") && len(v) > 8:
		return "sk-…" + v[len(v)-4:]
	case len(v) > 4:
		return "***" + v[len(v)-4:]
	default:
		return "***"
	}
}

func isMaskedACPSecret(value string) bool {
	return strings.HasPrefix(value, "***") || strings.HasPrefix(strings.TrimSpace(value), "sk-…")
}

func scrubACPConfig(cfg acpConfig) acpConfig {
	out := acpConfig{PermissionPolicy: cfg.PermissionPolicy, PermissionGrants: cfg.PermissionGrants, DefaultRuntime: cfg.DefaultRuntime, Agents: map[string]acpSetup{}}
	for id, setup := range cfg.Agents {
		sensitive := acpSensitiveFields(acpProfileForSetup(setup))
		managed := map[string]string{}
		for key, value := range setup.Managed {
			if sensitive[key] || acpSensitiveKey.MatchString(key) {
				managed[key] = maskACPSecret(value)
			} else {
				managed[key] = value
			}
		}
		setup.Managed = managed
		env := map[string]string{}
		for key, value := range setup.Env {
			if acpSensitiveKey.MatchString(key) {
				env[key] = maskACPSecret(value)
			} else {
				env[key] = value
			}
		}
		setup.Env = env
		out.Agents[id] = setup
	}
	return out
}

// mergeACPConfig keeps stored secrets when the client echoes back a masked,
// empty or missing value for a sensitive field.
func mergeACPConfig(existing, incoming acpConfig) acpConfig {
	out := acpConfig{PermissionPolicy: incoming.PermissionPolicy, PermissionGrants: incoming.PermissionGrants, DefaultRuntime: incoming.DefaultRuntime, Agents: map[string]acpSetup{}}
	if out.DefaultRuntime == "" {
		out.DefaultRuntime = existing.DefaultRuntime
	}
	for id, next := range incoming.Agents {
		managed := map[string]string{}
		for key, value := range next.Managed {
			managed[key] = value
		}
		if prev, ok := existing.Agents[id]; ok {
			env := map[string]string{}
			for key, value := range next.Env {
				env[key] = value
			}
			for key, value := range prev.Env {
				if acpSensitiveKey.MatchString(key) && (env[key] == "" || isMaskedACPSecret(env[key])) {
					env[key] = value
				}
			}
			next.Env = env
			sensitive := acpSensitiveFields(acpProfileForSetup(next))
			for key, prevValue := range prev.Managed {
				if !sensitive[key] && !acpSensitiveKey.MatchString(key) {
					continue
				}
				if value, present := next.Managed[key]; !present || value == "" || isMaskedACPSecret(value) {
					managed[key] = prevValue
				}
			}
		}
		next.Managed = managed
		out.Agents[id] = next
	}
	return out
}

func missingRequiredACPField(profile acpPublicProfile, setup acpSetup) *acpManagedField {
	if setup.ModelProvider == "zakura" && profile.SupportsZakuraRoute {
		return nil
	}
	if setup.SetupMode == "self" {
		return nil
	}
	if setup.SetupMode == "oauth" {
		if profile.ID == "claude-code" && strings.TrimSpace(setup.Managed["oauth_token"]) == "" {
			for _, field := range profile.ManagedFields {
				if field.ID == "oauth_token" {
					return &field
				}
			}
			return &acpManagedField{ID: "oauth_token", Label: "Claude setup-token", Type: "password", Sensitive: true}
		}
		return nil
	}
	for _, field := range profile.ManagedFields {
		if !field.Required || field.ID == "oauth_token" {
			continue
		}
		if strings.TrimSpace(setup.Managed[field.ID]) == "" {
			return &field
		}
	}
	return nil
}

type acpLaunch struct {
	Command string
	Args    []string
	Env     map[string]string
}

// resolveACPLaunch mirrors resolveAcpLaunch in @zakura/shared: each CLI reads
// its credentials, base URL and model from different variables.
func resolveACPLaunch(profile acpPublicProfile, setup acpSetup) acpLaunch {
	command := strings.TrimSpace(setup.Command)
	if command == "" {
		command = profile.Command
	}
	args := append([]string{}, profile.Args...)
	if len(setup.Args) > 0 {
		args = append([]string{}, setup.Args...)
	}
	env := map[string]string{}
	for key, value := range setup.Env {
		env[key] = value
	}
	managed := func(key string) string { return strings.TrimSpace(setup.Managed[key]) }
	key, baseURL, model, oauthToken := managed("api_key"), managed("base_url"), managed("model"), managed("oauth_token")
	id := profile.ID
	if setup.ModelProvider == "zakura" {
		applyACPZakuraRouteEnv(env, id, managed("zakura_api_key"), managed("zakura_base_url"))
		if model != "" {
			applyACPModelEnv(env, id, model)
			env["ZAKURA_MODEL"] = model
		}
	}
	if setup.SetupMode == "oauth" && id == "claude-code" && oauthToken != "" {
		env["CLAUDE_CODE_OAUTH_TOKEN"] = oauthToken
	}
	if setup.ModelProvider != "zakura" && setup.SetupMode == "api_key" && key != "" {
		set := func(value string, names ...string) {
			for _, name := range names {
				env[name] = value
			}
		}
		withBase := func(names ...string) {
			if baseURL != "" {
				set(baseURL, names...)
			}
		}
		switch id {
		case "claude-code":
			set(key, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
			withBase("ANTHROPIC_BASE_URL")
		case "codex":
			set(key, "OPENAI_API_KEY")
			withBase("OPENAI_BASE_URL")
		case "gemini-cli":
			set(key, "GEMINI_API_KEY", "GOOGLE_API_KEY")
		case "hermes":
			if provider := managed("provider"); provider != "" {
				env["LLM_PROVIDER"] = provider
			}
			if model != "" {
				env["LLM_MODEL"] = model
			}
			set(key, "LLM_API_KEY", "OPENAI_API_KEY")
			withBase("LLM_BASE_URL", "OPENAI_BASE_URL")
		case "opencode":
			env["OPENCODE_API_KEY"] = key
			if strings.HasPrefix(key, "sk-ant-") {
				env["ANTHROPIC_API_KEY"] = key
			} else {
				env["OPENAI_API_KEY"] = key
			}
			withBase("OPENAI_BASE_URL")
		case "grok":
			set(key, "XAI_API_KEY", "GROK_API_KEY", "OPENAI_API_KEY")
			withBase("XAI_BASE_URL")
		case "copilot":
			set(key, "GH_TOKEN", "GITHUB_TOKEN")
		case "kimi-code":
			set(key, "KIMI_API_KEY", "MOONSHOT_API_KEY")
			withBase("KIMI_BASE_URL", "KIMI_API_BASE_URL", "MOONSHOT_BASE_URL")
		case "pi":
			if provider := managed("provider"); provider != "" {
				env["LLM_PROVIDER"] = provider
			}
			set(key, "OPENAI_API_KEY", "PI_API_KEY", "LLM_API_KEY")
			withBase("OPENAI_BASE_URL")
		case "fx":
			set(key, "AI_GATEWAY_API_KEY", "OPENAI_API_KEY")
			withBase("OPENAI_BASE_URL", "AI_GATEWAY_BASE_URL")
		case "qwen-code":
			set(key, "DASHSCOPE_API_KEY")
			withBase("DASHSCOPE_API_BASE")
		case "fast-agent":
			set(key, "OPENAI_API_KEY", "OPENAI__API_KEY")
			withBase("OPENAI_BASE_URL", "OPENAI__BASE_URL")
		default:
			env["API_KEY"] = key
			withBase("API_BASE_URL")
		}
	}
	if model != "" {
		applyACPModelEnv(env, id, model)
	}
	if id == "claude-code" && model != "" && baseURL != "" && setup.ModelProvider != "zakura" {
		env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = model
		env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = model
		env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = model
	}
	if id == "grok" && model != "" {
		hasModel := false
		for _, arg := range args {
			if arg == "--model" || arg == "-m" {
				hasModel = true
			}
		}
		if !hasModel {
			args = append(args, "--model", model)
		}
	}
	if setup.ModelProvider == "zakura" {
		for name, value := range acpIntegrationEnv(id, setup.Managed) {
			env[name] = value
		}
	}
	return acpLaunch{Command: command, Args: args, Env: env}
}

func applyACPZakuraRouteEnv(env map[string]string, id, key, baseURL string) {
	set := func(value string, names ...string) {
		for _, name := range names {
			env[name] = value
		}
	}
	if key != "" {
		set(key, "ZAKURA_API_KEY", "OPENAI_API_KEY")
		switch id {
		case "grok":
			set(key, "XAI_API_KEY", "GROK_API_KEY")
		case "kimi-code":
			set(key, "KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_AUTH_TOKEN", "KIMI_CODE_API_KEY", "LLM_API_KEY")
		case "hermes":
			env["LLM_PROVIDER"] = "openai"
			set(key, "LLM_API_KEY", "HERMES_API_KEY", "OPENAI_API_TOKEN", "API_KEY")
		case "pi":
			env["LLM_PROVIDER"] = "openai"
			set(key, "PI_API_KEY", "LLM_API_KEY")
		case "opencode":
			env["OPENCODE_API_KEY"] = key
		case "fx":
			set(key, "AI_GATEWAY_API_KEY")
		case "fast-agent":
			env["OPENAI__API_KEY"] = key
		}
	}
	if baseURL == "" {
		return
	}
	set(baseURL, "ZAKURA_BASE_URL", "OPENAI_BASE_URL")
	switch id {
	case "grok":
		set(baseURL, "XAI_BASE_URL", "XAI_API_BASE_URL")
	case "kimi-code":
		set(baseURL, "KIMI_BASE_URL", "KIMI_API_BASE_URL", "KIMI_CODE_BASE_URL", "MOONSHOT_API_BASE_URL", "MOONSHOT_BASE_URL", "API_BASE_URL")
	case "hermes":
		set(baseURL, "LLM_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_BASE_URL", "LLM_API_BASE", "LLM_API_BASE_URL", "HERMES_BASE_URL")
	case "fx":
		env["AI_GATEWAY_BASE_URL"] = baseURL
	case "fast-agent":
		env["OPENAI__BASE_URL"] = baseURL
	}
}

func applyACPModelEnv(env map[string]string, id, model string) {
	env["LLM_MODEL"] = model
	switch id {
	case "claude-code":
		env["ANTHROPIC_MODEL"] = model
	case "gemini-cli":
		env["GEMINI_MODEL"] = model
	case "grok":
		env["XAI_MODEL"], env["GROK_MODEL"], env["OPENAI_MODEL"] = model, model, model
	case "kimi-code":
		env["KIMI_MODEL"], env["MOONSHOT_MODEL"], env["OPENAI_MODEL"] = model, model, model
	case "hermes":
		env["HERMES_MODEL"], env["OPENAI_MODEL"] = model, model
	default:
		env["OPENAI_MODEL"] = model
	}
	if id == "fx" {
		env["FX_MODEL"] = model
	}
}

var acpManagedTemplate = regexp.MustCompile(`(?i)\$\{managed\.([a-z0-9_]+)\}`)

func acpIntegrationEnv(profileID string, managed map[string]string) map[string]string {
	agent, ok := acpRegistryAgentFor(profileID)
	out := map[string]string{}
	if !ok {
		return out
	}
	for name, template := range agent.Integration.Env {
		missing := false
		value := acpManagedTemplate.ReplaceAllStringFunc(template, func(match string) string {
			key := acpManagedTemplate.FindStringSubmatch(match)[1]
			resolved := strings.TrimSpace(managed[key])
			if resolved == "" {
				missing = true
			}
			return resolved
		})
		if !missing && value != "" {
			out[name] = value
		}
	}
	return out
}

// acpGatewayModel is one Zakura gateway alias plus the metadata OpenCode needs
// to avoid "Model metadata not found" fallbacks.
type acpGatewayModel struct {
	ID           string `json:"id"`
	Name         string `json:"name,omitempty"`
	ContextLimit int    `json:"contextLimit,omitempty"`
	OutputLimit  int    `json:"outputLimit,omitempty"`
	Reasoning    *bool  `json:"reasoning,omitempty"`
	ToolCall     *bool  `json:"toolCall,omitempty"`
	Attachment   *bool  `json:"attachment,omitempty"`
}

var acpLinePlaceholder = regexp.MustCompile(`(?i)\$\{([a-z_]+)\}`)

func acpRenderTemplate(template string, vars map[string]string) string {
	lines := []string{}
	for _, line := range strings.Split(template, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		empty := false
		out := acpLinePlaceholder.ReplaceAllStringFunc(line, func(match string) string {
			value := vars[strings.ToLower(acpLinePlaceholder.FindStringSubmatch(match)[1])]
			if value == "" {
				empty = true
			}
			return value
		})
		if !empty {
			lines = append(lines, out)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

type acpRuntimeFile struct {
	Path    string // absolute path inside the adapter's environment
	Content string
}

// acpRuntimeFiles renders the files an API-key or Zakura-routed launch needs
// under home: registry dotenv/runtime templates plus the OpenCode, Codex and
// Pi configs that cannot be expressed through environment variables alone.
func acpRuntimeFiles(home string, setup acpSetup, gatewayModels []acpGatewayModel, preferredModel string) ([]acpRuntimeFile, map[string]string) {
	routed := setup.ModelProvider == "zakura"
	if setup.SetupMode != "api_key" && !routed {
		return nil, nil
	}
	pick := func(routedKey, nativeKey string) string {
		if routed {
			return strings.TrimSpace(setup.Managed[routedKey])
		}
		return strings.TrimSpace(setup.Managed[nativeKey])
	}
	key, baseURL, model := pick("zakura_api_key", "api_key"), pick("zakura_base_url", "base_url"), strings.TrimSpace(setup.Managed["model"])
	provider, runtimeProvider := strings.TrimSpace(setup.Managed["provider"]), strings.TrimSpace(setup.Managed["provider"])
	if routed {
		provider, runtimeProvider = "openai", "custom"
	}
	files := []acpRuntimeFile{}
	env := map[string]string{}
	if agent, ok := acpRegistryAgentFor(setup.ID); ok && (key != "" || baseURL != "" || model != "") {
		vars := map[string]string{"api_key": key, "base_url": baseURL, "model": model, "provider": provider, "runtime_provider": runtimeProvider}
		templates := map[string]string{}
		for path, template := range agent.Integration.Dotenv {
			templates[path] = template
		}
		for path, template := range agent.Integration.RuntimeFiles {
			templates[path] = template
		}
		paths := make([]string, 0, len(templates))
		for path := range templates {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			if content := acpRenderTemplate(templates[path], vars); content != "" {
				files = append(files, acpRuntimeFile{Path: home + "/" + strings.TrimPrefix(path, "/"), Content: content})
			}
		}
	}
	models := append([]acpGatewayModel(nil), gatewayModels...)
	for _, selected := range []string{model, preferredModel} {
		if selected == "" {
			continue
		}
		found := false
		for _, candidate := range models {
			if candidate.ID == selected {
				found = true
				break
			}
		}
		if !found {
			models = append(models, acpGatewayModel{ID: selected})
		}
	}
	switch setup.ID {
	case "opencode":
		if content := acpOpenCodeConfig(key, baseURL, model, routed, models, preferredModel); content != "" {
			// Large inventories exceed exec's per-environment-variable size limit.
			// Reconcile the private config file before the adapter starts.
			configPath := home + "/.config/opencode/zakura.json"
			files = append(files, acpRuntimeFile{Path: configPath, Content: content})
			env["OPENCODE_CONFIG"] = configPath
		}
	case "codex":
		preferred := model
		if preferred == "" {
			preferred = preferredModel
		}
		if preferred == "" && len(models) > 0 {
			preferred = models[0].ID
		}
		if baseURL != "" || preferred != "" {
			lines := []string{}
			if preferred != "" {
				lines = append(lines, "model = "+acpTOMLString(preferred))
			}
			if baseURL != "" {
				providerID, name := "custom", "Custom Provider"
				if routed {
					providerID, name = "zakura", "Zakura Gateway"
				}
				lines = append(lines, "model_provider = "+acpTOMLString(providerID), "", "[model_providers."+providerID+"]", "name = "+acpTOMLString(name), "base_url = "+acpTOMLString(baseURL), `wire_api = "responses"`, "requires_openai_auth = true")
			}
			files = append(files, acpRuntimeFile{Path: home + "/.codex/config.toml", Content: strings.Join(lines, "\n") + "\n"})
			if key != "" {
				auth, _ := json.MarshalIndent(map[string]string{"OPENAI_API_KEY": key}, "", "  ")
				files = append(files, acpRuntimeFile{Path: home + "/.codex/auth.json", Content: string(auth) + "\n"})
			}
		}
	case "pi":
		if key != "" && baseURL != "" && len(models) > 0 {
			providerID := "custom"
			if routed {
				providerID = "zakura"
			}
			entries := []map[string]any{}
			for _, candidate := range models {
				name := candidate.Name
				if name == "" {
					name = candidate.ID
				}
				input := []string{"text"}
				if candidate.Attachment != nil && *candidate.Attachment {
					input = append(input, "image")
				}
				contextWindow, maxTokens := candidate.ContextLimit, candidate.OutputLimit
				if contextWindow == 0 {
					contextWindow = 128_000
				}
				if maxTokens == 0 {
					maxTokens = 32_000
				}
				entries = append(entries, map[string]any{"id": candidate.ID, "name": name, "reasoning": candidate.Reasoning != nil && *candidate.Reasoning, "input": input, "contextWindow": contextWindow, "maxTokens": maxTokens})
			}
			raw, _ := json.MarshalIndent(map[string]any{"providers": map[string]any{providerID: map[string]any{"baseUrl": strings.TrimRight(baseURL, "/"), "api": "openai-completions", "apiKey": key, "authHeader": true, "models": entries}}}, "", "  ")
			files = append(files, acpRuntimeFile{Path: home + "/.pi/agent/models.json", Content: string(raw) + "\n"})
		}
	}
	return files, env
}

func acpTOMLString(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`) + `"`
}

func acpOpenCodeConfig(key, baseURL, model string, routed bool, models []acpGatewayModel, preferredModel string) string {
	config := map[string]any{"$schema": "https://opencode.ai/config.json"}
	switch {
	case baseURL != "" && key != "":
		anthropic := !routed && strings.HasPrefix(key, "sk-ant-")
		providerID, npm, name := "openai-compatible", "@ai-sdk/openai-compatible", "OpenAI Compatible"
		if routed {
			providerID, name = "zakura", "Zakura Gateway"
		} else if anthropic {
			providerID, npm, name = "anthropic-compatible", "@ai-sdk/anthropic", "Anthropic Compatible"
		}
		provider := map[string]any{"npm": npm, "name": name, "options": map[string]any{"apiKey": key, "baseURL": baseURL}}
		ids := []string{}
		if len(models) > 0 {
			entries := map[string]any{}
			for _, candidate := range models {
				label := candidate.Name
				if label == "" {
					label = candidate.ID
				}
				entry := map[string]any{"name": label}
				contextLimit, outputLimit := candidate.ContextLimit, candidate.OutputLimit
				if contextLimit <= 0 {
					contextLimit = 128_000
				}
				if outputLimit <= 0 {
					outputLimit = 32_000
				}
				if outputLimit > contextLimit {
					outputLimit = contextLimit
				}
				entry["limit"] = map[string]any{"context": contextLimit, "output": outputLimit}
				if candidate.Reasoning != nil {
					entry["reasoning"] = *candidate.Reasoning
				}
				if candidate.ToolCall != nil {
					entry["toolcall"] = *candidate.ToolCall
				}
				if candidate.Attachment != nil {
					entry["attachment"] = *candidate.Attachment
				}
				entries[candidate.ID] = entry
				ids = append(ids, candidate.ID)
			}
			provider["models"] = entries
		}
		config["provider"] = map[string]any{providerID: provider}
		preferred := model
		if preferred == "" {
			for _, id := range ids {
				if id == preferredModel {
					preferred = id
				}
			}
		}
		if preferred == "" && len(ids) > 0 {
			preferred = ids[0]
		}
		if preferred != "" {
			config["model"] = providerID + "/" + preferred
		}
	case model != "" && key != "":
		prefix := "openai"
		if strings.HasPrefix(key, "sk-ant-") {
			prefix = "anthropic"
		}
		config["model"] = prefix + "/" + model
	default:
		return ""
	}
	raw, _ := json.Marshal(config)
	return string(raw)
}
