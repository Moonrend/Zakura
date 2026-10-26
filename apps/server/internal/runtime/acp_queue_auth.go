// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

// A receipt is an in-process admission proof, never serialized into queue
// Options/events. Restart, runtime replacement, grant rotation, or queue edits
// require resubmission rather than borrowing the session creator's authority.
type acpQueueReceipt struct {
	actor      httpx.Principal
	runtime    *acpLiveRuntime
	generation string
	digest     string
	expires    time.Time
	timer      *time.Timer
}

type acpQueueContextKey struct{}

func acpQueueKey(tenant, agent, session, id string) string {
	return tenant + "\x00" + agent + "\x00" + session + "\x00" + id
}
func acpQueueDigest(m QueueMessage) string {
	var attachments, options any
	_ = json.Unmarshal(m.Attachments, &attachments)
	_ = json.Unmarshal(m.Options, &options)
	raw, _ := json.Marshal([]any{m.ID, m.Content, attachments, options, m.UserID, m.UserName})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
func (h *handler) requiresACPQueueReceipt(ctx context.Context, tenant, agent, session string) (bool, error) {
	if h.acp != nil {
		h.acp.mu.Lock()
		rt := h.acp.runtimes[tenant+"\x00"+session]
		attached := rt != nil && rt.mcpGrantHash != ""
		h.acp.mu.Unlock()
		if attached {
			return true, nil
		}
	}
	a, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return false, err
	}
	var count int
	err = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COUNT(*) FROM component_instances i JOIN agent_bindings b ON b.tenant_id=i.tenant_id AND b.instance_id=i.id WHERE i.tenant_id=? AND b.space_id=? AND b.agent_id IS NULL AND i.component_type='mcp' AND i.status IN ('ready','running')`), tenant, a.SpaceID).Scan(&count)
	return count != 0, err
}
func (h *handler) admitACPQueue(ctx context.Context, tenant, agent, session string) (*acpQueueReceipt, error) {
	required, err := h.requiresACPQueueReceipt(ctx, tenant, agent, session)
	if err != nil || !required {
		return nil, err
	}
	actor, exists := httpx.PrincipalFrom(ctx)
	if !exists {
		return nil, errors.New("ACP queued MCP request requires its authenticated source actor")
	}
	rt, err := h.acp.ensure(ctx, tenant, agent, session)
	if err != nil {
		return nil, err
	}
	rt.manager.mu.Lock()
	grant := rt.manager.mcpGrants[rt.mcpGrantHash]
	generation := rt.mcpGrantHash
	rt.manager.mu.Unlock()
	if grant == nil || !sameACPMCPActor(actor, grant.actor) {
		return nil, errors.New("ACP queued actor has no matching MCP grant; reopen and resend")
	}
	return &acpQueueReceipt{actor: actor, runtime: rt, generation: generation, expires: grant.expires}, nil
}
func (s *Service) rememberACPQueueReceipt(tenant, agent, session string, m QueueMessage, receipt *acpQueueReceipt) {
	receipt.digest = acpQueueDigest(m)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acpQueueReceipts == nil {
		s.acpQueueReceipts = map[string]*acpQueueReceipt{}
	}
	for key, old := range s.acpQueueReceipts {
		if !old.expires.After(s.store.now()) {
			if old.timer != nil {
				old.timer.Stop()
			}
			delete(s.acpQueueReceipts, key)
		}
	}
	key := acpQueueKey(tenant, agent, session, m.ID)
	if old := s.acpQueueReceipts[key]; old != nil {
		if old.timer != nil {
			old.timer.Stop()
		}
		delete(s.acpQueueReceipts, key)
	}
	if len(s.acpQueueReceipts) >= 4096 || !receipt.expires.After(s.store.now()) {
		return // The queued message stays fail-closed without a receipt.
	}
	s.acpQueueReceipts[key] = receipt
	// A bounded expiry also covers deletion paths outside HTTP. Stop the timer
	// on execution/deletion so it does not retain the runtime until the deadline.
	receipt.timer = time.AfterFunc(receipt.expires.Sub(s.store.now()), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.acpQueueReceipts[key] == receipt {
			delete(s.acpQueueReceipts, key)
		}
	})
}
func (s *Service) forgetACPQueueReceipt(tenant, agent, session, id string) {
	s.mu.Lock()
	key := acpQueueKey(tenant, agent, session, id)
	if receipt := s.acpQueueReceipts[key]; receipt != nil && receipt.timer != nil {
		receipt.timer.Stop()
	}
	delete(s.acpQueueReceipts, key)
	s.mu.Unlock()
}
func (s *Service) acpQueuedContext(ctx context.Context, tenant, agent, session string, m QueueMessage) (context.Context, error) {
	key := acpQueueKey(tenant, agent, session, m.ID)
	s.mu.Lock()
	receipt := s.acpQueueReceipts[key]
	s.mu.Unlock()
	if receipt == nil {
		if s.acpQueueRequired == nil {
			return ctx, nil
		}
		required, err := s.acpQueueRequired(ctx, tenant, agent, session)
		if err != nil {
			return ctx, err
		}
		if !required {
			return ctx, nil
		}
		return ctx, errors.New("ACP queued source unavailable after restart; remove and resend this message")
	}
	invalid := errors.New("ACP queued source or message changed; remove and resend this message")
	if !receipt.expires.After(s.store.now()) || receipt.digest != acpQueueDigest(m) {
		s.forgetACPQueueReceipt(tenant, agent, session, m.ID)
		return ctx, invalid
	}
	rt := receipt.runtime
	rt.manager.mu.Lock()
	generation := rt.mcpGrantHash
	rt.manager.mu.Unlock()
	if generation != receipt.generation || rt.tenantID != tenant || rt.agentID != agent || rt.sid != session {
		return ctx, invalid
	}
	trusted := context.WithValue(httpx.WithPrincipal(ctx, receipt.actor), acpQueueContextKey{}, receipt)
	if err := rt.validateMCPCaller(trusted); err != nil {
		return ctx, err
	}
	if err := validateACPQueueExecution(trusted, rt); err != nil {
		return ctx, err
	}
	return trusted, nil
}

// Recheck after ensure as well as dequeue: an explicit reconnect may replace the
// runtime between those steps. The old message never inherits the new grant.
func validateACPQueueExecution(ctx context.Context, rt *acpLiveRuntime) error {
	receipt, _ := ctx.Value(acpQueueContextKey{}).(*acpQueueReceipt)
	if receipt == nil {
		return nil
	}
	invalid := errors.New("ACP queued runtime changed; remove and resend this message")
	if receipt.runtime != rt || !receipt.expires.After(rt.manager.h.store.now()) {
		return invalid
	}
	rt.manager.mu.Lock()
	grant := rt.manager.mcpGrants[receipt.generation]
	valid := rt.mcpGrantHash == receipt.generation && grant != nil && grant.runtime == rt
	rt.manager.mu.Unlock()
	select {
	case <-rt.done:
		return invalid
	default:
	}
	if !valid {
		return invalid
	}
	return nil
}
