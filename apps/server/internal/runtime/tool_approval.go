// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

type approvalRule struct {
	ID      string `json:"id"`
	Matcher string `json:"matcher"`
	Action  string `json:"action"`
}

type approvalAIConfig struct {
	Scope               string   `json:"scope"`
	Provider            string   `json:"provider"`
	RouteID             string   `json:"routeId"`
	RouteAlias          string   `json:"routeAlias"`
	LLMModel            string   `json:"llmModel"`
	ConfidenceThreshold *float64 `json:"confidenceThreshold"`
	EscalateOnDeny      *bool    `json:"escalateOnDeny"`
	MigrationPending    bool     `json:"jevMigrationPending"`
}

type toolApprovalConfig struct {
	Scope           approvalScopeConfig `json:"-"`
	BypassAlwaysAsk bool                `json:"-"`
	Policy          string              `json:"policy"`
	Rules           []approvalRule      `json:"rules"`
	AlwaysAllow     []string            `json:"alwaysAllow"`
	AlwaysDeny      []string            `json:"alwaysDeny"`
	AI              approvalAIConfig    `json:"aiGate"`
	Timeout         *int                `json:"askTimeoutSeconds"`
}

func parseApprovalConfig(raw json.RawMessage, fallback string) (toolApprovalConfig, error) {
	cfg := toolApprovalConfig{Policy: fallback}
	var root struct {
		Cloud struct {
			Approvals json.RawMessage `json:"approvals"`
		} `json:"cloud"`
	}
	if len(raw) != 0 && json.Unmarshal(raw, &root) != nil {
		return cfg, errors.New("tool approval configuration is invalid")
	}
	if len(root.Cloud.Approvals) > 0 && string(root.Cloud.Approvals) != "null" {
		if json.Unmarshal(root.Cloud.Approvals, &cfg) != nil {
			return cfg, errors.New("tool approval configuration is invalid")
		}
	}
	if cfg.Policy == "ask" {
		cfg.Policy = "always_ask"
	}
	switch cfg.Policy {
	case "allow_all", "always_ask", "ai":
	default:
		return cfg, errors.New("tool approval policy is invalid")
	}
	for _, rule := range cfg.Rules {
		if rule.Matcher == "" || (rule.Action != "allow" && rule.Action != "deny" && rule.Action != "ask") {
			return cfg, errors.New("tool approval rule is invalid")
		}
	}
	if cfg.Timeout != nil && (*cfg.Timeout < 0 || *cfg.Timeout > 86400) {
		return cfg, errors.New("tool approval timeout is invalid")
	}
	if cfg.AI.Scope != "" && cfg.AI.Scope != "inherit" && cfg.AI.Scope != "risky" && cfg.AI.Scope != "all" {
		return cfg, errors.New("tool approval AI scope is invalid")
	}
	if n := cfg.AI.ConfidenceThreshold; n != nil && (math.IsNaN(*n) || *n < 0 || *n > 1) {
		return cfg, errors.New("tool approval confidence is invalid")
	}
	return cfg, nil
}

func approvalMatcher(matcher, name string, args json.RawMessage) bool {
	matcher = strings.TrimSpace(matcher)
	if matcher == "" {
		return false
	}
	if m := hookIfRule.FindStringSubmatch(matcher); m != nil {
		if !approvalMatcher(m[1], name, args) {
			return false
		}
		var body map[string]any
		_ = json.Unmarshal(args, &body)
		value := mapStringValue(body["path"])
		if strings.TrimPrefix(name, "re_") == "shell_exec" || name == "Bash" {
			value = mapStringValue(body["command"])
		}
		return approvalGlob(m[2], hookEnvPrefix.ReplaceAllString(value, ""))
	}
	bare := strings.TrimPrefix(name, "re_")
	for _, part := range strings.FieldsFunc(matcher, func(r rune) bool { return r == '|' || r == ',' }) {
		for _, candidate := range []string{name, bare, hookToolAliases[bare]} {
			if candidate != "" && approvalGlob(strings.TrimSpace(part), candidate) {
				return true
			}
		}
	}
	return false
}

