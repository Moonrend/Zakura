// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"fmt"
	"path"
	"strings"
)

const (
	attachmentImageMaxBytes = 5 << 20
	// Only the newest image-bearing user messages are sent as pixels; older
	// ones keep their text note so long sessions do not resend every image.
	attachmentImageMessages = 2
)

type chatAttachment struct {
	Name string
	Path string
	Mime string
	Size int64
	Kind string
}

func parseChatAttachments(raw any) []chatAttachment {
	list, _ := raw.([]any)
	out := []chatAttachment{}
	for _, item := range list {
		o, _ := item.(map[string]any)
		p, _ := o["path"].(string)
		if p == "" {
			continue
		}
		a := chatAttachment{Path: p, Mime: "application/octet-stream", Kind: "file"}
		a.Name, _ = o["name"].(string)
		if a.Name == "" {
			a.Name = path.Base(p)
		}
		if m, ok := o["mime"].(string); ok && m != "" {
			a.Mime = m
		}
		if n, ok := o["size"].(float64); ok {
			a.Size = int64(n)
		}
		if o["kind"] == "image" || (o["kind"] == nil && strings.HasPrefix(a.Mime, "image/")) {
			a.Kind = "image"
		}
		out = append(out, a)
		if len(out) >= 10 {
			break
		}
	}
	return out
}

// userChatMessage writes every attachment as a text note (the model can open
// any file with the workspace tools) and records image paths so they can be
// inlined as pixels before the model call.
func userChatMessage(content string, attachments []chatAttachment) chatMessage {
	msg := chatMessage{Role: "user", Content: content}
	if len(attachments) == 0 {
		return msg
	}
	var b strings.Builder
	b.WriteString(content)
	if content != "" {
		b.WriteString("\n\n")
	}
	fmt.Fprintf(&b, "[用户上传了 %d 个附件，位于工作区：]", len(attachments))
	for _, a := range attachments {
		fmt.Fprintf(&b, "\n- %s（%s，%s）", a.Path, a.Mime, formatBytes(a.Size))
		if a.Kind == "image" {
			msg.Images = append(msg.Images, a.Path)
		}
	}
	msg.Content = b.String()
	return msg
}

func formatBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%dB", n)
	case n < 1<<20:
		return fmt.Sprintf("%.1fKB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	}
}

func guessImageMime(p string) string {
	switch strings.ToLower(strings.TrimPrefix(path.Ext(p), ".")) {
	case "jpg", "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "bmp":
		return "image/bmp"
	}
	return "image/png"
}

type inlineImage struct {
	Mime string
	Data string
}

// resolveImages reads the images of the newest image-bearing user messages
// through reader. Unreadable files are skipped; their text note remains.
func resolveImages(ctx context.Context, messages []chatMessage, reader func(context.Context, string, int64) ([]byte, error)) map[string]inlineImage {
	if reader == nil {
		return nil
	}
	out := map[string]inlineImage{}
	budget := attachmentImageMessages
	for i := len(messages) - 1; i >= 0 && budget > 0; i-- {
		if messages[i].Role != "user" || len(messages[i].Images) == 0 {
			continue
		}
		budget--
		for _, p := range messages[i].Images {
			if _, ok := out[p]; ok {
				continue
			}
			data, err := reader(ctx, p, attachmentImageMaxBytes)
			if err != nil || len(data) == 0 || len(data) > attachmentImageMaxBytes {
				continue
			}
			out[p] = inlineImage{Mime: guessImageMime(p), Data: base64.StdEncoding.EncodeToString(data)}
		}
	}
	return out
}

// renderMessages converts the loop's messages to the OpenAI chat shape the
// gateway accepts for every protocol. Image parts use the Anthropic block
// shape when the upstream speaks Anthropic: the gateway passes user content
// through unchanged.
func renderMessages(system string, messages []chatMessage, images map[string]inlineImage, protocol string) []map[string]any {
	out := make([]map[string]any, 0, len(messages)+1)
	if system != "" {
		out = append(out, map[string]any{"role": "system", "content": system})
	}
	for _, m := range messages {
		switch m.Role {
		case "assistant":
			msg := map[string]any{"role": "assistant", "content": m.Content}
			if len(m.ToolCalls) > 0 {
				calls := make([]any, 0, len(m.ToolCalls))
				for _, c := range m.ToolCalls {
					calls = append(calls, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": defaultArgs(c.Arguments)}})
				}
				msg["tool_calls"] = calls
				if m.Content == "" {
					msg["content"] = nil
				}
			}
			out = append(out, msg)
		case "tool":
			out = append(out, map[string]any{"role": "tool", "tool_call_id": m.ToolCallID, "content": m.Content})
		default:
			parts := []any{}
			for _, p := range m.Images {
				img, ok := images[p]
				if !ok {
					continue
				}
				if protocol == "anthropic" {
					parts = append(parts, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": img.Mime, "data": img.Data}})
				} else {
					parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + img.Mime + ";base64," + img.Data}})
				}
			}
			if len(parts) == 0 {
				out = append(out, map[string]any{"role": m.Role, "content": m.Content})
				continue
			}
			content := append([]any{map[string]any{"type": "text", "text": m.Content}}, parts...)
			out = append(out, map[string]any{"role": m.Role, "content": content})
		}
	}
	return out
}
