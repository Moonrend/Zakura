package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

type computerExecKey struct{}

// resolvedExecution is the execution target for one tool call, resolved once at
// dispatch from the immutable Run snapshot. legacy marks the Space server
// computer, whose transport is the Space workspace (host.exec, the workspace
// container, the Space directory); every other computer is pinned to a
// computer runtime. The field keeps its historical name because transports
// outside this file branch on it.
type resolvedExecution struct {
	legacy      bool
	spaceID     string
	nodeID      string
	containerID string
	hostRoot    string
	computer    computers.Computer
	runtime     computers.Runtime
}

func pinnedExecution(ctx context.Context) *resolvedExecution {
	exec, _ := ctx.Value(computerExecKey{}).(*resolvedExecution)
	return exec
}

// serverComputerExecution is the execution target of a Space server computer.
// It has no runtime row: the workspace transports resolve the Space's runtime
// node themselves and fail rather than pick another host when it is offline.
func serverComputerExecution(c computers.Computer) *resolvedExecution {
	return &resolvedExecution{legacy: true, spaceID: c.SpaceID, nodeID: c.RuntimeNodeID, computer: c}
}

// resolveServerComputer returns the execution target of a Space's server
// computer, healing a Space whose server computer is missing.
func (h *handler) resolveServerComputer(ctx context.Context, tenant, space string) (*resolvedExecution, error) {
	c, err := h.computerStore().ServerComputer(ctx, tenant, space)
	if errors.Is(err, computers.ErrNoServerComputer) {
		c, err = h.computerStore().EnsureServerComputer(ctx, tenant, space, h.store.now())
	}
	if err != nil {
		return nil, err
	}
	return serverComputerExecution(c), nil
}

// serverComputerHostRoot returns the absolute directory of the server
// computer's workspace on its runtime node, creating it when missing. It is the
// bind-mount source for anything that must share the workspace filesystem.
func (h *handler) serverComputerHostRoot(ctx context.Context, exec *resolvedExecution) (string, error) {
	if exec == nil || !exec.computer.IsServer() {
		return "", errors.New("not a space server computer")
	}
	if exec.nodeID == "" {
		return "", errors.New("no runtime node bound to this space")
	}
	if err := h.authorizeContextLocalNode(ctx, exec.computer.TenantID, exec.nodeID); err != nil {
		return "", err
	}
	runner, err := h.hub.get(exec.nodeID)
	if err != nil {
		return "", err
	}
	var created struct {
		Abs string `json:"abs"`
	}
	if err = runner.call(ctx, "host.fs.mkdir", map[string]any{"spaceId": exec.spaceID, "path": "/"}, &created); err != nil {
		return "", err
	}
	if strings.TrimSpace(created.Abs) == "" {
		return "", errors.New("runtime node returned no workspace path")
	}
	return created.Abs, nil
}

