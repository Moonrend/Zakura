// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestToolDiscoveryBoundsSchemasAndDisabled(t *testing.T) {
	tools := []agentTool{}
	for i := 0; i < 40; i++ {
		tools = append(tools, agentTool{Name: fmt.Sprintf("mcp__repo__issue_%02d", i), Exposure: "deferred", ServerRef: "repo", ServerDescription: "代码仓库", Description: "Search issues", InputSchema: map[string]any{"type": "object", "required": []string{"query"}}})
	}
	tools = append(tools, agentTool{Name: "secret", Exposure: "hidden", Description: "Search issues"})
	disabled := disabledToolSet(rawJSON(map[string]any{"disabledTools": []string{tools[0].Name}}))
	page := discoverTools(tools, disabled, toolDiscoveryQuery{Query: "issues", Limit: 100})
	if len(page.Tools) != 20 || page.Total != 39 || page.NextOffset == nil || *page.NextOffset != 20 {
		t.Fatalf("page=%+v", page)
	}
	for _, item := range page.Tools {
		if item.InputSchema != nil || item.Name == tools[0].Name || item.Name == "secret" {
			t.Fatalf("unexpected discovery: %+v", item)
		}
	}
	described := discoverTools(tools, nil, toolDiscoveryQuery{Names: []string{tools[0].Name}})
	if len(described.Tools) != 1 || described.Tools[0].InputSchema == nil || !strings.Contains(described.Tools[0].Call, `tools["`) {
		t.Fatalf("description=%+v", described)
	}
	if got := discoverTools(tools, nil, toolDiscoveryQuery{Query: "代码仓库", Limit: 1}); len(got.Tools) != 1 {
		t.Fatalf("unicode server hint not searchable: %+v", got)
	}
	if got := discoverTools(tools, nil, toolDiscoveryQuery{Server: "other"}); got.Total != 0 {
		t.Fatal("server filter ignored")
	}
}

func TestToolExecuteApprovesConcreteTarget(t *testing.T) {
	s, a, session, run := approvalFixture(t, map[string]any{"policy": "allow_all", "alwaysDeny": []string{"memory_remember"}})
	h := &handler{deps: s.store.deps, store: s.store, service: s}
	if err := h.deps.Gorm.Table("agents").Where("id=?", a.ID).Update("enable_memory", true).Error; err != nil {
		t.Fatal(err)
	}
	s.toolRunner = h.dispatchAgentTool
	s.toolAuthorizer = h.authorizeAgentTool
	ctx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
	messages := []chatMessage{}
	err := s.runRoundTools(ctx, TurnRequest{Tenant: "tenant", Agent: a.ID, Session: session.ID}, session, run.ID,
		[]modelToolCall{{ID: "outer", Name: "tool_execute", Arguments: `{"name":"memory_remember","arguments":{"content":"must not be stored"}}`}},
		agentCatalog{}, true, 8000, &messages)
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := h.deps.Gorm.Table("memories").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("denied target executed: %d %v", count, err)
	}
	if len(messages) != 1 || !strings.Contains(messages[0].Content, "denied") {
		t.Fatalf("denial missing: %+v", messages)
	}
	for _, args := range []string{`{"name":"tool_execute","arguments":{}}`, `{"name":"codemode","arguments":{}}`, `{"name":"memory_remember","arguments":[]}`} {
		if _, err := h.runToolExecute(ctx, "tenant", a.ID, session.ID, "invalid", json.RawMessage(args)); err == nil {
			t.Fatalf("accepted invalid target %s", args)
		}
	}
}

func TestNestedToolResultsStayOutOfModelHistory(t *testing.T) {
	for _, inner := range []string{"outer/codemode-1", "outer/execute"} {
		events := []histEvent{
			{Type: "tool_call_start", Payload: map[string]any{"toolCallId": "outer", "name": "codemode"}},
			{Type: "tool_call_args", Payload: map[string]any{"toolCallId": "outer", "arguments": `{}`}},
			{Type: "tool_call_start", Payload: map[string]any{"toolCallId": inner, "name": "echo"}},
			{Type: "tool_call_args", Payload: map[string]any{"toolCallId": inner, "arguments": `{}`}},
			{Type: "tool_call_result", Payload: map[string]any{"toolCallId": inner, "resultText": "large intermediate data"}},
			{Type: "tool_call_result", Payload: map[string]any{"toolCallId": "outer", "resultText": "selected output"}},
		}
		messages := runEventsToMessages(events)
		if len(messages) != 2 || len(messages[0].ToolCalls) != 1 || messages[1].Content != "selected output" {
			t.Fatalf("nested history leaked: %+v", messages)
		}
	}
}

func TestCompactSurfaceMatchesAgentExposure(t *testing.T) {
	cfg := json.RawMessage(`{"description":"Search issues and manage repositories","toolExposure":{"read":"direct","remove":"hidden"}}`)
	exposed := []exposedMCPTool{}
	for _, local := range []string{"read", "search", "remove"} {
		exposed = append(exposed, exposedMCPTool{Instance: mcpInstance{ID: "i", Name: "Repository", Ref: "repo", Config: cfg}, LocalName: local, Tool: map[string]any{"description": local, "inputSchema": map[string]any{"type": "object"}}})
	}
	catalog := mcpDiscoveryCatalog(exposed)
	tools := compactMCPTools(catalog)
	if len(tools) != 3 || tools[2]["name"] != "mcp__repo__read" {
		t.Fatalf("pinned direct tool missing: %#v", tools)
	}
	if !strings.Contains(tools[0]["description"].(string), "manage repositories") || !strings.Contains(tools[0]["description"].(string), "search") {
		t.Fatal("server capabilities missing")
	}
	catalog.Tools = append(catalog.Tools, directBuiltin("tool_search", TOOL_SEARCH_DESCRIPTION, toolDiscoveryProperties()), toolExecuteDefinition())
	declared := declaredTools(catalog, map[string]bool{"mcp__repo__search": true}, nil)
	if len(declared) != len(tools) {
		t.Fatalf("agent expanded deferred tools: %#v", declared)
	}
	for _, item := range declared {
		name := item["function"].(map[string]any)["name"]
		if name == "mcp__repo__search" || name == "mcp__repo__remove" {
			t.Fatalf("unexpected declaration %s", name)
		}
	}
}
