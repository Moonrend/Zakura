// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// All skill IO is explicitly scoped to the Space server, never pinnedExecution.
type skillWorkspace struct {
	local  *os.Root
	remote *remoteWorkspace
}
type skillWorkspaceKey struct{}

func (h *handler) skillWorkspace(ctx context.Context, tenant, space string) (*skillWorkspace, error) {
	if cached, ok := ctx.Value(skillWorkspaceKey{}).(*skillWorkspace); ok {
		return cached, nil
	}
	s, err := h.store.GetSpace(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	if s.RuntimeNodeID != nil && *s.RuntimeNodeID != "" {
		runner, err := h.hub.get(*s.RuntimeNodeID)
		if err != nil {
			return nil, err
		}
		return &skillWorkspace{remote: &remoteWorkspace{runner: runner, spaceID: space}}, nil
	}
	base := os.Getenv("ZAKURA_WORKSPACE_ROOT")
	if base == "" {
		base = filepath.Join("data", "workspaces")
	}
	root := filepath.Join(base, tenant, space)
	if err = os.MkdirAll(root, 0750); err != nil {
		return nil, err
	}
	local, err := os.OpenRoot(root)
	return &skillWorkspace{local: local}, err
}
func (f *skillWorkspace) close() {
	if f.local != nil {
		_ = f.local.Close()
	}
}
func skillRelative(p string) string { return strings.TrimPrefix(p, "/") }
func (f *skillWorkspace) mkdir(ctx context.Context, p string) error {
	if f.local != nil {
		return f.local.MkdirAll(skillRelative(p), 0750)
	}
	params, _ := f.remote.pathParams(p)
	return f.remote.runner.call(ctx, "host.fs.mkdir", params, nil)
}
func (f *skillWorkspace) write(ctx context.Context, p string, b []byte) error {
	if err := f.mkdir(ctx, path.Dir(p)); err != nil {
		return err
	}
	if f.local != nil {
		return f.local.WriteFile(skillRelative(p), b, 0640)
	}
	_, err := f.remote.write(ctx, p, b)
	return err
}
func (f *skillWorkspace) rename(ctx context.Context, from, to string) error {
	if f.local != nil {
		return f.local.Rename(skillRelative(from), skillRelative(to))
	}
	params := map[string]any{"spaceId": f.remote.spaceID, "oldPath": from, "newPath": to}
	return f.remote.runner.call(ctx, "host.fs.rename", params, nil)
}
func (f *skillWorkspace) remove(ctx context.Context, p string) error {
	if f.local != nil {
		return f.local.RemoveAll(skillRelative(p))
	}
	params, _ := f.remote.pathParams(p)
	params["recursive"] = true
	return f.remote.runner.call(ctx, "host.fs.remove", params, nil)
}
func (f *skillWorkspace) exists(ctx context.Context, p string) (bool, error) {
	if f.local != nil {
		info, err := f.local.Lstat(skillRelative(p))
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return false, errors.New("skill directory cannot be a symlink")
		}
		return true, nil
	}
	// Listing the parent distinguishes a missing child from runner/permission errors.
	_, entries, err := f.remote.list(ctx, path.Dir(p))
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Name == path.Base(p) {
			return true, nil
		}
	}
	return false, nil
}
func (f *skillWorkspace) read(ctx context.Context, p string) ([]byte, error) {
	if f.local != nil {
		info, err := f.local.Lstat(skillRelative(p))
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > 512<<10 {
			return nil, errors.New("invalid skill file")
		}
		return f.local.ReadFile(skillRelative(p))
	}
	b, _, err := f.remote.read(ctx, p, (512<<10)+1)
	if len(b) > 512<<10 {
		return nil, errors.New("skill file too large")
	}
	return b, err
}
func (f *skillWorkspace) list(ctx context.Context, p string) ([]runnerFSEntry, error) {
	if f.local == nil {
		_, entries, err := f.remote.list(ctx, p)
		return entries, err
	}
	dir, err := f.local.Open(skillRelative(p))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	out := []runnerFSEntry{}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return nil, errors.New("skill symlinks are not supported")
		}
		out = append(out, runnerFSEntry{Name: entry.Name(), IsDir: entry.IsDir()})
	}
	return out, nil
}
func skillFileBytes(f skillFile) ([]byte, error) {
	switch f.Encoding {
	case "", "utf8":
		if !utf8.ValidString(f.Content) {
			return nil, errors.New("invalid UTF-8 skill file")
		}
		return []byte(f.Content), nil
	case "base64":
		b, err := base64.StdEncoding.DecodeString(f.Content)
		if err != nil {
			return nil, errors.New("invalid base64 skill file")
		}
		return b, nil
	default:
		return nil, errors.New("unsupported skill file encoding")
	}
}
func normalizeSkillFiles(files []skillFile) ([]skillFile, int64, error) {
	if len(files) == 0 || len(files) > 64 {
		return nil, 0, errors.New("skill must contain 1 to 64 files")
	}
	seen := map[string]bool{}
	var size int64
	out := make([]skillFile, 0, len(files))
	manifest := false
	for _, f := range files {
		if f.Path == "" || strings.HasPrefix(f.Path, "/") || path.Clean(f.Path) != f.Path || f.Path == "." || f.Path == ".." || strings.HasPrefix(f.Path, "../") || strings.ContainsAny(f.Path, "\\\x00:") {
			return nil, 0, errors.New("invalid skill file path")
		}
		key := strings.ToLower(f.Path)
		if seen[key] {
			return nil, 0, errors.New("duplicate skill file path")
		}
		seen[key] = true
		b, err := skillFileBytes(f)
		if err != nil {
			return nil, 0, err
		}
		if len(b) > 512<<10 {
			return nil, 0, errors.New("skill file exceeds 512 KiB")
		}
		size += int64(len(b))
		if size > 4<<20 {
			return nil, 0, errors.New("skill exceeds 4 MiB")
		}
		if f.Encoding == "" {
			f.Encoding = "utf8"
		}
		f.Size = len(b)
		out = append(out, f)
		if f.Path == "SKILL.md" {
			if f.Encoding != "utf8" {
				return nil, 0, errors.New("SKILL.md must be UTF-8")
			}
			manifest = true
		}
	}
	for name := range seen {
		for p := path.Dir(name); p != "."; p = path.Dir(p) {
			if seen[p] {
				return nil, 0, errors.New("skill file conflicts with directory")
			}
		}
	}
	if !manifest {
		return nil, 0, errors.New("SKILL.md is required at skill root")
	}
	return out, size, nil
}

