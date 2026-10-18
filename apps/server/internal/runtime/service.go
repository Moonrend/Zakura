// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

type Service struct {
	store             *Store
	gateway           *Gateway
	mu                sync.Mutex
	runs              map[string]*liveRun
	sessionLocks      map[string]*sync.Mutex
	toolRunner        func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error)
	toolAuthorizer    func(context.Context, string, string, string, string, json.RawMessage) error
	acpRunner         func(context.Context, string, string, string, string, string) error
	acpQueueAdmission func(context.Context, string, string, string) (*acpQueueReceipt, error)
	acpQueueRequired  func(context.Context, string, string, string) (bool, error)
	acpQueueReceipts  map[string]*acpQueueReceipt
	catalogProvider   func(context.Context, string, string) (agentCatalog, error)
	loadedTools       func(context.Context, string, string, string) map[string]bool

	// Optional collaborators wired by RegisterRoutes; tests leave them nil.
	memoryRecall     func(ctx context.Context, tenant, agent, query string) []promptMemory
	memoryWriter     func(ctx context.Context, tenant, agent string, m Memory) (Memory, error)
	skillsProvider   func(ctx context.Context, tenant, agent string) []promptSkill
	projectContext   func(ctx context.Context, tenant, space, agent, project string, requested []string, available []promptSkill) (*agentProjectContext, error)
	attachmentReader func(ctx context.Context, tenant, agent, path string, max int64) ([]byte, error)
	// postRun enables the model calls made after a run completes (session
	// title, memory extraction).
	postRun bool

	retryBackoff time.Duration
	cancelGrace  time.Duration
}

// liveRun tracks a run executing in this process.
type liveRun struct {
	id              string
	session         string
	cancel          context.CancelFunc
	done            chan struct{}
	cancelRequested atomic.Bool
}

func NewService(store *Store) *Service {
	return &Service{store: store, gateway: NewGateway(store), runs: map[string]*liveRun{}, sessionLocks: map[string]*sync.Mutex{}, retryBackoff: 1500 * time.Millisecond, cancelGrace: 5 * time.Second}
}

func (s *Service) StartTurn(ctx context.Context, tenant, agent, session, content string, attachments, options json.RawMessage, queueOnConflict bool) (Run, *QueueMessage, error) {
	return s.Start(ctx, TurnRequest{Tenant: tenant, Agent: agent, Session: session, Content: content, Attachments: attachments, Options: options, QueueOnConflict: queueOnConflict})
}

func (s *Service) registerRun(runID, session string, cancel context.CancelFunc) *liveRun {
	live := &liveRun{id: runID, session: session, cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	s.runs[runID] = live
	s.mu.Unlock()
	return live
}

func (s *Service) unregisterRun(live *liveRun) {
	s.mu.Lock()
	if s.runs[live.id] == live {
		delete(s.runs, live.id)
	}
	s.mu.Unlock()
	live.cancel()
	close(live.done)
}

func (s *Service) lookupRun(runID string) *liveRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs[runID]
}

func (s *Service) sessionLock(session string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	mu := s.sessionLocks[session]
	if mu == nil {
		mu = &sync.Mutex{}
		s.sessionLocks[session] = mu
	}
	return mu
}

func (s *Service) recordToolUsage(ctx context.Context, sess Session, tenant, agent, session, callID, name, status string, duration int64) {
	if s.store.deps.RecordUsage == nil || sess.CreatedByUserID == nil || *sess.CreatedByUserID == "" {
		return
	}
	_ = s.store.deps.RecordUsage(ctx, appdeps.UsageRecord{TenantID: tenant, UserID: *sess.CreatedByUserID, ActorKind: "user", Category: "tool", Action: "tool_called", Status: status, DurationMS: duration, AgentID: agent, SessionID: session, ResourceKind: "tool_call", ResourceID: callID, Summary: name})
}

func (s *Service) fail(ctx context.Context, tenant, agent, session, runID string, err error) {
	m := err.Error()
	_ = s.store.FinishRun(ctx, tenant, agent, session, runID, "failed", &m, map[string]any{"runId": runID, "error": m})
}

