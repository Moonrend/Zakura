package workspacestate

import (
	"context"
	"errors"
	"io/fs"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

// Effect is an obligation, persisted before starting a writer. Missing external
// identity means the result is unknown, not that there was no effect.
type Effect struct {
	Version    int                         `json:"version"`
	ID         string                      `json:"id"`
	Kind       string                      `json:"kind"`
	ExternalID string                      `json:"externalId,omitempty"`
	Released   bool                        `json:"released"`
	Create     *docker.CreateStatusRequest `json:"create,omitempty"`
}

func sameEffect(a, b Effect) bool {
	if a.Version != b.Version || a.ID != b.ID || a.Kind != b.Kind || a.ExternalID != b.ExternalID || a.Released != b.Released {
		return false
	}
	if a.Create == nil || b.Create == nil {
		return a.Create == nil && b.Create == nil
	}
	return *a.Create == *b.Create
}

func (g *Guard) RecordEffect(effect Effect) error {
	if g.instance == nil || !protocol.ValidIdentity(effect.ID) || effect.Released || effect.Version != 1 {
		return ErrConflict
	}
	switch effect.Kind {
	case "container", "host-process", "stream", "legacy-writers":
	default:
		return ErrConflict
	}
	var i instanceRecord
	if err := statefs.Read(g.instance, "instance.json", &i); err != nil {
		return err
	}
	if i.Binding != g.binding || i.State != "attached" {
		return ErrRevoked
	}
	effects, err := statefs.MakeChild(g.instance, "effects", 0700)
	if err != nil {
		return err
	}
	defer effects.Close()
	name := key(effect.ID) + ".json"
	var old Effect
	err = statefs.Read(effects, name, &old)
	if err == nil {
		if sameEffect(old, effect) {
			return nil
		}
		// Replaying a create intent retains a previously recorded external ID.
		// A successful reply can fill the ID once, but cannot change it.
		candidate := effect
		candidate.ExternalID = old.ExternalID
		if old.Released || !sameEffect(old, candidate) {
			return ErrConflict
		}
		if effect.ExternalID == "" {
			return nil
		}
		if old.ExternalID != "" {
			return ErrConflict
		}
		return statefs.Write(effects, name, effect, true)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return statefs.Write(effects, name, effect, false)
}

func (g *Guard) Effects() ([]Effect, error) {
	effects, err := statefs.Child(g.instance, "effects")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer effects.Close()
	entries, err := fs.ReadDir(effects.FS(), ".")
	if err != nil {
		return nil, err
	}
	var result []Effect
	for _, entry := range entries {
		if len(entry.Name()) > 0 && entry.Name()[0] == '.' {
			continue
		}
		var effect Effect
		if err := statefs.Read(effects, entry.Name(), &effect); err != nil {
			return nil, err
		}
		if effect.Version != 1 || !protocol.ValidIdentity(effect.ID) || entry.Name() != key(effect.ID)+".json" {
			return nil, ErrConflict
		}
		result = append(result, effect)
	}
	return result, nil
}

// BeginRelease waits for admitted operations to exit, then exposes only the
// revoked instance's obligations. Repeated cleanup uses this same identity.
func (s Store) BeginRelease(ctx context.Context, binding protocol.Binding) (*Guard, error) {
	if err := s.Revoke(ctx, binding); err != nil {
		return nil, err
	}
	guard, err := s.operationLock(ctx, binding)
	if err != nil {
		return nil, err
	}
	opened, err := s.open(ctx)
	if err != nil {
		guard.Close()
		return nil, err
	}
	defer opened.close()
	i, err := readInstance(guard.instance, binding)
	if err != nil || i.State != "revoked" && i.State != "released" {
		guard.Close()
		if err != nil {
			return nil, err
		}
		return nil, ErrConflict
	}
	return guard, nil
}

// BeginEffectCleanup serializes removal of one writer without revoking the
// instance. Retired instances remain addressable for delayed cleanup replies.
func (s Store) BeginEffectCleanup(ctx context.Context, binding protocol.Binding) (*Guard, error) {
	guard, err := s.operationLock(ctx, binding)
	if err != nil {
		return nil, err
	}
	if _, err := readInstance(guard.instance, binding); err != nil {
		guard.Close()
		return nil, err
	}
	return guard, nil
}

// ConfirmEffectReleased is called by the executor only after exact resource
// cleanup/absence has been proven. It is not a public "forget resource" RPC.
func (g *Guard) ConfirmEffectReleased(expected Effect) error {
	if g.unlock == nil {
		return ErrConflict
	}
	if _, err := readInstance(g.instance, g.binding); err != nil {
		return err
	}
	effects, err := statefs.Child(g.instance, "effects")
	if err != nil {
		return err
	}
	defer effects.Close()
	name := key(expected.ID) + ".json"
	var stored Effect
	if err := statefs.Read(effects, name, &stored); err != nil {
		return err
	}
	if stored.Released {
		expected.Released = true
		if sameEffect(stored, expected) {
			return nil
		}
		return ErrConflict
	}
	if !sameEffect(stored, expected) {
		return ErrConflict
	}
	stored.Released = true
	return statefs.Write(effects, name, stored, true)
}

func (s Store) CompleteRelease(ctx context.Context, guard *Guard) error {
	if guard == nil || guard.instance == nil || guard.unlock == nil {
		return ErrConflict
	}
	opened, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer opened.close()
	if err := opened.checkDisk(guard.binding.Disk); err != nil {
		return err
	}
	// A guard from a different state root is not authority over this node.
	expected, err := opened.instanceRoot(guard.binding, false)
	if err != nil {
		return err
	}
	defer expected.Close()
	want, err := statefs.DirectoryID(expected)
	if err != nil {
		return err
	}
	got, err := statefs.DirectoryID(guard.instance)
	if err != nil {
		return err
	}
	if got != want {
		return ErrConflict
	}
	i, err := readInstance(guard.instance, guard.binding)
	if err != nil {
		return err
	}
	if i.State != "revoked" && i.State != "released" {
		return ErrConflict
	}
	effects, err := guard.Effects()
	if err != nil {
		return err
	}
	for _, effect := range effects {
		if !effect.Released {
			return ErrUnverified
		}
	}
	meta, err := opened.diskRoot(guard.binding.Disk, false)
	if err != nil {
		return err
	}
	defer meta.Close()
	d, err := readDisk(meta, guard.binding.Disk)
	if err != nil {
		return err
	}
	if d.Binding != nil && *d.Binding != guard.binding.Target {
		if i.State == "released" {
			return nil
		}
		return ErrConflict
	}
	if i.State != "released" {
		i.State = "released"
		if err := statefs.Write(guard.instance, "instance.json", i, true); err != nil {
			return err
		}
	}
	if d.Binding == nil {
		return nil
	}
	if d.State != "release_pending" {
		return ErrConflict
	}
	d.Binding, d.State = nil, "available"
	return statefs.Write(meta, "disk.json", d, true)
}
