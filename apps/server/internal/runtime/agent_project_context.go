// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

const projectContextMaxBytes = 128 << 10

type agentProjectContext struct {
	text     string
	turnText string
	hooks    []projectHookPackage
	exec     func(context.Context, projectHookPackage, projectHookAction, projectHookInput) (string, error)
}

// loadAgentProjectContext deliberately never consults pinnedExecution. Project
// configuration and explicitly requested installed skills belong to the Space
// server, even when tools execute on a different computer.
func (h *handler) loadAgentProjectContext(ctx context.Context, tenant, space, agent, project string, requested []string, available []promptSkill) (*agentProjectContext, error) {
	out := &agentProjectContext{}
	var text strings.Builder
	appendSection := func(label, content string) error {
		if strings.TrimSpace(content) == "" {
			return nil
		}
		if text.Len()+len(label)+len(content)+8 > projectContextMaxBytes {
			return errors.New("project and requested skill context exceeds 128 KiB limit")
		}
		text.WriteString("\n\n# " + label + "\n")
		text.WriteString(content)
		return nil
	}
	project = strings.TrimPrefix(strings.TrimSpace(project), "projects/")
	projectNames := map[string]bool{}
	if project != "" {
		snapshot, err := h.projectRuntimeSnapshot(ctx, tenant, space, project)
		if err != nil {
			return nil, fmt.Errorf("load project context: %w", err)
		}
		if err := appendSection("Project conversation instructions (developer configuration)", mapStringValue(snapshot["conversationInstructions"])); err != nil {
			return nil, err
		}
		instructions, _ := snapshot["instructions"].(map[string]any)
		if err := appendSection("Project directory instructions: "+mapStringValue(instructions["file"])+" (developer configuration)", mapStringValue(instructions["content"])); err != nil {
			return nil, err
		}
		skills, _ := snapshot["skills"].([]map[string]any)
		for _, skill := range skills {
			name := mapStringValue(skill["name"])
			projectNames[name] = true
			if err := appendSection("Project skill: "+name+" ("+mapStringValue(skill["path"])+")", mapStringValue(skill["content"])); err != nil {
				return nil, err
			}
		}
		hooks, _ := snapshot["hooks"].(map[string]any)
		packages, err := parseProjectHookPackage("project", "", hooks["events"])
		if err != nil {
			return nil, err
		}
		out.hooks = append(out.hooks, packages...)
	}
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if record.SpaceID != space {
		return nil, ErrNotFound
	}
	packages, err := parseConfiguredHookPackages(configMap(record.Config)["hooks"])
	if err != nil {
		return nil, err
	}
	out.hooks = append(out.hooks, packages...)
	byName := map[string]promptSkill{}
	for _, skill := range available {
		byName[skill.Name] = skill
	}
	stableLen := text.Len()
	seen := map[string]bool{}
	for _, name := range requested {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] || projectNames[name] {
			continue
		}
		seen[name] = true
		skill, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("requested skill %q is not installed or enabled", name)
		}
		raw, err := h.readSpaceContextFile(ctx, tenant, space, skill.Path, projectContextMaxBytes)
		if err != nil {
			return nil, fmt.Errorf("read requested skill %q from Space server: %w", name, err)
		}
		if err := appendSection("Requested shared skill: "+name+" (developer configuration, loaded from Space server)", string(raw)); err != nil {
			return nil, err
		}
	}
	out.text = text.String()[:stableLen]
	out.turnText = text.String()[stableLen:]
	out.exec = func(ctx context.Context, pkg projectHookPackage, action projectHookAction, input projectHookInput) (string, error) {
		return h.executeProjectHook(ctx, tenant, space, project, pkg, action, input)
	}
	return out, nil
}

func (h *handler) readSpaceContextFile(ctx context.Context, tenant, space, name string, max int64) ([]byte, error) {
	name = strings.TrimPrefix(name, "/workspace/")
	name = strings.TrimPrefix(name, "/")
	if name == "" || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") {
		return nil, errors.New("invalid Space context file path")
	}
	if remote, selected, err := h.remoteSpaceWorkspace(ctx, tenant, space); err != nil {
		return nil, err
	} else if selected {
		raw, _, err := remote.read(ctx, "/"+name, max+1)
		if err == nil && int64(len(raw)) > max {
			err = errors.New("Space context file exceeds size limit")
		}
		return raw, err
	}
	fs, err := h.workspaceForSpace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(fs.root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return nil, errors.New("Space context file must be regular and within size limit")
	}
	raw, err := io.ReadAll(io.LimitReader(file, max+1))
	if err == nil && int64(len(raw)) > max {
		err = errors.New("Space context file exceeds size limit")
	}
	return raw, err
}

func runtimeLocalProjectReader(workspace, slug string) (projectConfigReader, func(), error) {
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return projectConfigReader{}, nil, err
	}
	project, err := root.OpenRoot("projects/" + slug)
	root.Close()
	if err != nil {
		return projectConfigReader{}, nil, err
	}
	read := func(name string) ([]byte, error) {
		file, err := project.Open(name)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > projectContextMaxBytes {
			return nil, errors.New("project config file must be regular and within 128 KiB")
		}
		raw, err := io.ReadAll(io.LimitReader(file, projectContextMaxBytes+1))
		if err == nil && len(raw) > projectContextMaxBytes {
			err = errors.New("project config file exceeds 128 KiB")
		}
		return raw, err
	}
	list := func(name string) ([]string, error) {
		file, err := project.Open(name)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		entries, err := file.ReadDir(257)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(entries) > 256 {
			return nil, errors.New("project skill directory exceeds 256 entries")
		}
		out := []string{}
		for _, entry := range entries {
			if entry.IsDir() {
				out = append(out, entry.Name())
			}
		}
		return out, nil
	}
	return projectConfigReader{read: read, list: list}, func() { project.Close() }, nil
}

// Hook data never becomes executable configuration: only actions parsed from
// the saved configuration reach exec. Tool arguments are passed as JSON stdin.
type projectHookInput struct {
	Event        string          `json:"hook_event_name"`
	Session      string          `json:"session_id"`
	Prompt       string          `json:"prompt,omitempty"`
	ToolName     string          `json:"tool_name,omitempty"`
	ToolInput    json.RawMessage `json:"tool_input,omitempty"`
	ToolResponse string          `json:"tool_response,omitempty"`
	ToolError    bool            `json:"is_error,omitempty"`
}
