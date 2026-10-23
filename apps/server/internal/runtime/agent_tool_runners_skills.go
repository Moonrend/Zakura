// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

func skillToolDefinitions() []agentTool {
	return []agentTool{
		directBuiltin("list_skills", "List installed skills available in this Space, with names and descriptions. Read a skill before following its instructions.", map[string]any{}),
		directBuiltin("read_skill", "Read an installed skill's instructions or supporting file. Use a name from list_skills. Files are scoped to that installed skill.", map[string]any{
			"name": map[string]any{"type": "string", "description": "Installed skill name."},
			"path": map[string]any{"type": "string", "description": "File path inside the skill. Default SKILL.md."},
		}, "name"),
	}
}

func (h *handler) runSkillTool(ctx context.Context, tenant, space, agent, name string, args json.RawMessage) (json.RawMessage, error) {
	var params struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, err
	}
	if _, err := h.store.GetSpace(ctx, tenant, space); err != nil {
		return nil, err
	}
	if err := h.canonicalizeSpaceSkills(ctx, tenant, space); err != nil {
		return nil, err
	}
	query := h.deps.Gorm.WithContext(ctx).Model(&spaceSkill{}).Where("tenant_id=? AND space_id=? AND status='installed'", tenant, space)
	if agent != "" {
		query = query.Where("EXISTS (SELECT 1 FROM agent_skills a JOIN agents g ON g.id=a.agent_id AND g.tenant_id=a.tenant_id WHERE a.tenant_id=space_skills.tenant_id AND g.space_id=space_skills.space_id AND a.agent_id=? AND a.skill_id=space_skills.skill_id AND a.name=space_skills.name AND a.enabled=?)", agent, true)
	}
	if name == "read_skill" {
		if strings.TrimSpace(params.Name) == "" {
			return nil, errors.New("skill name required")
		}
		query = query.Where("name=?", params.Name)
	}
	var rows []spaceSkill
	if err := query.Order("name").Find(&rows).Error; err != nil {
		return nil, err
	}
	items := []map[string]any{}
	for _, row := range rows {
		var files []skillFile
		if err := json.Unmarshal([]byte(row.FilesJSON), &files); err != nil {
			return nil, err
		}
		if name == "read_skill" {
			requested := params.Path
			if requested == "" {
				requested = "SKILL.md"
			}
			for _, file := range files {
				if file.Path == requested {
					return builtinJSON(file)
				}
			}
			return nil, ErrNotFound
		}
		description := ""
		for _, file := range files {
			if file.Path == "SKILL.md" {
				_, description = skillManifestMeta(file.Content, row.Name)
				break
			}
		}
		items = append(items, map[string]any{"name": row.Name, "description": description, "path": row.Path + "/SKILL.md"})
	}
	if name == "read_skill" {
		return nil, ErrNotFound
	}
	return builtinJSON(map[string]any{"skills": items})
}