// resolveExecutionGuard resolves the computer a tool call runs on and never
// falls back to another host. An explicit computerId wins for that call; else
// the Run's pinned computer; else the Space server computer. The server
// computer runs on the Space workspace transport. Every other computer must
// have an active, non-expired runtime; when no active slot exists yet it records
// intent without contacting any provider. A free, self-hosted temporary
// container is then approved and created inline so a chat can execute
// immediately; every other provider (E2B, Railway, SSH) only reserves and
// reports that creation approval is still required. An ambiguous temporary
// create leaves the runtime in Unknown and is never retried.
func (h *handler) resolveExecutionGuard(ctx context.Context, tenant, agent, session string, args []byte) (*resolvedExecution, error) {
	var selection struct {
		ComputerID *string `json:"computerId"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &selection); err != nil {
			return nil, fmt.Errorf("invalid computer selection: %w", err)
		}
	}
	run, _ := ctx.Value(computerRunKey{}).(string)
	if run == "" {
		if session != "" || selection.ComputerID != nil {
			return nil, errors.New("computer execution requires an immutable run target")
		}
		return nil, nil // non-session API; transports use the Space workspace
	}
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	// Bind the context to this exact chat as well as tenant/Space.
	var valid int
	err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT 1 FROM cloud_agent_runs r JOIN cloud_agent_sessions s ON s.id=r.session_id WHERE r.id=? AND s.id=? AND s.tenant_id=? AND s.agent_id=?`), run, session, tenant, agent).Scan(&valid)
	if err != nil {
		return nil, err
	}
	explicit := ""
	if selection.ComputerID != nil {
		explicit = strings.TrimSpace(*selection.ComputerID)
		if explicit == "" {
			return nil, errors.New("computerId must not be empty")
		}
	}
	c, err := h.computerStore().ResolveRunComputer(ctx, tenant, a.SpaceID, run, explicit)
	if errors.Is(err, computers.ErrNoServerComputer) {
		var server *resolvedExecution
		if server, err = h.resolveServerComputer(ctx, tenant, a.SpaceID); err == nil {
			if err := h.authorizeContextLocalNode(ctx, tenant, server.nodeID); err != nil {
				return nil, err
			}
			return server, nil
		}
	}
	if err != nil {
		if explicit != "" && errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("computer %s is not available in this space", explicit)
		}
		return nil, err
	}
	if err := h.authorizeContextLocalNode(ctx, tenant, c.RuntimeNodeID); err != nil {
		return nil, err
	}
	if c.IsServer() {
		return serverComputerExecution(c), nil
	}
	// Computer-scoped execution for adapters that are wired (server containers).
	scope, err := c.Scope(session)
	if err != nil {
		return nil, err
	}
	now := h.store.now()
	active, err := h.computerStore().ActiveRuntime(ctx, tenant, a.SpaceID, c.ID, scope)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		// No active slot yet. ReserveRuntime records intent only (idempotent, no
		// provider call, no cost); a terminal session is surfaced as-is and is
		// never silently recreated.
		reserved, rErr := h.computerStore().ReserveRuntime(ctx, tenant, a.SpaceID, c.ID, scope, now)
		if rErr != nil {
			return nil, rErr
		}
		active = reserved
	}
	// A temporary create whose outcome is unknown is recovered inline: verify
	// whether the container actually exists and, only when it is provably gone,
	// reserve a replacement and approve it in the pending branch below. Server
	// and cloud computers keep the unknown slot for explicit operator action.
	if active.State == computers.Unknown && c.Provider == computers.Temporary {
		replacement, rErr := h.computerProvisioner().PrepareReplacement(ctx, computers.Target{TenantID: tenant, SpaceID: a.SpaceID, ComputerID: c.ID, RuntimeID: active.ID, Incarnation: active.Incarnation}, "system")
		if rErr != nil {
			return nil, fmt.Errorf("computer %s replacement failed: %w", c.ID, rErr)
		}
		active = replacement
		reloaded, reloadErr := h.computerStore().ResolveRunComputer(ctx, tenant, a.SpaceID, run, c.ID)
		if reloadErr != nil {
			return nil, reloadErr
		}
		c = reloaded
	}
	// A pending slot is either the one just reserved or a previous reservation.
	// Only a free, self-hosted temporary container is approved and created inline
	// so the chat can execute immediately; every provider that spends external
	// resources or needs an operator stays pending. An ambiguous temporary create
	// leaves the slot in Unknown and is never retried here.
	if active.State == computers.PendingApproval {
		if c.Provider != computers.Temporary {
			return nil, fmt.Errorf("computer %s is awaiting creation approval; approve it in the computer settings before executing (a chosen computer never falls back to the server computer)", c.ID)
		}
		provisioned, pErr := h.computerProvisioner().ApproveAndCreate(ctx, computers.Target{TenantID: tenant, SpaceID: a.SpaceID, ComputerID: c.ID, RuntimeID: active.ID, Incarnation: active.Incarnation}, active.CreateOperationID, "system")
		if pErr != nil {
			return nil, fmt.Errorf("computer %s automatic provisioning failed: %w", c.ID, pErr)
		}
		active = provisioned
		// Provisioning grants exactly the provider's verified capability set;
		// re-read the computer so CheckTarget authorizes the channels now available.
		refreshed, reloadErr := h.computerStore().ResolveRunComputer(ctx, tenant, a.SpaceID, run, c.ID)
		if reloadErr != nil {
			return nil, reloadErr
		}
		c = refreshed
	}
	target := computers.Target{TenantID: tenant, SpaceID: a.SpaceID, ComputerID: c.ID, RuntimeID: active.ID, Incarnation: active.Incarnation}
	if err = computers.CheckTarget(target, c, active, scope, computers.Commands, false, now); err != nil {
		return nil, err
	}
	if err = h.computerStore().RecordActivity(ctx, target, scope, now); err != nil {
		return nil, err
	}
	return &resolvedExecution{spaceID: a.SpaceID, nodeID: c.RuntimeNodeID, containerID: active.ExternalID, hostRoot: active.RootPath, computer: c, runtime: active}, nil
}

// requireWorkspaceCapability gates transports only the Space server computer's
// workspace implements, such as desktop and browser control, which need the
// display of a container workspace with the computer stack enabled. A call
// without a pinned Run keeps the Space workspace transport.
func requireWorkspaceCapability(ctx context.Context, capability computers.Capability, what string) error {
	if exec := pinnedExecution(ctx); exec != nil && (!exec.legacy || !exec.computer.Has(capability)) {
		return fmt.Errorf("%s is not available on this computer", what)
	}
	return nil
}
