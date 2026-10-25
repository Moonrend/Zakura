package workspacestate

import (
	"context"
	"errors"
	"io/fs"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

type deleteRecord struct {
	Version   int           `json:"version"`
	RequestID string        `json:"requestId"`
	Disk      protocol.Disk `json:"disk"`
}

// Delete requires a separate, explicit authorization after every attachment has
// been released. The empty directory and ownership marker remain as a tombstone;
// neither its ID nor its locator can be allocated again.
func (s Store) Delete(ctx context.Context, d protocol.Disk, requestID string) error {
	if !protocol.ValidIdentity(requestID) {
		return ErrConflict
	}
	opened, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer opened.close()
	meta, err := opened.diskRoot(d, false)
	if err != nil {
		return err
	}
	defer meta.Close()
	record, err := readDisk(meta, d)
	if err != nil {
		return err
	}
	if record.Binding != nil || d.Locator.Kind == "legacy-bind" {
		return ErrConflict
	}
	if record.State != "available" && record.State != "delete_pending" && record.State != "deleted" {
		return ErrConflict
	}
	authority := deleteRecord{Version: 1, RequestID: requestID, Disk: d}
	var stored deleteRecord
	err = statefs.Read(meta, "delete.json", &stored)
	if errors.Is(err, fs.ErrNotExist) {
		if record.State != "available" {
			return ErrConflict
		}
		if err := statefs.Write(meta, "delete.json", authority, false); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if stored != authority {
		return ErrConflict
	}
	if record.State == "deleted" {
		return nil
	}
	root, err := verifyDirectory(opened.data, record)
	if err != nil {
		return err
	}
	defer root.Close()
	record.State = "delete_pending"
	if err := statefs.Write(meta, "disk.json", record, true); err != nil {
		return err
	}
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Root.RemoveAll does not follow final symlinks, and all intermediate
		// resolution remains constrained by the pinned workspace directory.
		if err := root.RemoveAll(entry.Name()); err != nil {
			return err
		}
	}
	if err := statefs.Sync(root); err != nil {
		return err
	}
	record.State = "deleted"
	return statefs.Write(meta, "disk.json", record, true)
}
