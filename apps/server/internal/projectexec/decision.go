// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

var errAwaitingDecision = errors.New("project execution awaits an explicit human decision")

const (
	maxDecisionTools     = 128
	maxToolArgumentBytes = 1 << 20
	maxDecisionTextBytes = 4 << 20
)

// normalizeDecision checks only execution-protocol structure. The runtime
// adapter is responsible for resolving tool identity and effect from its
// trusted tool catalog rather than accepting the model's effect annotation.
func normalizeDecision(d mission.Decision) (mission.Decision, error) {
	if d.Tokens < 0 {
		return d, errors.New("model reported a negative token count")
	}
	if len(d.Tools) > maxDecisionTools {
		return d, errors.New("model decision contains too many tool calls")
	}
	if len(d.Result) > maxDecisionTextBytes {
		return d, errors.New("model result exceeds execution limit")
	}
	if d.Done && len(d.Tools) > 0 {
		return d, errors.New("completed decision cannot contain tool calls")
	}
	if !d.Done && len(d.Tools) == 0 {
		return d, errors.New("model decision must complete or invoke a tool")
	}
	seen := make(map[string]bool, len(d.Tools))
	for _, call := range d.Tools {
		if call.ID == "" || len(call.ID) > 256 || strings.ContainsAny(call.ID, "\r\n\x00") || seen[call.ID] {
			return d, errors.New("tool call identity must be unique and nonempty")
		}
		seen[call.ID] = true
		if strings.TrimSpace(call.Name) == "" || len(call.Name) > 512 || strings.ContainsAny(call.Name, "\r\n\x00") {
			return d, errors.New("invalid tool call name")
		}
		if len(call.Arguments) > maxToolArgumentBytes || !json.Valid(call.Arguments) || len(bytes.TrimSpace(call.Arguments)) == 0 || bytes.TrimSpace(call.Arguments)[0] != '{' {
			return d, fmt.Errorf("tool %s arguments must be a bounded JSON object", call.Name)
		}
		switch call.Effect {
		case "read", "workspace_write", "external_write":
		default:
			return d, fmt.Errorf("tool %s has no trusted effect classification", call.Name)
		}
	}
	if d.Message == nil {
		d.Message = mission.Message{"role": "assistant", "content": d.Result}
	}
	if role, _ := d.Message["role"].(string); role != "assistant" {
		return d, errors.New("model decision message must have assistant role")
	}
	encoded, err := json.Marshal(d.Message)
	if err != nil {
		return d, fmt.Errorf("model decision message is not JSON: %w", err)
	}
	if len(encoded) > maxDecisionTextBytes {
		return d, errors.New("model decision message exceeds execution limit")
	}
	// Canonical tool calls are built from the same validated calls that will be
	// persisted and dispatched, preventing a divergent conversational history.
	if len(d.Tools) > 0 {
		calls := make([]any, 0, len(d.Tools))
		for _, call := range d.Tools {
			calls = append(calls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": string(call.Arguments)}})
		}
		d.Message["tool_calls"] = calls
	} else {
		delete(d.Message, "tool_calls")
	}
	return d, nil
}

func modelDecisionCount(cp mission.Checkpoint) int {
	count := 0
	for _, message := range cp.Messages {
		if message["role"] == "user" {
			count = 0
		}
		if message["role"] == "assistant" {
			count++
		}
	}
	return count
}

func operationResultMessage(operation mission.Operation) mission.Message {
	content := string(operation.Result)
	if operation.Error != "" {
		content = "Tool error: " + operation.Error
	}
	if content == "" {
		content = "null"
	}
	return mission.Message{"role": "tool", "tool_call_id": operation.Call.ID, "content": content}
}
