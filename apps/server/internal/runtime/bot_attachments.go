// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

type botFileRef struct {
	FileID string `json:"fileId"`
}

func (h *handler) botAttachments(ctx context.Context, actor httpx.Principal, agent, binding string, refs []botFileRef) (json.RawMessage, error) {
	if len(refs) > 10 {
		return nil, errors.New("use at most 10 attachments per message")
	}
	files := []map[string]any{}
	seen := map[string]bool{}
	for _, ref := range refs {
		if ref.FileID == "" || seen[ref.FileID] {
			return nil, errors.New("invalid attachment reference")
		}
		seen[ref.FileID] = true
		var file models.ZakurabotFile
		if err := h.deps.Gorm.WithContext(ctx).Where("id=? AND tenant_id=? AND device_id=? AND binding_id=? AND agent_id=?", ref.FileID, actor.TenantID, actor.UserID, binding, agent).Take(&file).Error; err != nil {
			return nil, errors.New("attachment is unavailable in this conversation")
		}
		files = append(files, map[string]any{"id": ref.FileID, "path": file.Path, "name": file.Name, "mime": file.Mime, "size": file.Size, "kind": mediaKind(file.Mime)})
	}
	return json.Marshal(files)
}

func botPublicAttachments(baseURL, agent string, attachments json.RawMessage) []map[string]any {
	var files []map[string]any
	_ = json.Unmarshal(attachments, &files)
	out := []map[string]any{}
	for _, file := range files {
		id, _ := file["id"].(string)
		if id == "" {
			continue
		}
		out = append(out, map[string]any{"id": id, "name": file["name"], "mime": file["mime"], "size": file["size"], "type": file["kind"], "url": strings.TrimRight(baseURL, "/") + "/api/zakurabot/agents/" + url.PathEscape(agent) + "/files/" + url.PathEscape(id)})
	}
	return out
}