func approvalGlob(pattern, value string) bool {
	re := regexp.QuoteMeta(pattern)
	re = strings.ReplaceAll(strings.ReplaceAll(re, `\*`, `.*`), `\?`, `.`)
	hit, _ := regexp.MatchString("^(?:"+re+")$", value)
	return hit
}

func (c toolApprovalConfig) decision(name string, args json.RawMessage) string {
	for _, matcher := range c.AlwaysDeny {
		if approvalMatcher(matcher, name, args) {
			return "deny"
		}
	}
	for _, r := range c.Rules {
		if r.Action == "deny" && approvalMatcher(r.Matcher, name, args) {
			return "deny"
		}
	}
	if c.Policy == "always_ask" && !c.BypassAlwaysAsk {
		return "ask"
	}
	for _, r := range c.Rules {
		if r.Action == "ask" && approvalMatcher(r.Matcher, name, args) {
			return "ask"
		}
	}
	if c.Policy == "ai" && c.dangerousTool(name, args) {
		return "ai"
	}
	for _, matcher := range c.AlwaysAllow {
		if approvalMatcher(matcher, name, args) {
			return "allow"
		}
	}
	for _, r := range c.Rules {
		if r.Action == "allow" && approvalMatcher(r.Matcher, name, args) {
			return "allow"
		}
	}
	if c.Policy == "allow_all" || c.Policy == "always_ask" && c.BypassAlwaysAsk {
		return "allow"
	}
	if !c.needsAIReview(name, args) {
		return "allow"
	}
	return "ai"
}

type toolApprovalTargetSnapshot struct {
	SpaceID string
	Digest  string
	Review  map[string]any
}

// approvalTarget snapshots identity without provisioning a computer or contacting a runner.
func (s *Service) approvalTarget(ctx context.Context, tenant, agent, run, source string, args json.RawMessage) (string, string, error) {
	target, err := s.snapshotApprovalTarget(ctx, tenant, agent, run, source, args)
	return target.SpaceID, target.Digest, err
}

