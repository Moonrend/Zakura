// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import "strings"

// MessageContext wraps the visible user text without changing its role or
// hiding it from history. Clients display it only in message details.
type MessageContext struct {
	Prefix string `json:"prefix,omitempty"`
	Suffix string `json:"suffix,omitempty"`
}

func (c *MessageContext) render(content string) string {
	if c == nil {
		return content
	}
	parts := []string{}
	if c.Prefix != "" {
		parts = append(parts, c.Prefix)
	}
	parts = append(parts, content)
	if c.Suffix != "" {
		parts = append(parts, c.Suffix)
	}
	return strings.Join(parts, "\n\n")
}

func (c *MessageContext) equal(other *MessageContext) bool {
	left, right := MessageContext{}, MessageContext{}
	if c != nil {
		left = *c
	}
	if other != nil {
		right = *other
	}
	return left == right
}

func messageContextFromPayload(p map[string]any) *MessageContext {
	v, ok := p["context"].(map[string]any)
	if !ok {
		return nil
	}
	prefix, _ := v["prefix"].(string)
	suffix, _ := v["suffix"].(string)
	return &MessageContext{Prefix: prefix, Suffix: suffix}
}

func userPayloadContent(p map[string]any) string {
	content, _ := p["content"].(string)
	return messageContextFromPayload(p).render(content)
}
