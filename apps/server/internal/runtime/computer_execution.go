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
// dispatch from the immutable Run snapshot. legacy keeps the transitional
// Space-based transports; anything else is pinned to a computer runtime.
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

// resolveExecutionGuard resolves the pinned run computer into an execution
// target and never falls back: legacy computers must still match the Space
// configuration, and new computers must have an active, non-expired runtime.
// When no active slot exists yet it records intent without contacting any
// provider. A free, self-hosted temporary container is then approved and created
// inline so a chat can execute immediately; every other provider (E2B, Railway,
// SSH) only reserves and reports that creation approval is still required. An
// ambiguous temporary create leaves the runtime in Unknown and is never retried.
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
		return nil, nil // non-session legacy API; no selection was offered
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
	if err != nil {
		return nil, err
	}
	var legacyScope, kind, node, image sql.NullString
	err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT legacy_workspace_scope,legacy_workspace_kind,runtime_node_id,workspace_image FROM computers WHERE id=? AND tenant_id=? AND space_id=?`), c.ID, tenant, a.SpaceID).Scan(&legacyScope, &kind, &node, &image)
	if err != nil {
		return nil, err
	}
	if legacyScope.Valid && legacyScope.String == a.SpaceID {
		space, err := h.store.GetSpace(ctx, tenant, a.SpaceID)
		if err != nil {
			return nil, err
		}
		currentNode, currentImage := "", ""
		if space.RuntimeNodeID != nil {
			currentNode = *space.RuntimeNodeID
		}
		if space.WorkspaceImage != nil {
			currentImage = *space.WorkspaceImage
		}
		if !space.EnableComputer || node.String != currentNode || kind.String != space.WorkspaceKind || image.String != currentImage {
			return nil, errors.New("legacy computer configuration changed; refusing execution on an unbound workspace")
		}
		return &resolvedExecution{legacy: true, spaceID: a.SpaceID, nodeID: node.String}, nil
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
			return nil, fmt.Errorf("computer %s is awaiting creation approval; approve it in the computer settings before executing; refusing legacy workspace fallback", c.ID)
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

// refuseNonLegacyExecution blocks transports that are not wired for dedicated
// computer containers yet; a pinned legacy run is unaffected.
func refuseNonLegacyExecution(ctx context.Context, what string) error {
	if exec := pinnedExecution(ctx); exec != nil && !exec.legacy {
		return fmt.Errorf("%s is not available on this computer", what)
	}
	return nil
}
