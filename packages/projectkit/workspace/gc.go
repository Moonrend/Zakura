package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (r *Repository) GC(ctx context.Context, options GCOptions) (result GCResult, err error) {
	if options.MinAge < 0 {
		return result, ErrLimit
	}
	err = r.locked(ctx, func() error {
		if !options.DryRun {
			if err := r.cleanupTemporary(ctx); err != nil {
				return err
			}
		}
		keep := map[string]bool{}
		objects := map[string]bool{}
		mark := func(id string) error {
			if keep[id] {
				return nil
			}
			snapshot, err := r.getSnapshot(ctx, id)
			if err != nil {
				return err
			}
			keep[id] = true
			for _, entry := range snapshot.Entries {
				objects[entry.Hash] = true
			}
			return nil
		}
		for _, id := range options.KeepSnapshots {
			if err := mark(id); err != nil {
				return err
			}
		}
		branches, e := r.listBranches(ctx)
		if e != nil {
			return e
		}
		for _, branch := range branches {
			if e = mark(branch.Base); e != nil {
				return e
			}
			if e = mark(branch.Head); e != nil {
				return e
			}
		}
		plans, e := os.ReadDir(filepath.Join(r.root, "plans"))
		if e != nil {
			return e
		}
		for _, entry := range plans {
			if !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			plan, e := r.getMergePlan(ctx, strings.TrimSuffix(entry.Name(), ".json"))
			if e != nil {
				return e
			}
			for _, id := range []string{plan.Base, plan.Ours, plan.Theirs, plan.Result.ID} {
				if e = mark(id); e != nil {
					return e
				}
			}
		}
		journals, e := os.ReadDir(filepath.Join(r.root, "journals"))
		if e != nil {
			return e
		}
		for _, entry := range journals {
			if !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			var j journal
			if e = loadJSON(filepath.Join(r.root, "journals", entry.Name()), &j); e != nil {
				return e
			}
			if e = r.validateJournal(ctx, j); e != nil {
				return e
			}
			for _, id := range []string{j.Base, j.Target} {
				if id != "" {
					if e = mark(id); e != nil {
						return e
					}
				}
			}
			if j.Branch != nil {
				if e = mark(j.Branch.Base); e != nil {
					return e
				}
			}
		}
		manifests, e := os.ReadDir(filepath.Join(r.root, "manifests"))
		if e != nil {
			return e
		}
		cutoff := time.Now().Add(-options.MinAge)
		removeManifests := []string{}
		for _, entry := range manifests {
			if err := ctx.Err(); err != nil {
				return err
			}
			if strings.HasPrefix(entry.Name(), ".pending-") {
				continue
			}
			if !strings.HasSuffix(entry.Name(), ".json") {
				return ErrCorrupt
			}
			id := strings.TrimSuffix(entry.Name(), ".json")
			if !validHash(id) {
				return ErrCorrupt
			}
			info, e := entry.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return ErrUnsafePath
			}
			if keep[id] || info.ModTime().After(cutoff) {
				if e = mark(id); e != nil {
					return e
				}
			} else {
				removeManifests = append(removeManifests, filepath.Join(r.root, "manifests", entry.Name()))
			}
		}
		allObjects, e := os.ReadDir(filepath.Join(r.root, "objects"))
		if e != nil {
			return e
		}
		removeObjects := []string{}
		for _, entry := range allObjects {
			if err := ctx.Err(); err != nil {
				return err
			}
			if strings.HasPrefix(entry.Name(), ".pending-") {
				continue
			}
			if !validHash(entry.Name()) {
				return ErrCorrupt
			}
			info, e := entry.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return ErrUnsafePath
			}
			if !objects[entry.Name()] && !info.ModTime().After(cutoff) {
				removeObjects = append(removeObjects, filepath.Join(r.root, "objects", entry.Name()))
				result.Bytes += info.Size()
			}
		}
		result.Objects, result.Manifests = len(removeObjects), len(removeManifests)
		if options.DryRun {
			return nil
		}
		// Complete marking precedes deletion, and manifests disappear before
		// their objects. Readers hold the same repository/process lock.
		for _, path := range removeManifests {
			if e = os.Remove(path); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
		}
		if e = syncDir(filepath.Join(r.root, "manifests")); e != nil {
			return e
		}
		for _, path := range removeObjects {
			if e = os.Remove(path); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
		}
		return syncDir(filepath.Join(r.root, "objects"))
	})
	return
}

// DeleteMergePlan releases plan-owned snapshot roots. Active installation
// journals retain the snapshots they need independently.
func (r *Repository) DeleteMergePlan(ctx context.Context, id string) error {
	return r.locked(ctx, func() error {
		if _, err := r.getMergePlan(ctx, id); err != nil {
			return err
		}
		if err := os.Remove(filepath.Join(r.root, "plans", id+".json")); err != nil {
			return err
		}
		return syncDir(filepath.Join(r.root, "plans"))
	})
}
