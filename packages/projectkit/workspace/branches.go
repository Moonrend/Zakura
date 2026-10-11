package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func (r *Repository) branchPath(id string) (string, error) {
	if !validBranch(id) {
		return "", ErrUnsafePath
	}
	return filepath.Join(r.root, "branches", id+".json"), nil
}

func (r *Repository) getBranch(ctx context.Context, id string) (Branch, error) {
	if err := ctx.Err(); err != nil {
		return Branch{}, err
	}
	path, err := r.branchPath(id)
	if err != nil {
		return Branch{}, err
	}
	var branch Branch
	if err = loadJSON(path, &branch); err != nil {
		return Branch{}, err
	}
	if branch.ID != id || !validHash(branch.Base) || !validHash(branch.Head) || branch.Generation < 1 || branch.UpdatedAt.IsZero() {
		return Branch{}, ErrCorrupt
	}
	if _, err = r.readManifest(ctx, branch.Head, false); err != nil {
		return Branch{}, err
	}
	return branch, nil
}

func (r *Repository) GetBranch(ctx context.Context, id string) (branch Branch, err error) {
	err = r.locked(ctx, func() error { branch, err = r.getBranch(ctx, id); return err })
	return
}

func (r *Repository) listBranches(ctx context.Context) ([]Branch, error) {
	entries, err := os.ReadDir(filepath.Join(r.root, "branches"))
	if err != nil {
		return nil, err
	}
	branches := []Branch{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		branch, err := r.getBranch(ctx, strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		branches = append(branches, branch)
	}
	sort.Slice(branches, func(i, j int) bool { return branches[i].ID < branches[j].ID })
	return branches, nil
}

func (r *Repository) ListBranches(ctx context.Context) (branches []Branch, err error) {
	err = r.locked(ctx, func() error { branches, err = r.listBranches(ctx); return err })
	return
}

func (r *Repository) branchRoot(ctx context.Context, id string) (string, error) {
	if _, err := r.getBranch(ctx, id); err != nil {
		return "", err
	}
	root := filepath.Join(r.root, "worktrees", id)
	if err := checkAncestors(root); err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", ErrCorrupt
	}
	return root, nil
}

func (r *Repository) BranchRoot(ctx context.Context, id string) (root string, err error) {
	err = r.locked(ctx, func() error { root, err = r.branchRoot(ctx, id); return err })
	return
}

func (r *Repository) CreateBranch(ctx context.Context, id, baseID string) (branch Branch, err error) {
	err = r.locked(ctx, func() error {
		path, e := r.branchPath(id)
		if e != nil {
			return e
		}
		if _, e = os.Lstat(path); e == nil {
			return ErrConflict
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		base, e := r.getSnapshot(ctx, baseID)
		if e != nil {
			return e
		}
		root := filepath.Join(r.root, "worktrees", id)
		if _, e = os.Lstat(root); e == nil {
			return ErrConflict
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		branch = Branch{ID: id, Base: base.ID, Head: base.ID, Generation: 1, UpdatedAt: time.Now().UTC()}
		_, e = r.apply(ctx, "", base, root, &branch, "", false)
		return e
	})
	return
}

func (r *Repository) CaptureBranch(ctx context.Context, id, expectedHead string) (snapshot Snapshot, err error) {
	err = r.locked(ctx, func() error {
		branch, e := r.getBranch(ctx, id)
		if e != nil {
			return e
		}
		if expectedHead == "" || branch.Head != expectedHead {
			return ErrConflict
		}
		root, e := r.branchRoot(ctx, id)
		if e != nil {
			return e
		}
		snapshot, e = r.capture(ctx, root)
		if e != nil {
			return e
		}
		branch.Head = snapshot.ID
		branch.Generation++
		branch.UpdatedAt = time.Now().UTC()
		path, _ := r.branchPath(id)
		return atomicJSON(path, branch)
	})
	return
}

func (r *Repository) DeleteBranch(ctx context.Context, id, expectedHead string) error {
	return r.locked(ctx, func() error {
		branch, err := r.getBranch(ctx, id)
		if err != nil {
			return err
		}
		if branch.Head != expectedHead || expectedHead == "" {
			return ErrConflict
		}
		root, err := r.branchRoot(ctx, id)
		if err != nil {
			return err
		}
		journal, err := r.newJournal(root, branch.Head, branch.Head, &branch, expectedHead)
		if err != nil {
			return err
		}
		journal.Kind = "delete-branch"
		if err = r.saveJournal(journal); err != nil {
			return err
		}
		return r.finishDelete(ctx, journal)
	})
}

func (r *Repository) scopedPath(ctx context.Context, branch, path string) (string, string, error) {
	root, err := r.branchRoot(ctx, branch)
	if err != nil {
		return "", "", err
	}
	if validatePath(path) != nil || len(path) > r.opts.MaxPathBytes {
		return "", "", ErrUnsafePath
	}
	resolved := filepath.Join(root, filepath.FromSlash(path))
	if !within(root, resolved) {
		return "", "", ErrUnsafePath
	}
	if err = checkAncestors(resolved); err != nil {
		return "", "", err
	}
	return root, resolved, nil
}

func (r *Repository) branchFiles(ctx context.Context, root string) ([]Entry, error) {
	entries := []Entry{}
	total := int64(0)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return ErrUnsafePath
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return ErrUnsafePath
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if validatePath(rel) != nil || len(rel) > r.opts.MaxPathBytes {
			return ErrUnsafePath
		}
		if len(entries) >= r.opts.MaxFiles || info.Size() > r.opts.MaxFileBytes || info.Size() > r.opts.MaxTotalBytes-total {
			return ErrLimit
		}
		total += info.Size()
		entries = append(entries, Entry{Path: rel, Size: info.Size(), Mode: uint32(info.Mode().Perm())})
		return nil
	})
	return entries, err
}