// startNext starts the next queued message when the session is idle. Stopping
// a run only ends that turn; queued follow-ups keep draining in order.
func (s *Service) startNext(ctx context.Context, tenant, agent, session string) {
	mu := s.sessionLock(session)
	mu.Lock()
	defer mu.Unlock()
	sess, err := s.store.GetSession(ctx, tenant, agent, session)
	if err != nil || sess.ActiveRunID != nil {
		return
	}
	m, err := s.store.TakeQueued(ctx, tenant, agent, session)
	if err != nil {
		return
	}
	if sess.Kind == "acp" {
		ctx, err = s.acpQueuedContext(ctx, tenant, agent, session, m)
		if err != nil {
			_ = s.store.requeueFront(ctx, tenant, agent, session, m)
			_, _ = s.store.AppendEvent(ctx, tenant, agent, session, "queue.authorization_required", nil, map[string]any{"messageId": m.ID, "error": "ACP queued authorization cannot be verified; remove and resend this message"})
			return
		}
	}
	_, _, err = s.startLocked(ctx, TurnRequest{Tenant: tenant, Agent: agent, Session: session, Content: m.Content, Attachments: m.Attachments, Options: m.Options, MessageID: m.ID, UserID: m.UserID, UserName: m.UserName})
	if err != nil {
		_ = s.store.requeueFront(ctx, tenant, agent, session, m)
	} else {
		s.forgetACPQueueReceipt(tenant, agent, session, m.ID)
	}
}

// Cancel stops the session's active run. A chat loop running in this process
// is asked to stop and given a grace period to settle the run itself, so
// unfinished tool calls get their placeholder results before run_end.
func (s *Service) Cancel(ctx context.Context, tenant, agent, session string) (Run, error) {
	sess, e := s.store.GetSession(ctx, tenant, agent, session)
	if e != nil {
		return Run{}, e
	}
	if sess.ActiveRunID == nil {
		return Run{}, ErrConflict
	}
	runID := *sess.ActiveRunID
	if live := s.lookupRun(runID); live != nil {
		live.cancelRequested.Store(true)
		live.cancel()
		if sess.Kind != "acp" {
			select {
			case <-live.done:
			case <-time.After(s.cancelGrace):
			case <-ctx.Done():
			}
			if run, err := s.store.GetRun(context.WithoutCancel(ctx), tenant, agent, session, runID); err == nil && run.Status != "running" && run.Status != "queued" {
				return run, nil
			}
		}
	}
	// Settle the run captured above, never whichever run has become active
	// since then: a cancelled turn may already have drained its next message.
	settle := context.WithoutCancel(ctx)
	err := s.store.FinishRun(settle, tenant, agent, session, runID, "cancelled", nil, nil)
	if err != nil && !errors.Is(err, ErrConflict) {
		return Run{}, err
	}
	if err == nil {
		_ = s.store.deps.Gorm.WithContext(settle).Table("cloud_agent_runs").Where("id=? AND session_id=?", runID, session).Update("cancel_requested", true).Error
	}
	_ = s.store.cancelApprovals(settle, tenant, agent, session, runID)
	run, err := s.store.GetRun(settle, tenant, agent, session, runID)
	if err == nil {
		go s.startNext(s.store.deps.RunContext(), tenant, agent, session)
	}
	return run, err
}

// Interrupt promotes a queued message, stops the active run, and lets the
// promoted message start the next turn.
func (s *Service) Interrupt(ctx context.Context, tenant, agent, session, messageID string) error {
	if _, err := s.store.markQueuedInterrupt(ctx, tenant, agent, session, messageID); err != nil {
		return err
	}
	if _, err := s.Cancel(ctx, tenant, agent, session); err != nil && !errors.Is(err, ErrConflict) {
		return err
	}
	s.startNext(context.WithoutCancel(ctx), tenant, agent, session)
	return nil
}

func (s *Service) cancelRunIDs(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if live := s.runs[id]; live != nil {
			live.cancelRequested.Store(true)
			live.cancel()
		}
	}
}

type disabledToolsKey struct{}