func (s *Service) snapshotApprovalTarget(ctx context.Context, tenant, agent, run, source string, args json.RawMessage) (toolApprovalTargetSnapshot, error) {
	a, err := s.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return toolApprovalTargetSnapshot{}, err
	}
	space, err := s.store.GetSpace(ctx, tenant, a.SpaceID)
	if err != nil {
		return toolApprovalTargetSnapshot{}, err
	}
	var selection struct {
		ComputerID string `json:"computerId"`
	}
	if err := json.Unmarshal(args, &selection); err != nil {
		return toolApprovalTargetSnapshot{}, err
	}
	if strings.HasPrefix(source, "acp") {
		selection.ComputerID = ""
	}
	if selection.ComputerID == "" && run != "" && !strings.HasPrefix(source, "acp") {
		var target struct {
			ComputerID *string `gorm:"column:computer_id"`
		}
		if err := s.store.deps.Gorm.WithContext(ctx).Table("run_computer_targets").Select("computer_id").Where("run_id=? AND tenant_id=? AND space_id=?", run, tenant, a.SpaceID).Scan(&target).Error; err != nil {
			return toolApprovalTargetSnapshot{}, err
		}
		if target.ComputerID != nil {
			selection.ComputerID = *target.ComputerID
		}
	}
	review := map[string]any{"kind": "space_workspace", "spaceId": space.ID, "workspaceNodeId": space.RuntimeNodeID, "workspaceKind": space.WorkspaceKind}
	var computer any
	if selection.ComputerID != "" {
		var row map[string]any
		if err := s.store.deps.Gorm.WithContext(ctx).Table("computers").Select("id,runtime_node_id,provider,role,settings_json,capabilities_json").Where("id=? AND tenant_id=? AND space_id=?", selection.ComputerID, tenant, a.SpaceID).Take(&row).Error; err != nil {
			return toolApprovalTargetSnapshot{}, err
		}
		computer = row
		// Settings remain part of the identity digest, never provider input.
		review["computerId"], review["provider"], review["role"] = selection.ComputerID, row["provider"], row["role"]
		review["nodeId"] = row["runtime_node_id"]
		if row["role"] != string(computers.RoleServer) {
			review["kind"] = "attached_computer"
		}
	}
	var runtimes []map[string]any
	if selection.ComputerID != "" {
		store := computers.Store{DB: s.store.deps.DB, Rebind: s.store.deps.Rebind}
		c, err := store.Get(ctx, tenant, a.SpaceID, selection.ComputerID)
		if err != nil {
			return toolApprovalTargetSnapshot{}, err
		}
		var scope string
		if c.SessionScoped() && run != "" {
			r, err := s.store.deps.Gorm.WithContext(ctx).Table("cloud_agent_runs").Select("session_id").Where("id=?", run).Rows()
			if err != nil {
				return toolApprovalTargetSnapshot{}, err
			}
			if r.Next() {
				err = r.Scan(&scope)
			}
			r.Close()
			if err != nil {
				return toolApprovalTargetSnapshot{}, err
			}
		}
		if err := s.store.deps.Gorm.WithContext(ctx).Table("computer_runtimes").Select("id,incarnation,external_id,state").Where("tenant_id=? AND space_id=? AND computer_id=? AND session_scope=? AND state NOT IN ('destroyed','expired','failed')", tenant, a.SpaceID, c.ID, scope).Order("id").Find(&runtimes).Error; err != nil {
			return toolApprovalTargetSnapshot{}, err
		}
		review["runtimes"] = runtimes
	}
	var workspace []map[string]any
	if err := s.store.deps.Gorm.WithContext(ctx).Table("managed_containers").Select("docker_id,runtime_node_id").Where("tenant_id=? AND space_id=? AND purpose='workspace' AND docker_id IS NOT NULL", tenant, space.ID).Order("id").Find(&workspace).Error; err != nil {
		return toolApprovalTargetSnapshot{}, err
	}
	if review["kind"] == "space_workspace" {
		review["containers"] = workspace
	}
	encoded, _ := json.Marshal([]any{space.ID, space.RuntimeNodeID, space.WorkspaceKind, space.WorkspaceImage, space.EnableComputer, computer, selection.ComputerID, runtimes, workspace, run, args})
	digest := sha256.Sum256(encoded)
	return toolApprovalTargetSnapshot{SpaceID: space.ID, Digest: hex.EncodeToString(digest[:]), Review: review}, nil
}

type toolApprovalAccessCheckKey struct{}

func checkToolApprovalAccess(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if check, ok := ctx.Value(toolApprovalAccessCheckKey{}).(func(context.Context) error); ok {
		return check(ctx)
	}
	return nil
}

