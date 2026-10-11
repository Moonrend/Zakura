package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type journal struct {
	Version      int       `json:"version"`
	ID           string    `json:"id"`
	Kind         string    `json:"kind"`
	Directory    string    `json:"directory"`
	Stage        string    `json:"stage"`
	Backup       string    `json:"backup"`
	Base         string    `json:"base"`
	Target       string    `json:"target"`
	Branch       *Branch   `json:"branch,omitempty"`
	ExpectedHead string    `json:"expectedHead,omitempty"`
	Existing     bool      `json:"existing"`
	Phase        string    `json:"phase"`
	CreatedAt    time.Time `json:"createdAt"`
}

func (r *Repository) newJournal(directory, base, target string, branch *Branch, expected string) (journal, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return journal{}, err
	}
	id := hex.EncodeToString(bytes)
	parent := filepath.Dir(directory)
	return journal{Version: 1, ID: id, Kind: "apply", Directory: directory,
		Stage: filepath.Join(parent, ".zakura-stage-"+id), Backup: filepath.Join(parent, ".zakura-backup-"+id),
		Base: base, Target: target, Branch: branch, ExpectedHead: expected, Existing: base != "", Phase: "prepared", CreatedAt: time.Now().UTC()}, nil
}

func (r *Repository) saveJournal(j journal) error {
	return atomicJSON(filepath.Join(r.root, "journals", j.ID+".json"), j)
}

func (r *Repository) validateJournal(ctx context.Context, j journal) error {
	if j.Version != 1 || len(j.ID) != 32 || strings.Trim(j.ID, "0123456789abcdef") != "" || (j.Kind != "apply" && j.Kind != "delete-branch") {
		return ErrCorrupt
	}
	if !filepath.IsAbs(j.Directory) || filepath.Clean(j.Directory) != j.Directory || j.Directory == string(filepath.Separator) {
		return ErrCorrupt
	}
	parent := filepath.Dir(j.Directory)
	if j.Stage != filepath.Join(parent, ".zakura-stage-"+j.ID) || j.Backup != filepath.Join(parent, ".zakura-backup-"+j.ID) {
		return ErrCorrupt
	}
	if j.Phase != "preparing" && j.Phase != "prepared" && j.Phase != "backed-up" && j.Phase != "installed" && j.Phase != "committed" {
		return ErrCorrupt
	}
	if j.Existing != (j.Base != "") || j.CreatedAt.IsZero() {
		return ErrCorrupt
	}
	if j.Base != "" {
		if _, err := r.getSnapshot(ctx, j.Base); err != nil {
			return err
		}
	}
	if _, err := r.getSnapshot(ctx, j.Target); err != nil {
		return err
	}
	if j.Branch != nil {
		if !validBranch(j.Branch.ID) || j.Directory != filepath.Join(r.root, "worktrees", j.Branch.ID) || j.Branch.Head != j.Target || j.Branch.Generation < 1 || j.Branch.UpdatedAt.IsZero() {
			return ErrCorrupt
		}
		if !validHash(j.Branch.Base) {
			return ErrCorrupt
		}
	} else if within(r.root, j.Directory) || within(j.Directory, r.root) {
		return ErrUnsafePath
	}
	for _, path := range []string{j.Directory, j.Stage, j.Backup} {
		if err := checkAncestors(path); err != nil {
			return err
		}
	}
	return nil
}

func existsDir(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, ErrUnsafePath
	}
	return true, nil
}

func (r *Repository) removeJournal(j journal) error {
	if err := os.Remove(filepath.Join(r.root, "journals", j.ID+".json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Join(r.root, "journals"))
}

func (r *Repository) materialize(ctx context.Context, snapshot Snapshot, root string) error {
	if err := checkAncestors(root); err != nil {
		return err
	}
	if err := os.Mkdir(root, 0700); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(root)
		}
	}()
	for _, entry := range snapshot.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := r.readObject(entry.Hash, entry.Size)
		if err != nil {
			return err
		}
		file := filepath.Join(root, filepath.FromSlash(entry.Path))
		if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			return err
		}
		if err = atomicBytes(file, data, os.FileMode(entry.Mode)); err != nil {
			return err
		}
	}
	if err := syncTree(root); err != nil {
		return err
	}
	complete = true
	return nil
}

func syncTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return syncDir(path)
		}
		return nil
	})
}

func (r *Repository) apply(ctx context.Context, base string, target Snapshot, directory string, branch *Branch, expected string, allowEmpty bool) (ApplyResult, error) {
	if err := ctx.Err(); err != nil {
		return ApplyResult{}, err
	}
	if err := checkAncestors(directory); err != nil {
		return ApplyResult{}, err
	}
	hasRoot, err := existsDir(directory)
	if err != nil {
		return ApplyResult{}, err
	}
	if base == "" {
		if hasRoot {
			if !allowEmpty {
				return ApplyResult{}, ErrConflict
			}
			files, err := os.ReadDir(directory)
			if err != nil {
				return ApplyResult{}, err
			}
			if len(files) != 0 {
				return ApplyResult{}, ErrConflict
			}
			// Preserve an existing empty directory until the journaled swap. A
			// failed or cancelled preparation must not remove caller-owned paths.
			empty, err := r.saveSnapshot(ctx, []Entry{})
			if err != nil {
				return ApplyResult{}, err
			}
			base = empty.ID
		}
	} else {
		if !hasRoot {
			return ApplyResult{}, ErrConflict
		}
		actual, err := r.capture(ctx, directory)
		if err != nil {
			return ApplyResult{}, err
		}
		if actual.ID != base {
			return ApplyResult{}, ErrConflict
		}
	}
	j, err := r.newJournal(directory, base, target.ID, branch, expected)
	if err != nil {
		return ApplyResult{}, err
	}
	// Record staging ownership before creating any files, so a process crash
	// during materialization leaves a discoverable, safely removable tree.
	j.Phase = "preparing"
	if err = r.saveJournal(j); err != nil {
		return ApplyResult{}, err
	}
	rollbackPreparation := func(cause error) (ApplyResult, error) {
		if cleanupErr := os.RemoveAll(j.Stage); cleanupErr != nil {
			return ApplyResult{}, errors.Join(cause, cleanupErr)
		}
		if cleanupErr := r.removeJournal(j); cleanupErr != nil {
			return ApplyResult{}, errors.Join(cause, cleanupErr)
		}
		return ApplyResult{}, cause
	}
	if err = r.materialize(ctx, target, j.Stage); err != nil {
		return rollbackPreparation(err)
	}
	if hasRoot && branch == nil {
		if err = r.preserveProjectPermissions(ctx, base, target, directory, j.Stage); err != nil {
			return rollbackPreparation(err)
		}
	}
	if err = ctx.Err(); err != nil {
		return rollbackPreparation(err)
	}
	if hasRoot {
		actual, err := r.capture(ctx, directory)
		if err != nil || actual.ID != base {
			if err != nil {
				return rollbackPreparation(err)
			}
			return rollbackPreparation(ErrConflict)
		}
	}
	j.Phase = "prepared"
	if err = r.saveJournal(j); err != nil {
		return rollbackPreparation(err)
	}
	// Once prepared, finish or leave a durable journal; cancellation cannot cause
	// an unrecorded partial installation.
	return r.finishApply(context.WithoutCancel(ctx), j, true)
}

