// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"gorm.io/gorm"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

var projectSkillRoots = []string{".agents/skills", ".claude/skills", ".zakura/skills"}
var projectHookFiles = []string{".agents/hooks.json", ".claude/settings.json", ".zakura/hooks.json"}

type projectConfigReader struct {
	read func(string) ([]byte, error)
	list func(string) ([]string, error)
}

func localProjectReader(dir string) projectConfigReader {
	return projectConfigReader{
		read: func(name string) ([]byte, error) {
			root, err := os.OpenRoot(dir)
			if err != nil {
				return nil, err
			}
			defer root.Close()
			return root.ReadFile(name)
		},
		list: func(name string) ([]string, error) {
			root, err := os.OpenRoot(dir)
			if err != nil {
				return nil, err
			}
			defer root.Close()
			f, err := root.Open(name)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			entries, err := f.ReadDir(-1)
			if err != nil {
				return nil, err
			}
			out := []string{}
			for _, entry := range entries {
				if entry.IsDir() {
					out = append(out, entry.Name())
				}
			}
			return out, nil
		},
	}
}
func (r *remoteWorkspace) projectReader(ctx context.Context, slug string) projectConfigReader {
	return projectConfigReader{read: func(name string) ([]byte, error) {
		raw, _, err := r.read(ctx, projectRemotePath(slug, name), 1<<20)
		return raw, err
	}, list: func(name string) ([]string, error) {
		_, entries, err := r.list(ctx, projectRemotePath(slug, name))
		out := []string{}
		for _, entry := range entries {
			if entry.IsDir {
				out = append(out, path.Base(entry.Path))
			}
		}
		return out, err
	}}
}
func projectSnapshotFromReader(slug string, reader projectConfigReader) map[string]any {
	instructions := map[string]any{"file": nil, "content": "", "claudeFallback": false}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		if raw, err := reader.read(name); err == nil {
			instructions["file"], instructions["content"], instructions["claudeFallback"] = name, string(raw), name == "CLAUDE.md"
			break
		}
	}
	sources := []map[string]any{}
	events := map[string]any{}
	var hookFile any
	for _, name := range projectHookFiles {
		raw, err := reader.read(name)
		if err != nil {
			continue
		}
		source := map[string]any{}
		if json.Unmarshal(raw, &source) != nil {
			continue
		}
		if name == ".claude/settings.json" {
			source, _ = source["hooks"].(map[string]any)
			if source == nil {
				continue
			}
		}
		// Edit only the highest-priority file. Display lower-priority sources, but
		// never write merged events back over them or duplicate hooks on each save.
		if hookFile == nil {
			hookFile = name
			events = source
		}
		sources = append(sources, map[string]any{"file": name, "events": source})
	}
	skills := []map[string]any{}
	seen := map[string]bool{}
	for _, dir := range projectSkillRoots {
		names, _ := reader.list(dir)
		for _, name := range names {
			if seen[name] {
				continue
			}
			file := path.Join(dir, name, "SKILL.md")
			raw, err := reader.read(file)
			if err != nil {
				continue
			}
			seen[name] = true
			description := ""
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") {
					description = line
					break
				}
			}
			skills = append(skills, map[string]any{"name": name, "title": name, "description": description, "path": file})
		}
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i]["name"].(string) < skills[j]["name"].(string) })
	return map[string]any{"slug": slug, "exists": true, "instructions": instructions, "skills": skills, "hooks": map[string]any{"file": hookFile, "events": events, "sources": sources}}
}
func projectSkillDirectory(reader projectConfigReader, name string) string {
	for _, root := range projectSkillRoots {
		if _, err := reader.read(path.Join(root, name, "SKILL.md")); err == nil {
			return path.Join(root, name)
		}
	}
	return path.Join(projectSkillRoots[0], name)
}
func (h *handler) requestProjectSkillDirectory(rctx context.Context, remote *remoteWorkspace, slug, dir, name string) string {
	reader := localProjectReader(dir)
	if remote != nil {
		reader = remote.projectReader(rctx, slug)
	}
	return projectSkillDirectory(reader, name)
}
func projectHooksContent(reader projectConfigReader, file string, events map[string]any) ([]byte, error) {
	valid := false
	for _, name := range projectHookFiles {
		if file == name {
			valid = true
		}
	}
	if !valid {
		return nil, errors.New("unsupported project hooks file")
	}
	if file == ".claude/settings.json" {
		value := map[string]any{}
		if raw, err := reader.read(file); err == nil {
			if err = json.Unmarshal(raw, &value); err != nil {
				return nil, err
			}
		} else if !workspaceMissing(err) {
			return nil, err
		}
		value["hooks"] = events
		return json.MarshalIndent(value, "", "  ")
	}
	return json.MarshalIndent(events, "", "  ")
}
func (h *handler) projectRuntimeSnapshot(ctx context.Context, tenant, space, slug string) (map[string]any, error) {
	if slug == "" || slug != slugify(slug) {
		return nil, ErrNotFound
	}
	var project models.SpaceProject
	if err := h.deps.Gorm.WithContext(ctx).Where("tenant_id=? AND space_id=? AND slug=?", tenant, space, slug).Take(&project).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = ErrNotFound
		}
		return nil, err
	}
	if !project.HasWorkspace {
		return runtimeProjectSnapshot(slug, projectConfigReader{
			read: func(string) ([]byte, error) { return nil, os.ErrNotExist },
			list: func(string) ([]string, error) { return nil, os.ErrNotExist },
		}, project.Instructions)
	}
	var reader projectConfigReader
	if remote, selected, err := h.remoteSpaceWorkspace(ctx, tenant, space); err != nil {
		return nil, err
	} else if selected {
		reader = remote.projectReader(ctx, slug)
	} else {
		fs, err := h.workspaceForSpace(ctx, tenant, space)
		if err != nil {
			return nil, err
		}
		reader, closeReader, err := runtimeLocalProjectReader(fs.root, slug)
		if err != nil {
			return nil, err
		}
		defer closeReader()
		snapshot, err := runtimeProjectSnapshot(slug, reader, project.Instructions)
		return snapshot, err
	}
	return runtimeProjectSnapshot(slug, reader, project.Instructions)
}

