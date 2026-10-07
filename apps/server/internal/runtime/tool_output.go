// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

const (
	toolOutputMaxBytes        = 24000
	toolOutputHeadBytes       = 12000
	toolOutputTailBytes       = 6000
	toolOutputFallbackHead    = 9000
	toolOutputFallbackTail    = 9000
	toolOutputJSONPreviewSize = 20000
	toolOutputDir             = "/.zakura/outputs"
	toolOutputContainerRoot   = "/workspace"
)

func toolOutputToken() string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(buf)
}

func toolOutputStem(stem string) string {
	clean := strings.ToLower(sanitizeToolName(stem))
	if clean == "" {
		clean = "output"
	}
	return clean
}

func (h *handler) writeToolOutputFile(ctx context.Context, tenant, agent, stem string, data []byte) (string, bool) {
	remote, selected, err := h.remoteWorkspace(ctx, tenant, agent)
	if err != nil || !selected {
		return "", false
	}
	target := toolOutputDir + "/" + toolOutputStem(stem) + "-" + toolOutputToken() + ".txt"
	if _, err := remote.write(ctx, target, data); err != nil {
		return "", false
	}
	return toolOutputContainerRoot + target, true
}

func (h *handler) truncateToolText(ctx context.Context, tenant, agent, text, stem string) (string, error) {
	if len(text) <= toolOutputMaxBytes {
		return text, nil
	}
	if path, ok := h.writeToolOutputFile(ctx, tenant, agent, stem, []byte(text)); ok {
		omitted := len(text) - toolOutputHeadBytes - toolOutputTailBytes
		marker := "\n…[" + strconv.Itoa(omitted) + " chars truncated; full output: " + path + "]…\n"
		return text[:toolOutputHeadBytes] + marker + text[len(text)-toolOutputTailBytes:], nil
	}
	marker := "[output truncated; no workspace to store the full output]"
	return text[:toolOutputFallbackHead] + "\n…" + marker + "…\n" + text[len(text)-toolOutputFallbackTail:], nil
}

func (h *handler) capToolResultJSON(ctx context.Context, tenant, agent string, raw json.RawMessage, stem string) json.RawMessage {
	if len(raw) <= toolOutputMaxBytes {
		return raw
	}
	if !json.Valid(raw) {
		return raw
	}
	preview := string(raw)
	if len(preview) > toolOutputJSONPreviewSize {
		preview = preview[:toolOutputJSONPreviewSize]
	}
	fullPath := ""
	if path, ok := h.writeToolOutputFile(ctx, tenant, agent, stem, raw); ok {
		fullPath = path
	}
	out, err := json.Marshal(map[string]any{"truncated": true, "preview": preview, "fullOutputPath": fullPath})
	if err != nil {
		return raw
	}
	return out
}

// boundedToolTextPreview never writes an artifact. Sandbox results use this
// instead of the ordinary workspace spillover mechanism.
func boundedToolTextPreview(text string) string {
	if len(text) <= toolOutputMaxBytes {
		return text
	}
	return text[:toolOutputFallbackHead] + "\n…[output truncated; not persisted by sandbox policy]…\n" + text[len(text)-toolOutputFallbackTail:]
}