func (s *Service) approveTool(ctx context.Context, tenant, agent, session, run, call, name string, args json.RawMessage, fallback, source, protocolID string) error {
	if err := s.checkToolApprovalAccess(ctx, tenant); err != nil {
		return err
	}
	a, err := s.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	if !parseCloudConfig(a.Config).EnableTools || toolDisabled(ctx, name) {
		return errors.New("tools are disabled for this agent or run")
	}
	if actor, ok := httpx.PrincipalFrom(ctx); ok {
		if err := httpx.AuthorizeResource(ctx, s.store.deps, actor, a.SpaceID, agent); err != nil {
			return err
		}
	}
	if _, err := s.store.GetSession(ctx, tenant, agent, session); err != nil {
		return err
	}
	if !parseCloudConfig(a.Config).EnableTools {
		return errors.New("tools are disabled for this agent")
	}
	if run != "" {
		r, err := s.store.GetRun(ctx, tenant, agent, session, run)
		if err != nil {
			return err
		}
		if r.Status != "running" || r.CancelRequested {
			return context.Canceled
		}
	}
	if source == "standard" && s.toolAuthorizer != nil {
		if err := s.toolAuthorizer(ctx, tenant, agent, session, name, args); err != nil {
			return err
		}
	}
	cfg, err := s.effectiveApprovalConfig(ctx, a, session, run, fallback)
	if err != nil {
		return err
	}
	decision := cfg.decision(name, args)
	if decision == "deny" {
		return errors.New("tool call denied by approval policy")
	}
	if decision == "allow" {
		return nil
	}
	bound, err := s.snapshotApprovalTarget(ctx, tenant, agent, run, source, args)
	if err != nil {
		return err
	}
	space, target := bound.SpaceID, bound.Digest
	reason := "policy_ask"
	var ai json.RawMessage
	if decision == "ai" {
		aiCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		var review map[string]any
		review, err = s.toolApprovalReviewContext(aiCtx, tenant, agent, session, run, source, bound)
		if err == nil {
			ai, err = s.evaluateToolApproval(aiCtx, tenant, cfg.AI, name, args, review)
		}
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err == nil {
			var result struct {
				Decision   string  `json:"decision"`
				Confidence float64 `json:"confidence"`
			}
			_ = json.Unmarshal(ai, &result)
			threshold := .7
			if cfg.AI.ConfidenceThreshold != nil {
				threshold = *cfg.AI.ConfidenceThreshold
			}
			if result.Confidence >= threshold {
				if result.Decision == "allow" {
					if err := s.recheckToolApproval(ctx, tenant, agent, session, run, name, args, fallback, target, source, cfg); err != nil {
						return err
					}
					if err := s.recordAIApproval(ctx, tenant, agent, session, run, call, name, args, space, target, source, protocolID, ai, "approved"); err != nil {
						return err
					}
					return s.recheckToolApproval(ctx, tenant, agent, session, run, name, args, fallback, target, source, cfg)
				}
				if result.Decision == "deny" && cfg.AI.EscalateOnDeny != nil && !*cfg.AI.EscalateOnDeny {
					if err := s.recheckToolApproval(ctx, tenant, agent, session, run, name, args, fallback, target, source, cfg); err != nil {
						return err
					}
					if err := s.recordAIApproval(ctx, tenant, agent, session, run, call, name, args, space, target, source, protocolID, ai, "denied"); err != nil {
						return err
					}
					return errors.New("tool call denied by AI approval")
				}
				reason = "ai_deny_escalate"
			} else {
				reason = "ai_low_confidence"
			}
		} else {
			reason = "ai_low_confidence"
			provider := "jev"
			if cfg.AI.Provider == "llm" {
				provider = "llm"
			}
			ai = rawJSON(map[string]any{"provider": provider, "degraded": true})
		}
	}
	timeout := 300
	if cfg.Timeout != nil {
		timeout = *cfg.Timeout
	}
	var seconds *int
	if timeout > 0 {
		seconds = &timeout
	}
	id, err := s.store.CreateApproval(ctx, tenant, agent, session, run, call, ApprovalRequest{ToolName: name, Args: args, Reason: reason, AI: ai, TimeoutSeconds: seconds, SpaceID: space, TargetDigest: target, Source: source, ProtocolRequestID: protocolID})
	if err != nil {
		return err
	}
	defer func() {
		settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = s.store.settleApproval(settle, tenant, agent, session, id, "cancelled", "cancel", false)
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := s.checkToolApprovalAccess(ctx, tenant); err != nil {
			return err
		}
		row, err := s.store.getApproval(ctx, tenant, agent, session, id)
		if err != nil {
			return err
		}
		if row.Status != "pending" {
			if row.Status != "approved" {
				return fmt.Errorf("tool approval %s", row.Status)
			}
			return s.recheckToolApproval(ctx, tenant, agent, session, run, name, args, fallback, target, source, cfg)
		}
		if row.ExpiresAt != nil && !s.store.now().Before(parseTime(*row.ExpiresAt)) {
			_ = s.store.settleApproval(ctx, tenant, agent, session, id, "timeout", "timeout", false)
			continue
		}
		if run != "" {
			r, err := s.store.GetRun(ctx, tenant, agent, session, run)
			if err != nil {
				return err
			}
			if r.Status != "running" || r.CancelRequested {
				return context.Canceled
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Service) recheckToolApproval(ctx context.Context, tenant, agent, session, run, name string, args json.RawMessage, fallback, target, source string, original toolApprovalConfig) error {
	if err := s.checkToolApprovalAccess(ctx, tenant); err != nil {
		return err
	}
	if run != "" {
		r, err := s.store.GetRun(ctx, tenant, agent, session, run)
		if err != nil {
			return err
		}
		if r.Status != "running" || r.CancelRequested {
			return context.Canceled
		}
	}
	_, current, err := s.approvalTarget(ctx, tenant, agent, run, source, args)
	if err != nil {
		return err
	}
	if current != target {
		return errors.New("tool target changed after approval")
	}
	a, err := s.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	if !parseCloudConfig(a.Config).EnableTools || toolDisabled(ctx, name) {
		return errors.New("tools are disabled for this agent or run")
	}
	if actor, ok := httpx.PrincipalFrom(ctx); ok {
		if err := httpx.AuthorizeResource(ctx, s.store.deps, actor, a.SpaceID, agent); err != nil {
			return err
		}
	}
	if source == "standard" && s.toolAuthorizer != nil {
		if err := s.toolAuthorizer(ctx, tenant, agent, session, name, args); err != nil {
			return err
		}
	}
	policy, err := s.effectiveApprovalConfig(ctx, a, session, run, fallback)
	if err != nil {
		return err
	}
	if policy.decision(name, args) == "deny" {
		return errors.New("tool call denied by approval policy")
	}
	if !reflect.DeepEqual(policy, original) {
		return errors.New("tool approval policy changed while awaiting a decision")
	}
	return ctx.Err()
}

// The guard binds approval to the call before any effectful hook and rechecks
// the same target, policy and resource permissions immediately before dispatch.
func (s *Service) toolExecutionGuard(ctx context.Context, tenant, agent, session, run, call, name string, args json.RawMessage) (func() error, error) {
	a, err := s.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	cfg, err := s.effectiveApprovalConfig(ctx, a, session, run, "allow_all")
	if err != nil {
		return nil, err
	}
	_, target, err := s.approvalTarget(ctx, tenant, agent, run, "standard", args)
	if err != nil {
		return nil, err
	}
	if err := s.approveTool(ctx, tenant, agent, session, run, call, name, args, "allow_all", "standard", ""); err != nil {
		return nil, err
	}
	check := func() error {
		return s.recheckToolApproval(ctx, tenant, agent, session, run, name, args, "allow_all", target, "standard", cfg)
	}
	if err := check(); err != nil {
		return nil, err
	}
	return check, nil
}

func (s *Service) recordAIApproval(ctx context.Context, tenant, agent, session, run, call, name string, args json.RawMessage, space, target, source, protocolID string, ai json.RawMessage, decision string) error {
	_, err := s.store.CreateApproval(ctx, tenant, agent, session, run, call, ApprovalRequest{ToolName: name, Args: args, Reason: "ai_decision", AI: ai, SpaceID: space, TargetDigest: target, Source: source, ProtocolRequestID: protocolID, terminalDecision: decision})
	return err
}

func (s *Service) evaluateToolApproval(ctx context.Context, tenant string, cfg approvalAIConfig, name string, args json.RawMessage, review map[string]any) (json.RawMessage, error) {
	if cfg.MigrationPending {
		return nil, errors.New("evaluation provider needs migration")
	}
	route := cfg.RouteID
	if route == "" {
		route = cfg.RouteAlias
	}
	if cfg.Provider == "llm" {
		return s.evaluateLegacyLLMApproval(ctx, tenant, cfg, name, args, review)
	}
	if route == "" {
		return nil, errors.New("evaluation model is not configured")
	}
	var data any
	if json.Unmarshal(args, &data) != nil {
		return nil, errors.New("invalid approval input")
	}
	return s.gateway.evaluateApproval(ctx, tenant, route, map[string]any{"tool": name, "arguments": redactApprovalInput(data), "context": review})
}

func redactApprovalInput(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, v := range x {
			key := strings.ToLower(k)
			if strings.Contains(key, "token") || strings.Contains(key, "password") || strings.Contains(key, "secret") || strings.Contains(key, "apikey") || strings.Contains(key, "authorization") {
				out[k] = "[redacted]"
			} else {
				out[k] = redactApprovalInput(v)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = redactApprovalInput(v)
		}
		return out
	default:
		return v
	}
}