func runtimeProjectSnapshot(slug string, reader projectConfigReader, conversation string) (map[string]any, error) {
	var readErr error
	readBytes := 0
	checked := projectConfigReader{
		read: func(name string) ([]byte, error) {
			if readErr != nil {
				return nil, readErr
			}
			raw, err := reader.read(name)
			if err != nil && !workspaceMissing(err) {
				readErr = err
			}
			if err == nil {
				for _, hookFile := range projectHookFiles {
					if name == hookFile {
						var value map[string]any
						if json.Unmarshal(raw, &value) != nil || value == nil {
							readErr = errors.New("invalid project hooks JSON in " + name)
							return nil, readErr
						}
					}
				}
			}
			readBytes += len(raw)
			if len(raw) > projectContextMaxBytes || readBytes > 1<<20 {
				readErr = errors.New("project runtime configuration exceeds size limit")
				return nil, readErr
			}
			return raw, err
		},
		list: func(name string) ([]string, error) {
			names, err := reader.list(name)
			if err != nil && !workspaceMissing(err) {
				readErr = err
			}
			if len(names) > 256 {
				readErr = errors.New("project skill directory exceeds 256 entries")
				return nil, readErr
			}
			return names, err
		},
	}
	snapshot := projectSnapshotFromReader(slug, checked)
	if readErr != nil {
		return nil, readErr
	}
	for _, skill := range snapshot["skills"].([]map[string]any) {
		raw, err := checked.read(skill["path"].(string))
		if err != nil {
			return nil, err
		}
		skill["content"] = string(raw)
	}
	snapshot["conversationInstructions"] = conversation
	return snapshot, nil
}

func writeProjectFile(dir, name string, raw []byte) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.MkdirAll(filepath.Dir(name), 0o750); err != nil {
		return err
	}
	// os.Root refuses symlinks escaping the project. All config paths are
	// controlled relative names; write inside that root rather than joining an
	// untrusted project symlink into the control-plane filesystem.
	return root.WriteFile(name, raw, 0o640)
}