func normalizeToolOptionName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	if idx := strings.IndexByte(name, ':'); idx >= 0 {
		return strings.TrimSpace(name[idx+1:])
	}
	if strings.HasPrefix(name, "re_") {
		return name[len("re_"):]
	}
	if strings.HasPrefix(name, "mcp__") {
		return name[len("mcp__"):]
	}
	return name
}

func disabledOptionKeys(name string) []string {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	if idx := strings.IndexByte(name, ':'); idx >= 0 {
		local := strings.TrimSpace(name[idx+1:])
		if local == "" {
			return nil
		}
		return []string{"local:" + local}
	}
	if core := normalizeToolOptionName(name); core != "" {
		return []string{core}
	}
	return nil
}

func toolNameMatchKeys(name string) []string {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	core := normalizeToolOptionName(name)
	if core == "" {
		return nil
	}
	keys := []string{core}
	if strings.HasPrefix(name, "mcp__") {
		if idx := strings.LastIndex(core, "__"); idx >= 0 {
			if local := core[idx+2:]; local != "" {
				keys = append(keys, "local:"+local)
			}
		}
	}
	return keys
}

func disabledToolSet(options json.RawMessage) map[string]bool {
	if len(options) == 0 {
		return nil
	}
	var parsed struct {
		DisabledTools []string `json:"disabledTools"`
	}
	if json.Unmarshal(options, &parsed) != nil {
		return nil
	}
	set := map[string]bool{}
	for _, name := range parsed.DisabledTools {
		for _, key := range disabledOptionKeys(name) {
			set[key] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

func disabledToolsFromContext(ctx context.Context) map[string]bool {
	set, _ := ctx.Value(disabledToolsKey{}).(map[string]bool)
	return set
}

func toolNameDisabled(set map[string]bool, name string) bool {
	if len(set) == 0 {
		return false
	}
	for _, key := range toolNameMatchKeys(name) {
		if set[key] {
			return true
		}
	}
	return false
}

func toolDisabled(ctx context.Context, name string) bool {
	return toolNameDisabled(disabledToolsFromContext(ctx), name)
}

func declaredTools(catalog agentCatalog, loaded map[string]bool, disabled map[string]bool) []map[string]any {
	out := []map[string]any{}
	for _, tool := range catalog.Tools {
		if toolNameDisabled(disabled, tool.Name) {
			continue
		}
		switch tool.Exposure {
		case "direct":
		case "deferred":
			if loaded == nil || !loaded[tool.Name] {
				continue
			}
		default:
			continue
		}
		schema := tool.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

// reachableToolNames lists every tool the model can reach this run: declared
// tools plus deferred ones loadable through tool_search.
func reachableToolNames(catalog agentCatalog, disabled map[string]bool) map[string]bool {
	out := map[string]bool{}
	for _, tool := range catalog.Tools {
		if tool.Exposure == "hidden" || toolNameDisabled(disabled, tool.Name) {
			continue
		}
		out[tool.Name] = true
	}
	return out
}

func renderServerHints(catalog agentCatalog) string {
	type hintServer struct {
		ref         string
		name        string
		description string
	}
	seen := map[string]bool{}
	servers := []hintServer{}
	for _, tool := range catalog.Tools {
		if tool.Kind != "mcp" || tool.Exposure != "deferred" {
			continue
		}
		key := tool.ServerRef + "\x00" + tool.InstanceID
		if seen[key] {
			continue
		}
		seen[key] = true
		description := tool.ServerDescription
		if description == "" {
			description = tool.ServerName
		}
		servers = append(servers, hintServer{ref: tool.ServerRef, name: tool.ServerName, description: description})
	}
	if len(servers) == 0 {
		return ""
	}
	sort.SliceStable(servers, func(i, j int) bool { return servers[i].name < servers[j].name })
	lines := []string{"Tools of the following MCP servers are not listed upfront. Use the tool_search tool with a short query to find and load the tools you need; loaded tools become available on your next turn."}
	for _, server := range servers {
		slug := slugify(server.ref)
		if slug == "" {
			slug = slugify(server.name)
		}
		lines = append(lines, "- mcp__"+slug+": "+server.description)
	}
	const maxHintChars = 2000
	for len(lines) > 1 && len(strings.Join(lines, "\n")) > maxHintChars {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}
