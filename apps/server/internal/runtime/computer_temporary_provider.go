package runtime

import (
	"context"
	"errors"
	"path"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// temporaryComputerProvider provisions session-scoped, self-hosted Docker
// containers on a server node. Unlike the server provider the container is never
// restarted automatically and every instance is bound to exactly one chat, so its
// files vanish with the session. It shares the container naming, validation and
// node workspace with the server provider, and adds destruction for deadline
// reclamation. Cleanup destroys overdue instances before their storage is removed.
type temporaryComputerProvider struct{ h *handler }

var (
	_ computers.CreationProvider    = temporaryComputerProvider{}
	_ computers.DestructionProvider = temporaryComputerProvider{}
)

// runner re-reads the pinned identity and durable approval before contacting a
// runner. Provider and node membership are resolved from storage, and the runtime
// must stay session-scoped: a temporary computer can never share node storage
// with another chat.
func (p temporaryComputerProvider) runner(ctx context.Context, r computers.Runtime, create bool) (*runnerSession, string, error) {
	if strings.TrimSpace(r.SessionScope) == "" {
		return nil, "", computers.ErrTransitionConflict
	}
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	actual, err := p.h.computerStore().GetRuntime(ctx, target)
	if err != nil {
		return nil, "", err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || actual.ExternalID != "" ||
		(actual.State != computers.Creating && (create || actual.State != computers.Unknown)) {
		return nil, "", computers.ErrTransitionConflict
	}
	var node, storageRoot string
	err = p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT n.id, n.storage_root FROM computers c
 JOIN runtime_nodes n ON n.id=c.runtime_node_id AND (n.tenant_id=c.tenant_id OR n.is_shared=TRUE)
 JOIN computer_creation_approvals a ON a.runtime_id=? AND a.create_operation_id=?
 JOIN computer_runtimes rt ON rt.id=? AND rt.session_scope=? AND rt.computer_id=c.id AND rt.tenant_id=c.tenant_id AND rt.space_id=c.space_id
 WHERE c.tenant_id=? AND c.space_id=? AND c.id=? AND c.provider='temporary' AND n.kind IN ('server','computer')`), r.ID, r.CreateOperationID, r.ID, r.SessionScope, r.TenantID, r.SpaceID, r.ComputerID).Scan(&node, &storageRoot)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(storageRoot) == "" {
		return nil, "", errors.New("runtime node has no storage root")
	}
	if p.h.hub == nil {
		return nil, "", computers.ErrProviderUnavailable
	}
	session, err := p.h.hub.get(node)
	return session, storageRoot, err
}

// nodeRunner resolves the owning node for a runtime that has already been
// authorized for destruction, without re-checking creation state.
func (p temporaryComputerProvider) nodeRunner(ctx context.Context, r computers.Runtime) (*runnerSession, string, error) {
	if strings.TrimSpace(r.SessionScope) == "" {
		return nil, "", computers.ErrTransitionConflict
	}
	var node, storageRoot string
	err := p.h.deps.DB.QueryRowContext(ctx, p.h.deps.Rebind(`SELECT n.id, n.storage_root FROM computers c
 JOIN runtime_nodes n ON n.id=c.runtime_node_id AND (n.tenant_id=c.tenant_id OR n.is_shared=TRUE)
 JOIN computer_runtimes rt ON rt.id=? AND rt.session_scope=? AND rt.computer_id=c.id AND rt.tenant_id=c.tenant_id AND rt.space_id=c.space_id
 WHERE c.tenant_id=? AND c.space_id=? AND c.id=? AND c.provider='temporary' AND n.kind IN ('server','computer')`), r.ID, r.SessionScope, r.TenantID, r.SpaceID, r.ComputerID).Scan(&node, &storageRoot)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(storageRoot) == "" {
		return nil, "", errors.New("runtime node has no storage root")
	}
	if p.h.hub == nil {
		return nil, "", computers.ErrProviderUnavailable
	}
	session, err := p.h.hub.get(node)
	return session, storageRoot, err
}

func (p temporaryComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	runner, storageRoot, err := p.runner(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	root, err := computerRoot(ctx, runner, storageRoot, r.ID)
	if err != nil {
		return computers.CreationResult{}, err
	}
	name, labels := computerContainerIdentity(r)
	var result computerContainer
	// Independent bind-mounted storage, no Docker socket, published ports, or
	// privileged mode. restart=no keeps a temporary instance down until it is
	// reclaimed rather than resurrecting it after an unclean stop.
	err = runner.call(ctx, "docker.create", map[string]any{
		"name": name, "image": serverComputerImage, "labels": labels,
		"volumes":    []map[string]any{{"hostPath": root, "containerPath": "/workspace"}},
		"workingDir": "/workspace", "restart": "no",
	}, &result)
	if err != nil {
		return computers.CreationResult{}, err
	}
	if err = validateComputerContainer(result, r); err != nil {
		return computers.CreationResult{}, err
	}
	return computers.CreationResult{ExternalID: result.DockerID, RootPath: root}, nil
}

func (p temporaryComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	runner, storageRoot, err := p.runner(ctx, r, false)
	if err != nil {
		return computers.CreationResult{}, err
	}
	root, err := computerRoot(ctx, runner, storageRoot, r.ID)
	if err != nil {
		return computers.CreationResult{}, err
	}
	var results []computerContainer
	if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.operation=" + r.CreateOperationID}, &results); err != nil {
		return computers.CreationResult{}, err
	}
	if len(results) == 0 {
		return computers.CreationResult{}, nil
	}
	if len(results) != 1 {
		return computers.CreationResult{}, errors.New("ambiguous computer creation operation")
	}
	if err = validateComputerContainer(results[0], r); err != nil {
		return computers.CreationResult{}, err
	}
	return computers.CreationResult{ExternalID: results[0].DockerID, RootPath: root}, nil
}

// Destroy stops and removes the container, then deletes the node directory that
// backed it, so an expired temporary computer never leaves files behind. The
// runtime must already be stopping/expired/unknown and own a provider instance;
// cleanup parks it in stopping first. Re-reading the identity prevents destroying
// a replacement after a lost race.
func (p temporaryComputerProvider) Destroy(ctx context.Context, r computers.Runtime) error {
	target := computers.Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	actual, err := p.h.computerStore().GetRuntime(ctx, target)
	if err != nil {
		return err
	}
	if r.CreateOperationID == "" || actual.CreateOperationID != r.CreateOperationID || actual.SessionScope != r.SessionScope || strings.TrimSpace(actual.SessionScope) == "" {
		return computers.ErrTransitionConflict
	}
	if actual.State != computers.Stopping && actual.State != computers.Expired && actual.State != computers.Unknown {
		return computers.ErrTransitionConflict
	}
	if strings.TrimSpace(actual.ExternalID) == "" {
		return errors.New("computer runtime has no provider instance")
	}
	runner, storageRoot, err := p.nodeRunner(ctx, r)
	if err != nil {
		return err
	}
	if err = runner.call(ctx, "docker.stop", map[string]any{"id": actual.ExternalID, "remove": true}, nil); err != nil {
		return err
	}
	var removed struct {
		OK bool `json:"ok"`
	}
	if err = runner.call(ctx, "host.fs.remove", map[string]any{"root": storageRoot, "path": path.Join("computers", r.ID, "workspace"), "recursive": true}, &removed); err != nil {
		return err
	}
	return nil
}

func (h *handler) startComputerCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.sweepExpiredComputers(ctx)
			}
		}
	}()
}

// sweepExpiredComputers reclaims overdue temporary computers. It is deliberately
// silent and panic-safe: a cleanup failure must never take down the API server.
func (h *handler) sweepExpiredComputers(ctx context.Context) {
	defer func() { _ = recover() }()
	callCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	deps := computers.CleanupDeps{Store: h.computerStore(), Destroyers: h.computerDestroyers(), Now: func() time.Time { return h.store.now() }}
	_, _, _ = deps.ExpireOverdue(callCtx, 50)
}