func (r *Repository) commitJournalBranch(ctx context.Context, j journal) error {
	if j.Branch == nil {
		return nil
	}
	path, err := r.branchPath(j.Branch.ID)
	if err != nil {
		return err
	}
	var current Branch
	err = loadJSON(path, &current)
	if j.ExpectedHead == "" {
		if err == nil {
			if current == *j.Branch {
				return nil
			}
			return ErrConflict
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
	} else {
		if err != nil {
			return err
		}
		if current == *j.Branch {
			return nil
		}
		if current.Head != j.ExpectedHead || current.Generation+1 != j.Branch.Generation {
			return ErrConflict
		}
	}
	return atomicJSON(path, j.Branch)
}

func (r *Repository) finishApply(ctx context.Context, j journal, fresh bool) (ApplyResult, error) {
	if err := r.validateJournal(ctx, j); err != nil {
		return ApplyResult{}, err
	}
	if j.Phase == "preparing" {
		if err := os.RemoveAll(j.Stage); err != nil {
			return ApplyResult{}, err
		}
		if err := r.removeJournal(j); err != nil {
			return ApplyResult{}, err
		}
		result := ApplyResult{JournalID: j.ID}
		if j.Base != "" {
			base, err := r.getSnapshot(ctx, j.Base)
			result.Snapshot = base
			return result, err
		}
		return result, nil
	}
	hasRoot, err := existsDir(j.Directory)
	if err != nil {
		return ApplyResult{}, err
	}
	hasStage, err := existsDir(j.Stage)
	if err != nil {
		return ApplyResult{}, err
	}
	hasBackup, err := existsDir(j.Backup)
	if err != nil {
		return ApplyResult{}, err
	}
	if j.Existing && hasRoot && hasStage && !hasBackup {
		if !fresh {
			// No swap occurred. Roll back the prepared intent without touching the
			// original tree, which might have changed since the process stopped.
			if err = os.RemoveAll(j.Stage); err != nil {
				return ApplyResult{}, err
			}
			if err = r.removeJournal(j); err != nil {
				return ApplyResult{}, err
			}
			base, err := r.getSnapshot(ctx, j.Base)
			return ApplyResult{JournalID: j.ID, Snapshot: base}, err
		}
		if err = os.Rename(j.Directory, j.Backup); err != nil {
			return ApplyResult{}, err
		}
		if err = syncDir(filepath.Dir(j.Directory)); err != nil {
			return ApplyResult{}, err
		}
		hasRoot, hasBackup = false, true
		j.Phase = "backed-up"
		if err = r.saveJournal(j); err != nil {
			return ApplyResult{}, err
		}
	}
	if hasRoot && hasStage {
		return ApplyResult{}, ErrCorrupt
	}
	if !hasRoot && hasStage {
		if j.Existing && !hasBackup {
			return ApplyResult{}, ErrCorrupt
		}
		if err = os.Rename(j.Stage, j.Directory); err != nil {
			return ApplyResult{}, err
		}
		if err = syncDir(filepath.Dir(j.Directory)); err != nil {
			return ApplyResult{}, err
		}
		hasRoot, hasStage = true, false
		j.Phase = "installed"
		if err = r.saveJournal(j); err != nil {
			return ApplyResult{}, err
		}
	}
	if !hasRoot && !hasStage && hasBackup {
		if j.Branch != nil {
			current, err := r.getBranch(ctx, j.Branch.ID)
			if err != nil || current.Head != j.ExpectedHead {
				return ApplyResult{}, ErrConflict
			}
		}
		if err = os.Rename(j.Backup, j.Directory); err != nil {
			return ApplyResult{}, err
		}
		if err = syncDir(filepath.Dir(j.Directory)); err != nil {
			return ApplyResult{}, err
		}
		if err = r.removeJournal(j); err != nil {
			return ApplyResult{}, err
		}
		base, err := r.getSnapshot(ctx, j.Base)
		return ApplyResult{JournalID: j.ID, Snapshot: base}, err
	}
	if !hasRoot || hasStage {
		return ApplyResult{}, ErrCorrupt
	}
	actual, err := r.capture(ctx, j.Directory)
	if err != nil {
		return ApplyResult{}, err
	}
	if actual.ID != j.Target {
		return ApplyResult{}, fmt.Errorf("%w: installed tree differs from journal", ErrConflict)
	}
	if err = r.commitJournalBranch(ctx, j); err != nil {
		return ApplyResult{}, err
	}
	j.Phase = "committed"
	if err = r.saveJournal(j); err != nil {
		return ApplyResult{}, err
	}
	if hasBackup {
		if err = os.RemoveAll(j.Backup); err != nil {
			return ApplyResult{}, err
		}
		if err = syncDir(filepath.Dir(j.Directory)); err != nil {
			return ApplyResult{}, err
		}
	}
	if err = r.removeJournal(j); err != nil {
		return ApplyResult{}, err
	}
	return ApplyResult{JournalID: j.ID, Snapshot: actual, Branch: j.Branch}, nil
}

func (r *Repository) finishDelete(ctx context.Context, j journal) error {
	if j.Branch == nil || j.Kind != "delete-branch" {
		return ErrCorrupt
	}
	if err := r.validateJournal(ctx, j); err != nil {
		return err
	}
	path, _ := r.branchPath(j.Branch.ID)
	var current Branch
	err := loadJSON(path, &current)
	if err == nil && current.Head != j.ExpectedHead {
		return ErrConflict
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	hasRoot, err := existsDir(j.Directory)
	if err != nil {
		return err
	}
	hasBackup, err := existsDir(j.Backup)
	if err != nil {
		return err
	}
	if hasRoot && hasBackup {
		return ErrCorrupt
	}
	if hasRoot {
		if err = os.Rename(j.Directory, j.Backup); err != nil {
			return err
		}
		if err = syncDir(filepath.Dir(j.Directory)); err != nil {
			return err
		}
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = syncDir(filepath.Dir(path)); err != nil {
		return err
	}
	if err = os.RemoveAll(j.Backup); err != nil {
		return err
	}
	if err = syncDir(filepath.Dir(j.Directory)); err != nil {
		return err
	}
	return r.removeJournal(j)
}

func (r *Repository) recover(ctx context.Context, ownedOnly bool) ([]ApplyResult, error) {
	entries, err := os.ReadDir(filepath.Join(r.root, "journals"))
	if err != nil {
		return nil, err
	}
	results := []ApplyResult{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var j journal
		if err = loadJSON(filepath.Join(r.root, "journals", entry.Name()), &j); err != nil {
			return nil, err
		}
		if entry.Name() != j.ID+".json" {
			return nil, ErrCorrupt
		}
		if ownedOnly && j.Branch == nil {
			continue
		}
		if j.Kind == "delete-branch" {
			if err = r.finishDelete(ctx, j); err != nil {
				return nil, err
			}
			results = append(results, ApplyResult{JournalID: j.ID})
		} else {
			result, err := r.finishApply(ctx, j, false)
			if err != nil {
				return nil, err
			}
			results = append(results, result)
		}
	}
	return results, nil
}

func (r *Repository) Recover(ctx context.Context) (results []ApplyResult, err error) {
	err = r.locked(ctx, func() error { results, err = r.recover(ctx, false); return err })
	return
}

func (r *Repository) Materialize(ctx context.Context, id, directory string) error {
	return r.locked(ctx, func() error {
		target, err := r.getSnapshot(ctx, id)
		if err != nil {
			return err
		}
		abs, err := filepath.Abs(directory)
		if err != nil || within(abs, r.root) || within(r.root, abs) {
			return ErrUnsafePath
		}
		if err = checkAncestors(abs); err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
			return err
		}
		_, err = r.apply(ctx, "", target, abs, nil, "", true)
		return err
	})
}

func (r *Repository) ApplyToDirectory(ctx context.Context, base, target, directory string) (result ApplyResult, err error) {
	err = r.locked(ctx, func() error {
		if _, e := r.getSnapshot(ctx, base); e != nil {
			return e
		}
		snapshot, e := r.getSnapshot(ctx, target)
		if e != nil {
			return e
		}
		abs, e := filepath.Abs(directory)
		if e != nil || within(abs, r.root) || within(r.root, abs) {
			return ErrUnsafePath
		}
		result, e = r.apply(ctx, base, snapshot, abs, nil, "", false)
		return e
	})
	return
}

func (r *Repository) ApplyMerge(ctx context.Context, plan MergePlan, resolutions []Resolution, targetBranch, expectedHead string) (result ApplyResult, err error) {
	err = r.locked(ctx, func() error {
		stored, e := r.getMergePlan(ctx, plan.ID)
		if e != nil {
			return e
		}
		if expectedHead == "" || stored.Ours != expectedHead {
			return ErrConflict
		}
		branch, e := r.getBranch(ctx, targetBranch)
		if e != nil {
			return e
		}
		if branch.Head != expectedHead {
			return ErrConflict
		}
		snapshot, e := r.resolvePlan(ctx, stored, resolutions)
		if e != nil {
			return e
		}
		root, e := r.branchRoot(ctx, targetBranch)
		if e != nil {
			return e
		}
		branch.Head = snapshot.ID
		branch.Generation++
		branch.UpdatedAt = time.Now().UTC()
		result, e = r.apply(ctx, expectedHead, snapshot, root, &branch, expectedHead, false)
		return e
	})
	return
}
