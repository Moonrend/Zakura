// Package workspacestate owns durable node-side workspace metadata. It never
// resolves an instance through a mutable Space binding.
package workspacestate

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

var (
	ErrConflict   = errors.New("workspace disk ownership or binding changed")
	ErrRevoked    = errors.New("workspace instance has been revoked")
	ErrUnverified = errors.New("workspace disk contents have not been verified")
)

type Store struct {
	StateRoot  string
	DataRoot   string
	VolumeName string
}

type Identity struct {
	Version     int    `json:"version"`
	Incarnation string `json:"incarnation"`
	PoolID      string `json:"poolId"`
}

type diskRecord struct {
	Version     int              `json:"version"`
	Disk        protocol.Disk    `json:"disk"`
	Marker      string           `json:"marker"`
	DirectoryID string           `json:"directoryId,omitempty"`
	State       string           `json:"state"`
	Binding     *protocol.Target `json:"binding,omitempty"`
}

type diskMarker struct {
	Version int           `json:"version"`
	Disk    protocol.Disk `json:"disk"`
	Marker  string        `json:"marker"`
}

type session struct {
	state    *os.Root
	data     *os.Root
	identity Identity
	unlock   func()
}

func (s *session) close() {
	if s.data != nil {
		s.data.Close()
	}
	if s.unlock != nil {
		s.unlock()
	}
	if s.state != nil {
		s.state.Close()
	}
}

func key(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func (s Store) open(ctx context.Context) (_ *session, err error) {
	parent, err := statefs.OpenRoot(s.StateRoot)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	state, err := statefs.MakeChild(parent, ".workspaces", 0700)
	if err != nil {
		return nil, err
	}
	opened := &session{state: state}
	defer func() {
		if err != nil {
			opened.close()
		}
	}()
	opened.unlock, err = statefs.Lock(ctx, state)
	if err != nil {
		return nil, err
	}
	if err = statefs.Read(state, "identity.json", &opened.identity); errors.Is(err, fs.ErrNotExist) {
		opened.identity = Identity{Version: 1, Incarnation: rand.Text(), PoolID: rand.Text()}
		err = statefs.Write(state, "identity.json", opened.identity, false)
	}
	if err != nil {
		return nil, err
	}
	if opened.identity.Version != 1 || !protocol.ValidIdentity(opened.identity.Incarnation) || !protocol.ValidIdentity(opened.identity.PoolID) {
		return nil, fmt.Errorf("invalid workspace node identity")
	}
	opened.data, err = statefs.OpenRoot(s.DataRoot)
	if err != nil {
		return nil, err
	}
	var pool Identity
	if err = statefs.Read(opened.data, ".zakura-workspace-pool.json", &pool); errors.Is(err, fs.ErrNotExist) {
		// Once initialization completed, a missing pool marker means storage was
		// replaced or lost. Never silently enroll an empty replacement volume.
		var ready Identity
		if readyErr := statefs.Read(state, "ready.json", &ready); !errors.Is(readyErr, fs.ErrNotExist) {
			if readyErr != nil {
				return nil, readyErr
			}
			return nil, ErrUnverified
		}
		pool = opened.identity
		err = statefs.Write(opened.data, ".zakura-workspace-pool.json", pool, false)
	}
	if err != nil {
		return nil, err
	}
	if pool != opened.identity {
		return nil, ErrConflict
	}
	var ready Identity
	if err = statefs.Read(state, "ready.json", &ready); errors.Is(err, fs.ErrNotExist) {
		err = statefs.Write(state, "ready.json", opened.identity, false)
		ready = opened.identity
	}
	if err != nil {
		return nil, err
	}
	if ready != opened.identity {
		return nil, ErrConflict
	}
	return opened, nil
}

func (s Store) Identity(ctx context.Context) (Identity, error) {
	opened, err := s.open(ctx)
	if err != nil {
		return Identity{}, err
	}
	defer opened.close()
	return opened.identity, nil
}

func (s *session) checkDisk(d protocol.Disk) error {
	if err := d.Validate(); err != nil {
		return err
	}
	if d.NodeIncarnation != s.identity.Incarnation {
		return ErrConflict
	}
	return nil
}

func (s *session) diskRoot(d protocol.Disk, create bool) (*os.Root, error) {
	if err := s.checkDisk(d); err != nil {
		return nil, err
	}
	disks, err := statefs.MakeChild(s.state, "disks", 0700)
	if err != nil {
		return nil, err
	}
	defer disks.Close()
	if create {
		return statefs.MakeChild(disks, key(d.DiskID), 0700)
	}
	return statefs.Child(disks, key(d.DiskID))
}

func readDisk(root *os.Root, d protocol.Disk) (diskRecord, error) {
	var record diskRecord
	if err := statefs.Read(root, "disk.json", &record); err != nil {
		return record, err
	}
	if record.Version != 1 || record.Disk != d || !protocol.ValidIdentity(record.Marker) {
		return record, ErrConflict
	}
	if record.Binding != nil && (record.Binding.Validate() != nil || !d.Matches(*record.Binding)) {
		return record, ErrConflict
	}
	switch record.State {
	case "allocating", "available", "attached", "release_pending", "delete_pending", "deleted":
	default:
		return record, ErrConflict
	}
	return record, nil
}

func (s Store) localPath(d protocol.Disk) string {
	return filepath.Join(s.DataRoot, filepath.FromSlash(d.Locator.RelativePath))
}
