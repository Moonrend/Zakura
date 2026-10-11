package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// A snapshot describes portable file contents and modes. Installing into an
// existing project additionally preserves that project's local ownership and
// directory access policy, which must not be replaced by private branch modes.
func (r *Repository) preserveProjectPermissions(ctx context.Context, baseID string, target Snapshot, original, stage string) error {
	base, err := r.readManifest(ctx, baseID, false)
	if err != nil {
		return err
	}
	renamedFrom := make(map[string]string)
	for _, change := range diffEntries(base.Entries, target.Entries) {
		if change.Kind == "rename" {
			renamedFrom[change.Path] = change.OldPath
		}
	}
	for _, entry := range target.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		sourcePath := entry.Path
		if old, exists := renamedFrom[entry.Path]; exists {
			sourcePath = old
		}
		info, err := os.Lstat(filepath.Join(original, filepath.FromSlash(sourcePath)))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err != nil || !info.Mode().IsRegular() {
			info, err = nearestDirectory(original, filepath.Dir(filepath.FromSlash(entry.Path)))
			if err != nil {
				return err
			}
		}
		file := filepath.Join(stage, filepath.FromSlash(entry.Path))
		if err = preserveOwner(file, info); err != nil {
			return err
		}
		// Chown can clear permission flags; target's portable mode is final.
		if err = os.Chmod(file, fs.FileMode(entry.Mode)); err != nil {
			return err
		}
		if err = syncFile(file); err != nil {
			return err
		}
	}
	directories := []string{}
	err = filepath.WalkDir(stage, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Apply access policy from children toward the root, after all file writes.
	for index := len(directories) - 1; index >= 0; index-- {
		if err := ctx.Err(); err != nil {
			return err
		}
		path := directories[index]
		rel, err := filepath.Rel(stage, path)
		if err != nil {
			return err
		}
		info, err := nearestDirectory(original, rel)
		if err != nil {
			return err
		}
		if err = preserveOwner(path, info); err != nil {
			return err
		}
		mode := info.Mode().Perm() | info.Mode()&os.ModeSetgid
		if err = os.Chmod(path, mode); err != nil {
			return err
		}
		if err = syncDir(path); err != nil {
			return err
		}
	}
	return nil
}

func nearestDirectory(root, relative string) (fs.FileInfo, error) {
	for {
		path := filepath.Join(root, relative)
		if !within(root, path) {
			return nil, ErrUnsafePath
		}
		if err := checkAncestors(path); err != nil {
			return nil, err
		}
		info, err := os.Lstat(path)
		if err == nil && info.IsDir() {
			return info, nil
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if relative == "." || relative == "" {
			return nil, ErrUnsafePath
		}
		relative = filepath.Dir(relative)
	}
}

func preserveOwner(path string, source fs.FileInfo) error {
	uid, gid, supported := fileOwner(source)
	if !supported {
		return nil
	}
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	currentUID, currentGID, known := fileOwner(current)
	if !known || currentUID != uid || currentGID != gid {
		return os.Chown(path, uid, gid)
	}
	return nil
}

func syncFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
