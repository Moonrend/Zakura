package workspacestate

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

func diskParent(root *os.Root, d protocol.Disk, create bool) (*os.Root, error) {
	parts := strings.Split(d.Locator.RelativePath, "/")
	open := statefs.Child
	if create {
		open = func(parent *os.Root, name string) (*os.Root, error) { return statefs.MakeChild(parent, name, 0750) }
	}
	prefix, err := open(root, parts[0])
	if err != nil {
		return nil, err
	}
	defer prefix.Close()
	return open(prefix, parts[1])
}

// Allocate only creates a new managed location after its ownership intent is
// durable. Existing legacy directories are enrolled explicitly, never created.
func (s Store) Allocate(ctx context.Context, d protocol.Disk) error {
	opened, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer opened.close()
	meta, err := opened.diskRoot(d, true)
	if err != nil {
		return err
	}
	defer meta.Close()
	record, err := readDisk(meta, d)
	if errors.Is(err, fs.ErrNotExist) {
		// An existing new-format directory without metadata cannot be adopted by
		// a fresh allocation. In particular, retries cannot claim foreign data.
		parent, lookupErr := diskParent(opened.data, d, false)
		if lookupErr == nil {
			parent.Close()
			if d.Locator.Kind != "legacy-bind" {
				return ErrConflict
			}
		} else if d.Locator.Kind == "legacy-bind" || !errors.Is(lookupErr, fs.ErrNotExist) {
			return lookupErr
		}
		record = diskRecord{Version: 1, Disk: d, Marker: rand.Text(), State: "allocating"}
		err = statefs.Write(meta, "disk.json", record, false)
	}
	if err != nil {
		return err
	}
	if record.State != "allocating" {
		if record.State != "available" && record.State != "attached" {
			return ErrConflict
		}
		root, err := verifyDirectory(opened.data, record)
		if err == nil {
			root.Close()
		}
		return err
	}
	parent, err := diskParent(opened.data, d, d.Locator.Kind == "directory")
	if err != nil {
		return err
	}
	defer parent.Close()
	marker := diskMarker{Version: 1, Disk: d, Marker: record.Marker}
	var existing diskMarker
	if err = statefs.Read(parent, ".zakura-disk.json", &existing); errors.Is(err, fs.ErrNotExist) {
		if d.Locator.Kind == "directory" {
			file, err := parent.Open(".")
			if err != nil {
				return err
			}
			entries, readErr := file.ReadDir(1)
			file.Close()
			if len(entries) != 0 {
				return ErrConflict
			}
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return readErr
			}
		} else {
			root, err := statefs.Child(parent, "workspace")
			if err != nil {
				return err
			}
			root.Close()
		}
		err = statefs.Write(parent, ".zakura-disk.json", marker, false)
		existing = marker
	}
	if err != nil {
		return err
	}
	if existing != marker {
		return ErrConflict
	}
	var root *os.Root
	if d.Locator.Kind == "directory" {
		root, err = statefs.MakeChild(parent, "workspace", 0755)
	} else {
		root, err = statefs.Child(parent, "workspace")
	}
	if err != nil {
		return err
	}
	record.DirectoryID, err = statefs.DirectoryID(root)
	root.Close()
	if err != nil {
		return err
	}
	record.State = "available"
	return statefs.Write(meta, "disk.json", record, true)
}

func verifyDirectory(data *os.Root, record diskRecord) (*os.Root, error) {
	parent, err := diskParent(data, record.Disk, false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	var marker diskMarker
	if err := statefs.Read(parent, ".zakura-disk.json", &marker); err != nil {
		return nil, err
	}
	if marker != (diskMarker{Version: 1, Disk: record.Disk, Marker: record.Marker}) {
		return nil, ErrConflict
	}
	root, err := statefs.Child(parent, "workspace")
	if err != nil {
		return nil, err
	}
	identity, err := statefs.DirectoryID(root)
	if err != nil || identity == "" || identity != record.DirectoryID {
		root.Close()
		if err != nil {
			return nil, err
		}
		return nil, ErrConflict
	}
	return root, nil
}

func (s Store) Verify(ctx context.Context, d protocol.Disk) error {
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
	if record.State != "available" && record.State != "attached" {
		return ErrUnverified
	}
	root, err := verifyDirectory(opened.data, record)
	if err == nil {
		root.Close()
	}
	return err
}

// Usage does not follow symlinks. The result is a sample, not a quota or a
// filesystem snapshot; an actively written disk can change during the walk.
func (s Store) Usage(ctx context.Context, d protocol.Disk) (int64, error) {
	opened, err := s.open(ctx)
	if err != nil {
		return 0, err
	}
	defer opened.close()
	meta, err := opened.diskRoot(d, false)
	if err != nil {
		return 0, err
	}
	defer meta.Close()
	record, err := readDisk(meta, d)
	if err != nil {
		return 0, err
	}
	if record.State == "allocating" || record.State == "deleted" {
		return 0, ErrUnverified
	}
	root, err := verifyDirectory(opened.data, record)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	var bytes int64
	err = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			bytes += info.Size()
		}
		return nil
	})
	return bytes, err
}

// Mount describes the Docker daemon's source, not the node container's path.
// The caller must verify the configured volume belongs to this pool first.
func (s Store) Mount(d protocol.Disk) (docker.Volume, error) {
	if err := d.Validate(); err != nil {
		return docker.Volume{}, err
	}
	if s.VolumeName != "" {
		return docker.Volume{VolumeName: s.VolumeName, VolumeSubpath: d.Locator.RelativePath, ContainerPath: "/workspace", NoCopy: true}, nil
	}
	return docker.Volume{HostPath: s.localPath(d), ContainerPath: "/workspace"}, nil
}
