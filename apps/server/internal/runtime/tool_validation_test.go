// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
)

func TestToolArgumentSchemaValidation(t *testing.T) {
	tool := agentTool{Name: "fixture", InputSchema: map[string]any{
		"type": "object", "required": []string{"count", "mode"}, "additionalProperties": false,
		"properties": map[string]any{"count": map[string]any{"$ref": "#/$defs/count"}, "mode": map[string]any{"enum": []string{"read", "write"}}},
		"$defs":      map[string]any{"count": map[string]any{"type": "integer", "minimum": 1}},
	}}
	for _, input := range []string{`null`, `[]`, `1`, `{}`, `{"count":1.2,"mode":"read"}`, `{"count":"1","mode":"read"}`, `{"count":1,"mode":"other"}`, `{"count":1,"mode":"read","extra":true}`} {
		if err := validateToolArguments(tool, json.RawMessage(input)); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
	if err := validateToolArguments(tool, json.RawMessage(`{"count":9007199254740993,"mode":"read"}`)); err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"https://example.invalid/schema.json", "file:///etc/passwd"} {
		tool.InputSchema = map[string]any{"$ref": ref}
		if err := validateToolArguments(tool, json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "external tool schema reference is disabled") {
			t.Fatalf("external ref %s: %v", ref, err)
		}
	}
	for _, tool := range builtinToolDefinitions(Agent{EnableMemory: true}, true, true, defaultPlatformWebToolDefaults()) {
		err := validateToolArguments(tool, json.RawMessage(`{}`))
		if err != nil && strings.Contains(err.Error(), "invalid schema for tool") {
			t.Errorf("%s: %v", tool.Name, err)
		}
	}
}

func TestNestedToolPreflightBeforeApproval(t *testing.T) {
	for _, wrapper := range []bool{false, true} {
		t.Run(fmt.Sprint(wrapper), func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			h := &handler{deps: s.store.deps, store: s.store, service: s}
			if err := h.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("enable_memory", true).Error; err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
			var err error
			if wrapper {
				_, err = h.runToolExecute(ctx, "tenant", a.ID, session.ID, "outer", json.RawMessage(`{"name":"memory_remember","arguments":{}}`))
			} else {
				_, err = h.runCodemodeCall(ctx, "tenant", a.ID, session.ID, "outer/codemode-1", "memory_remember", json.RawMessage(`{}`))
			}
			if err == nil || !strings.Contains(err.Error(), "content") {
				t.Fatalf("missing schema error: %v", err)
			}
			var approvals int64
			h.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Count(&approvals)
			if approvals != 0 {
				t.Fatal("invalid nested call requested approval")
			}
		})
	}
}

func TestToolPreflightBeforeApprovalAndHooks(t *testing.T) {
	for _, input := range []string{`{}`, `{"content":1}`, `null`, `[]`, `{"content":`} {
		t.Run(input, func(t *testing.T) {
			s, a, session, run := approvalFixture(t, map[string]any{"policy": "always_ask"})
			var effects atomic.Int32
			s.toolRunner = func(context.Context, string, string, string, string, string, json.RawMessage) (json.RawMessage, error) {
				effects.Add(1)
				return json.RawMessage(`{}`), nil
			}
			project := &agentProjectContext{hooks: []projectHookPackage{{Events: map[string][]projectHookGroup{"PreToolUse": {{Actions: []projectHookAction{{Type: "command", Command: "fixture"}}}}}}}, exec: func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error) {
				effects.Add(1)
				return "", nil
			}}
			ctx := context.WithValue(context.Background(), agentProjectContextKey{}, project)
			catalog := agentCatalog{Tools: []agentTool{directBuiltin("memory_remember", "", map[string]any{"content": map[string]any{"type": "string"}}, "content")}}
			messages := []chatMessage{}
			if err := s.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID, []modelToolCall{{ID: "call", Name: "memory_remember", Arguments: input}}, catalog, true, 8000, &messages); err != nil {
				t.Fatal(err)
			}
			var approvals int64
			s.store.deps.Gorm.Table("agent_tool_approvals").Where("session_id=?", session.ID).Count(&approvals)
			if effects.Load() != 0 || approvals != 0 || len(messages) != 1 || !strings.Contains(messages[0].Content, "arguments") {
				t.Fatalf("effects=%d approvals=%d messages=%+v", effects.Load(), approvals, messages)
			}
		})
	}
}