// Stage a complete replacement. A failed DB write invokes rollback; only a
// committed snapshot discards the old directory. Removed upstream files vanish.
func (h *handler) stageSkill(ctx context.Context, tenant, space, name string, files []skillFile, replace, remove bool) (func(bool) error, error) {
	if name == "" || name != slugify(name) {
		return nil, errors.New("invalid skill name")
	}
	ctx, finishWrite, err := h.claimSharedWorkspaceWrite(ctx, tenant, space)
	if err != nil {
		return nil, err
	}
	f, err := h.skillWorkspace(ctx, tenant, space)
	if err != nil {
		finishWrite(nil)
		return nil, err
	}
	// A failed mutating RPC is ambiguous even if a later compensation succeeds.
	// Nested claims only record this cause; their owner persists it after the DB
	// transaction has ended, avoiding a second connection taking its Space lock.
	var uncertain error
	mutate := func(operation func() error) error {
		err := operation()
		if err != nil && f.remote != nil {
			uncertain = errors.Join(uncertain, err)
		}
		return err
	}
	fail := func(cause error) (func(bool) error, error) {
		f.close()
		finishWrite(uncertain)
		return nil, cause
	}
	if err = mutate(func() error { return f.mkdir(ctx, "/skills") }); err != nil {
		return fail(err)
	}
	target := "/skills/" + name
	exists, err := f.exists(ctx, target)
	if err != nil {
		return fail(err)
	}
	if exists && !replace {
		return fail(errSkillConflict)
	}
	stage := "/skills/.stage-" + h.store.id()
	backup := "/skills/.backup-" + h.store.id()
	cleanup := context.WithoutCancel(ctx)
	removeStage := func() error {
		if remove {
			return nil
		}
		return mutate(func() error { return f.remove(cleanup, stage) })
	}
	if !remove {
		if err = mutate(func() error { return f.mkdir(ctx, stage) }); err != nil {
			return fail(errors.Join(err, removeStage()))
		}
		for _, file := range files {
			b, e := skillFileBytes(file)
			if e == nil {
				e = mutate(func() error { return f.write(ctx, path.Join(stage, file.Path), b) })
			}
			if e != nil {
				return fail(errors.Join(e, removeStage()))
			}
		}
	}
	if exists {
		if err = mutate(func() error { return f.rename(ctx, target, backup) }); err != nil {
			return fail(errors.Join(err, removeStage()))
		}
	}
	if !remove {
		if err = mutate(func() error { return f.rename(ctx, stage, target) }); err != nil {
			if exists {
				err = errors.Join(err, mutate(func() error { return f.rename(cleanup, backup, target) }))
			}
			return fail(errors.Join(err, removeStage()))
		}
	}
	var once sync.Once
	var finishErr error
	return func(commit bool) error {
		once.Do(func() {
			defer f.close()
			defer func() { finishWrite(uncertain) }()
			if commit {
				if exists {
					finishErr = mutate(func() error { return f.remove(cleanup, backup) })
				}
				return
			}
			if !remove {
				if err := mutate(func() error { return f.remove(cleanup, target) }); err != nil {
					finishErr = fmt.Errorf("rollback new skill: %w", err)
					return
				}
			}
			if exists {
				finishErr = mutate(func() error { return f.rename(cleanup, backup, target) })
			}
		})
		return finishErr
	}, nil
}
func (h *handler) materializeSkill(ctx context.Context, tenant, agent, name string, filesJSON json.RawMessage) error {
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return err
	}
	var files []skillFile
	if err = json.Unmarshal(filesJSON, &files); err != nil {
		return err
	}
	files, _, err = normalizeSkillFiles(files)
	if err != nil {
		return err
	}
	finish, err := h.stageSkill(ctx, tenant, a.SpaceID, name, files, true, false)
	if err != nil {
		return err
	}
	return finish(true)
}
