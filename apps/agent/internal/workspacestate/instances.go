package workspacestate

import (
	"context"
	"errors"
	"io/fs"
	"os"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

type instanceRecord struct {
	Version int              `json:"version"`
	Binding protocol.Binding `json:"binding"`
	State   string           `json:"state"`
}

func (s *session) instanceRoot(binding protocol.Binding, create bool) (*os.Root, error) {
	if err := binding.Validate(); err != nil {
		return nil, err
	}
	if err := s.checkDisk(binding.Disk); err != nil {
		return nil, err
	}
	instances, err := statefs.MakeChild(s.state, "instances", 0700)
	if err != nil {
		return nil, err
	}
	defer instances.Close()
	if create {
		return statefs.MakeChild(instances, key(binding.Target.InstanceID), 0700)
	}
	return statefs.Child(instances, key(binding.Target.InstanceID))
}

func readInstance(root *os.Root, binding protocol.Binding) (instanceRecord, error) {
	var record instanceRecord
	if err := statefs.Read(root, "instance.json", &record); err != nil {
		return record, err
	}
	if record.Version != 1 || record.Binding != binding {
		return record, ErrConflict
	}
	switch record.State {
	case "attached", "revoked", "released":
	default:
		return record, ErrConflict
	}
	return record, nil
}

func (s Store) Attach(ctx context.Context, binding protocol.Binding) error {
	opened, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer opened.close()
	instance, err := opened.instanceRoot(binding, true)
	if err != nil {
		return err
	}
	defer instance.Close()
	i, err := readInstance(instance, binding)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err == nil && i.State != "attached" {
		return ErrRevoked
	}
	newInstance := errors.Is(err, fs.ErrNotExist)
	meta, err := opened.diskRoot(binding.Disk, false)
	if err != nil {
		return err
	}
	defer meta.Close()
	d, err := readDisk(meta, binding.Disk)
	if err != nil {
		return err
	}
	if _, err := meta.Lstat("delete.json"); !errors.Is(err, fs.ErrNotExist) {
		if err != nil {
			return err
		}
		return ErrConflict
	}
	if d.Binding != nil && *d.Binding != binding.Target {
		return ErrConflict
	}
	if d.State != "available" && d.State != "attached" {
		return ErrConflict
	}
	root, err := verifyDirectory(opened.data, d)
	if err != nil {
		return err
	}
	root.Close()
	// Reserve the disk first. A crash leaves it unavailable to other instances;
	// replay of this exact binding completes the second durable write.
	d.Binding, d.State = &binding.Target, "attached"
	if err = statefs.Write(meta, "disk.json", d, true); err != nil {
		return err
	}
	if newInstance {
		i = instanceRecord{Version: 1, Binding: binding, State: "attached"}
		return statefs.Write(instance, "instance.json", i, false)
	}
	return nil
}

// Revoke is durable even if Attach never arrived. It prevents delayed attachment
// and creation from reviving an instance after the control plane retired it.
func (s Store) Revoke(ctx context.Context, binding protocol.Binding) error {
	opened, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer opened.close()
	instance, err := opened.instanceRoot(binding, true)
	if err != nil {
		return err
	}
	defer instance.Close()
	i, err := readInstance(instance, binding)
	if errors.Is(err, fs.ErrNotExist) {
		i = instanceRecord{Version: 1, Binding: binding, State: "revoked"}
		if err := statefs.Write(instance, "instance.json", i, false); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if i.State == "attached" {
		i.State = "revoked"
		if err := statefs.Write(instance, "instance.json", i, true); err != nil {
			return err
		}
	}
	meta, err := opened.diskRoot(binding.Disk, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer meta.Close()
	d, err := readDisk(meta, binding.Disk)
	if err != nil {
		return err
	}
	if d.Binding == nil || *d.Binding != binding.Target {
		return nil
	}
	if d.State == "attached" {
		d.State = "release_pending"
		return statefs.Write(meta, "disk.json", d, true)
	}
	return nil
}

// Guard pins one admitted operation. Revocation can be persisted while an
// operation runs, but release must wait until this guard has closed.
// Remote effects that outlive it must also have a durable Effect record.
type Guard struct {
	Root     *os.Root
	Path     string
	instance *os.Root
	unlock   func()
	binding  protocol.Binding
}

func (g *Guard) Close() {
	if g.Root != nil {
		g.Root.Close()
		g.Root = nil
	}
	if g.unlock != nil {
		g.unlock()
		g.unlock = nil
	}
	if g.instance != nil {
		g.instance.Close()
		g.instance = nil
	}
}

func (s Store) operationLock(ctx context.Context, binding protocol.Binding) (*Guard, error) {
	opened, err := s.open(ctx)
	if err != nil {
		return nil, err
	}
	instance, err := opened.instanceRoot(binding, false)
	opened.close()
	if err != nil {
		return nil, err
	}
	unlock, err := statefs.Lock(ctx, instance)
	if err != nil {
		instance.Close()
		return nil, err
	}
	return &Guard{instance: instance, unlock: unlock, binding: binding}, nil
}

func (s Store) Begin(ctx context.Context, binding protocol.Binding) (_ *Guard, err error) {
	guard, err := s.operationLock(ctx, binding)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			guard.Close()
		}
	}()
	opened, err := s.open(ctx)
	if err != nil {
		return nil, err
	}
	defer opened.close()
	i, err := readInstance(guard.instance, binding)
	if err != nil {
		return nil, err
	}
	if i.State != "attached" {
		return nil, ErrRevoked
	}
	meta, err := opened.diskRoot(binding.Disk, false)
	if err != nil {
		return nil, err
	}
	defer meta.Close()
	d, err := readDisk(meta, binding.Disk)
	if err != nil {
		return nil, err
	}
	if d.State != "attached" || d.Binding == nil || *d.Binding != binding.Target {
		return nil, ErrConflict
	}
	guard.Root, err = verifyDirectory(opened.data, d)
	if err != nil {
		return nil, err
	}
	guard.Path = s.localPath(binding.Disk)
	return guard, nil
}
