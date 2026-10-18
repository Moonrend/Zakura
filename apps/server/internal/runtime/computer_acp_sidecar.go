// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// ACP adapters run inside a dedicated per-computer sidecar container that shares
// the computer's workspace bind mount. The sidecar never receives the Docker
// socket, published ports, or privileged mode, and it is reused per computer so
// concurrent ACP sessions start as separate processes inside the same sidecar.
const acpSidecarImage = "sunwuyuan/zakura-acp-sidecar-dev:latest"

type acpSidecarContainer struct {
	DockerID string            `json:"dockerId"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Status   string            `json:"status"`
	Labels   map[string]string `json:"labels"`
}

// acpSidecarIdentity names the per-computer sidecar deterministically. The
// "acp-sidecar" salt and purpose keep it from colliding with the computer's own
// workspace container, which uses the same runtime identity otherwise.
func acpSidecarIdentity(r computers.Runtime) (string, map[string]string) {
	raw, _ := json.Marshal([]string{"acp-sidecar", r.TenantID, r.SpaceID, r.ComputerID, r.ID, r.Incarnation, r.CreateOperationID})
	digest := sha256.Sum256(raw)
	name := "zakura-acp-sidecar-" + hex.EncodeToString(digest[:])
	return name, map[string]string{
		"zakura.purpose": "acp-sidecar", "zakura.tenant": r.TenantID,
		"zakura.space": r.SpaceID, "zakura.computer": r.ComputerID,
		"zakura.runtime": r.ID, "zakura.incarnation": r.Incarnation,
		"zakura.operation": r.CreateOperationID,
	}
}

// resolveACPHost always resolves the Space server computer. A selected tool
// computer is independent of where ACP and its credentials are stored.
func resolveACPHost(ctx context.Context, h *handler, tenantID, agentID, sid string) (*resolvedExecution, error) {
	a, err := h.store.GetAgent(ctx, tenantID, agentID)
	if err != nil {
		return nil, err
	}
	exec, err := h.resolveServerComputer(ctx, tenantID, a.SpaceID)
	if err != nil {
		return nil, err
	}
	if exec.nodeID == "" {
		return nil, errors.New("no runtime node bound to this space")
	}
	if err := h.authorizeContextLocalNode(ctx, tenantID, exec.nodeID); err != nil {
		return nil, err
	}
	if sid != "" {
		sess, err := h.store.GetSession(ctx, tenantID, agentID, sid)
		if err != nil {
			return nil, err
		}
		if pinned := pinnedACPHost(sess); pinned != "" && pinned != exec.computer.ID {
			return nil, errors.New("ACP session host computer changed; start a new session")
		}
	}
	return exec, nil
}

// sessionSelectedComputer loads the full configuration of a session's selected
// computer from the Space catalog. The computers package exposes no
// session-scoped resolution, so the read-only List result is filtered by ID.
func (h *handler) sessionSelectedComputer(ctx context.Context, tenantID, spaceID, computerID string) (computers.Computer, error) {
	list, err := h.computerStore().List(ctx, tenantID, spaceID)
	if err != nil {
		return computers.Computer{}, err
	}
	for _, candidate := range list {
		if candidate.ID == computerID {
			return candidate, nil
		}
	}
	return computers.Computer{}, fmt.Errorf("selected computer %s is not available in this space", computerID)
}

// pinnedACPHost reads the host computer pinned into a session's Origin once ACP
// has started. An empty result means the session has not been pinned yet.
func pinnedACPHost(sess Session) string {
	if len(sess.Origin) == 0 {
		return ""
	}
	var origin struct {
		ACPComputerID string `json:"acpComputerId"`
	}
	_ = json.Unmarshal(sess.Origin, &origin)
	return origin.ACPComputerID
}

// ensureACPSidecar returns the Docker ID of the computer's ACP sidecar, creating
// it on first use. The sidecar shares the computer's workspace bind mount and
// is reused per computer; only the adapter process differs between sessions.
func (h *handler) ensureACPSidecar(ctx context.Context, exec *resolvedExecution) (string, error) {
	if exec == nil || exec.computer.ID == "" || exec.nodeID == "" {
		return "", errors.New("ACP sidecar requires a persistent server computer")
	}
	if strings.TrimSpace(exec.hostRoot) == "" {
		return "", errors.New("computer runtime has no workspace root for the ACP sidecar")
	}
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		return "", err
	}
	name, labels := acpSidecarIdentity(exec.runtime)
	// docker.list accepts a single label filter, so scope by computer and then
	// verify purpose, image, running state, and the full ownership identity.
	var existing []acpSidecarContainer
	if err = runner.call(ctx, "docker.list", map[string]any{"label": "zakura.computer=" + exec.computer.ID}, &existing); err != nil {
		return "", err
	}
	for _, container := range existing {
		if matchesACPSidecar(container, name, labels) {
			return container.DockerID, nil
		}
	}
	var created acpSidecarContainer
	err = runner.call(ctx, "docker.create", map[string]any{
		"name": name, "image": acpSidecarImage, "labels": labels,
		"volumes":    []map[string]any{{"hostPath": exec.hostRoot, "containerPath": "/workspace"}},
		"workingDir": "/workspace", "restart": "unless-stopped",
	}, &created)
	if err != nil {
		return "", err
	}
	if !matchesACPSidecar(created, name, labels) {
		return "", errors.New("ACP sidecar container identity or running state could not be verified")
	}
	return created.DockerID, nil
}

func matchesACPSidecar(c acpSidecarContainer, name string, labels map[string]string) bool {
	if c.DockerID == "" || strings.TrimPrefix(c.Name, "/") != name || c.Image != acpSidecarImage || c.Status != "running" {
		return false
	}
	for key, value := range labels {
		if c.Labels[key] != value {
			return false
		}
	}
	return true
}