func (r *Repository) List(ctx context.Context, branch, path string) (entries []Entry, err error) {
	err = r.locked(ctx, func() error {
		root, e := r.branchRoot(ctx, branch)
		if e != nil {
			return e
		}
		if path != "" && (validatePath(path) != nil || len(path) > r.opts.MaxPathBytes) {
			return ErrUnsafePath
		}
		all, e := r.branchFiles(ctx, root)
		if e != nil {
			return e
		}
		entries = []Entry{}
		for _, entry := range all {
			if path == "" || entry.Path == path || strings.HasPrefix(entry.Path, path+"/") {
				entries = append(entries, entry)
			}
		}
		return nil
	})
	return
}

func (r *Repository) Read(ctx context.Context, branch, path string) (data []byte, err error) {
	err = r.locked(ctx, func() error {
		_, file, e := r.scopedPath(ctx, branch, path)
		if e != nil {
			return e
		}
		info, e := os.Lstat(file)
		if errors.Is(e, os.ErrNotExist) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return ErrUnsafePath
		}
		if info.Size() > r.opts.MaxFileBytes {
			return ErrLimit
		}
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		defer f.Close()
		opened, e := f.Stat()
		if e != nil {
			return e
		}
		if !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
			return ErrConflict
		}
		data, e = io.ReadAll(io.LimitReader(f, r.opts.MaxFileBytes+1))
		if int64(len(data)) > r.opts.MaxFileBytes {
			return ErrLimit
		}
		return e
	})
	return
}

func (r *Repository) Write(ctx context.Context, branch, path string, content []byte, mode uint32) error {
	return r.locked(ctx, func() error {
		root, file, err := r.scopedPath(ctx, branch, path)
		if err != nil {
			return err
		}
		if int64(len(content)) > r.opts.MaxFileBytes || mode > 0777 {
			return ErrLimit
		}
		if mode == 0 {
			mode = 0644
		}
		if mode&0400 == 0 {
			return ErrUnsafePath
		}
		oldSize := int64(0)
		if info, e := os.Lstat(file); e == nil {
			if !info.Mode().IsRegular() {
				return ErrUnsafePath
			}
			oldSize = info.Size()
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		entries, err := r.branchFiles(ctx, root)
		if err != nil {
			return err
		}
		total := int64(0)
		exists := false
		for _, entry := range entries {
			total += entry.Size
			if entry.Path == path {
				exists = true
			}
		}
		if !exists && len(entries) >= r.opts.MaxFiles || int64(len(content)) > r.opts.MaxTotalBytes-(total-oldSize) {
			return ErrLimit
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return atomicBytesIn(filepath.Join(r.root, "tmp"), file, content, fs.FileMode(mode))
	})
}

func (r *Repository) Remove(ctx context.Context, branch, path string) error {
	return r.locked(ctx, func() error {
		root, file, err := r.scopedPath(ctx, branch, path)
		if err != nil {
			return err
		}
		if _, err = r.branchFiles(ctx, root); err != nil {
			return err
		}
		if _, err = os.Lstat(file); errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if err = os.RemoveAll(file); err != nil {
			return err
		}
		return syncDir(filepath.Dir(file))
	})
}

func (r *Repository) Rename(ctx context.Context, branch, oldPath, newPath string) error {
	return r.locked(ctx, func() error {
		root, from, err := r.scopedPath(ctx, branch, oldPath)
		if err != nil {
			return err
		}
		_, to, err := r.scopedPath(ctx, branch, newPath)
		if err != nil {
			return err
		}
		if within(from, to) {
			return fmt.Errorf("%w: destination is inside source", ErrUnsafePath)
		}
		if _, err = os.Lstat(to); err == nil {
			return ErrConflict
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		entries, err := r.branchFiles(ctx, root)
		if err != nil {
			return err
		}
		found := false
		for _, entry := range entries {
			if entry.Path == oldPath || strings.HasPrefix(entry.Path, oldPath+"/") {
				found = true
				target := newPath + strings.TrimPrefix(entry.Path, oldPath)
				if validatePath(target) != nil || len(target) > r.opts.MaxPathBytes {
					return ErrUnsafePath
				}
			}
		}
		if !found {
			if _, err = os.Lstat(from); err != nil {
				return ErrNotFound
			}
		}
		if err = os.MkdirAll(filepath.Dir(to), 0700); err != nil {
			return err
		}
		if err = os.Rename(from, to); err != nil {
			return err
		}
		if err = syncDir(filepath.Dir(from)); err != nil {
			return err
		}
		return syncDir(filepath.Dir(to))
	})
}
