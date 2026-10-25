package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// serverComputerProvider is deliberately separate from legacy workspace startup:
// docker.run replaces names, whereas docker.create fails without deleting them.
// Temporary computers are not registered until deadline cleanup is available.
type serverComputerProvider struct{ h *handler }

var _ computers.CreationProvider = serverComputerProvider{}

const serverComputerImage = "sunwuyuan/zakura-workspace-dev:latest"

type computerContainer struct {
	DockerID string            `json:"dockerId"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Status   string            `json:"status"`
	Labels   map[string]string `json:"labels"`
}

func computerContainerIdentity(r computers.Runtime) (string, map[string]string) {
	raw, _ := json.Marshal([]string{r.TenantID, r.SpaceID, r.ComputerID, r.ID, r.Incarnation, r.CreateOperationID})
	digest := sha256.Sum256(raw)
	name := "zakura-computer-" + hex.EncodeToString(digest[:])
	return name, map[string]string{
		"zakura.purpose": "computer", "zakura.tenant": r.TenantID,
		"zakura.space": r.SpaceID, "zakura.computer": r.ComputerID,
		"zakura.runtime": r.ID, "zakura.incarnation": r.Incarnation,
		"zakura.operation": r.CreateOperationID,
	}
}

// Re-read the pinned identity and durable approval before contacting any runner.
// Provider/node membership is resolved from storage, never from caller input.
func (p serverComputerProvider) runner(ctx context.Context, r computers.Runtime, create bool) (*runnerSession, string, error) {
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
 WHERE c.tenant_id=? AND c.space_id=? AND c.id=? AND c.provider='server' AND n.kind IN ('server','computer','local')`), r.ID, r.CreateOperationID, r.TenantID, r.SpaceID, r.ComputerID).Scan(&node, &storageRoot)
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

// computerRoot ensures the computer's own workspace directory exists on the
// node and returns its absolute path. Mkdir is idempotent, so Find gets the
// same directory Create used. Files live on the node and are bind-mounted into
// the computer's container, never shared with the legacy Space workspace.
func computerRoot(ctx context.Context, runner *runnerSession, storageRoot, runtimeID string) (string, error) {
	var created struct {
		Abs string `json:"abs"`
	}
	if err := runner.call(ctx, "host.fs.mkdir", map[string]any{
		"root": storageRoot, "path": path.Join("computers", runtimeID, "workspace"),
	}, &created); err != nil {
		return "", err
	}
	if strings.TrimSpace(created.Abs) == "" {
		return "", errors.New("runtime node returned no computer workspace path")
	}
	return created.Abs, nil
}

// computerImageStatus is the subset of the runner's docker.images response the
// image-ensure step needs. A present image carries a non-empty ID and no error;
// an absent or unreadable image has an empty ID or an error.
type computerImageStatus struct {
	Image string `json:"image"`
	ID    string `json:"id"`
	Error string `json:"error"`
}

// computerImagePullTimeout bounds a detached image pull. It comfortably outlives
// the approve HTTP request that triggers provisioning while still capping a
// wedged registry.
const computerImagePullTimeout = 15 * time.Minute

// ensureComputerImage verifies the node already has the image, pulling it with a
// detached, long-running context when it does not. It returns the context the
// subsequent docker.create must run under: the caller's ordinary request context
// when the image was already present, or the detached pull context when a pull
// ran, so a completed pull still materializes the container even after the
// approve request has ended. Only a failed pull is returned as an error. The
// docker.images probe stays on the fast request context.
func ensureComputerImage(ctx context.Context, runner *runnerSession, image string) (context.Context, context.CancelFunc, error) {
	present, err := computerImagePresent(ctx, runner, image)
	if err != nil || present {
		return ctx, func() {}, err
	}
	pullCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), computerImagePullTimeout)
	if err := runner.call(pullCtx, "docker.pull", map[string]any{"image": image}, nil); err != nil {
		cancel()
		return ctx, func() {}, err
	}
	return pullCtx, cancel, nil
}

func computerImagePresent(ctx context.Context, runner *runnerSession, image string) (bool, error) {
	var statuses []computerImageStatus
	if err := runner.call(ctx, "docker.images", map[string]any{"images": []string{image}}, &statuses); err != nil {
		return false, err
	}
	for _, status := range statuses {
		if strings.TrimSpace(status.Image) == image && strings.TrimSpace(status.ID) != "" && strings.TrimSpace(status.Error) == "" {
			return true, nil
		}
	}
	return false, nil
}

func validateComputerContainer(c computerContainer, r computers.Runtime) error {
	name, labels := computerContainerIdentity(r)
	if c.DockerID == "" || strings.TrimPrefix(c.Name, "/") != name || c.Image != serverComputerImage || c.Status != "running" {
		return errors.New("computer container identity or running state could not be verified")
	}
	for key, value := range labels {
		if c.Labels[key] != value {
			return errors.New("computer container ownership mismatch")
		}
	}
	return nil
}

func (p serverComputerProvider) Create(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
	runner, storageRoot, err := p.runner(ctx, r, true)
	if err != nil {
		return computers.CreationResult{}, err
	}
	createCtx, releaseImage, err := ensureComputerImage(ctx, runner, serverComputerImage)
	if err != nil {
		return computers.CreationResult{}, err
	}
	defer releaseImage()
	root, err := computerRoot(createCtx, runner, storageRoot, r.ID)
	if err != nil {
		return computers.CreationResult{}, err
	}
	name, labels := computerContainerIdentity(r)
	var result computerContainer
	// Independent bind-mounted storage, no Docker socket, published ports, or
	// privileged mode. Names include the incarnation and operation.
	err = runner.call(createCtx, "docker.create", map[string]any{
		"name": name, "image": serverComputerImage, "labels": labels,
		"volumes":    []map[string]any{{"hostPath": root, "containerPath": "/workspace"}},
		"workingDir": "/workspace", "restart": "unless-stopped",
	}, &result)
	if err != nil {
		return computers.CreationResult{}, err
	}
	if err = validateComputerContainer(result, r); err != nil {
		return computers.CreationResult{}, err
	}
	return computers.CreationResult{ExternalID: result.DockerID, RootPath: root}, nil
}

func (p serverComputerProvider) Find(ctx context.Context, r computers.Runtime) (computers.CreationResult, error) {
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
	// A duplicate or mismatched label is not permission to pick the first result.
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
