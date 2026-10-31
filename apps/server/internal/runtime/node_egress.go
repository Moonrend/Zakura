package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

// Node egress policy: which destinations the node's containers may reach and
// through which upstream proxy. The node enforces it (internal network + its
// filtering proxy); the control plane stores it and pushes it on save and on
// every reconnect, so a restarted node never runs without it.

type nodeEgressPolicy struct {
	Mode       string   `json:"mode"`
	Allow      []string `json:"allow"`
	Deny       []string `json:"deny"`
	NoUpstream []string `json:"noUpstream"`
	Upstream   string   `json:"upstream,omitempty"`
	LogAllowed bool     `json:"logAllowed"`
}

// Presets mirror Docker Sandboxes: open, a balanced development allowlist and
// fully locked down. Built-in denies (metadata, node loopback) always apply.
var egressPresets = map[string]nodeEgressPolicy{
	"open": {Mode: "allow"},
	"balanced": {Mode: "deny", Allow: []string{
		"**.github.com", "**.githubusercontent.com", "**.ghcr.io", "**.npmjs.org", "**.npmjs.com", "registry.yarnpkg.com",
		"pypi.org", "files.pythonhosted.org", "**.pypi.org", "proxy.golang.org", "sum.golang.org", "**.crates.io", "static.rust-lang.org",
		"**.docker.io", "**.docker.com", "deb.debian.org", "security.debian.org", "**.ubuntu.com", "**.anthropic.com", "**.openai.com",
	}},
	"locked": {Mode: "deny"},
}

func (h *handler) registerNodeEgress(r chi.Router) {
	r.Get("/runtime-nodes/{id}/egress", h.getNodeEgress)
	r.Put("/runtime-nodes/{id}/egress", h.putNodeEgress)
	r.Get("/settings/network/egress/presets", h.egressPresetsHTTP)
}

func (h *handler) requireNodeOwnerAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	p := principal(r)
	if p.SpaceID != "" || p.AgentID != "" || (p.Role != "owner" && p.Role != "admin" && !p.IsPlatformAdmin) || (p.APIKey && !APIKeyScopeAllows(p, "computers:manage")) {
		httpx.Error(w, http.StatusForbidden, "network administration permission required")
		return "", false
	}
	node := chi.URLParam(r, "id")
	var owner string
	// Only the owning tenant governs a node, including a shared one: tenants
	// borrowing it must not loosen or read another tenant's egress.
	if err := h.deps.DB.QueryRowContext(r.Context(), h.deps.Rebind(`SELECT tenant_id FROM runtime_nodes WHERE id=? AND kind IN ('server','computer')`), node).Scan(&owner); err != nil || owner != p.TenantID {
		httpx.Error(w, http.StatusNotFound, "Not found")
		return "", false
	}
	return node, true
}

func (h *handler) egressPresetsHTTP(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{"presets": egressPresets, "builtinDeny": []string{"169.254.0.0/16", "fe80::/10", "fd00:ec2::254", "100.100.100.200", "127.0.0.0/8", "::1", "metadata.google.internal", "metadata.goog", "metadata.tencentyun.com", "metadata.azure.com"}})
}

func (h *handler) loadNodeEgress(ctx context.Context, node string) (nodeEgressPolicy, map[string]any, error) {
	var row struct {
		Mode, AllowJSON, DenyJSON, NoUpstreamJSON, UpstreamEnc string
		LogAllowed                                             bool
		AppliedAt, ApplyError, UpdatedAt                       sql.NullString
	}
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT mode,allow_json,deny_json,no_upstream_json,upstream_enc,log_allowed,applied_at,apply_error,updated_at FROM node_egress_policies WHERE node_id=?`), node).Scan(&row.Mode, &row.AllowJSON, &row.DenyJSON, &row.NoUpstreamJSON, &row.UpstreamEnc, &row.LogAllowed, &row.AppliedAt, &row.ApplyError, &row.UpdatedAt)
	policy := nodeEgressPolicy{Mode: "off"}
	meta := map[string]any{"appliedAt": nil, "applyError": nil, "updatedAt": nil, "hasUpstream": false}
	if errors.Is(err, sql.ErrNoRows) {
		return policy, meta, nil
	}
	if err != nil {
		return policy, meta, err
	}
	policy.Mode, policy.LogAllowed = row.Mode, row.LogAllowed
	_ = json.Unmarshal([]byte(row.AllowJSON), &policy.Allow)
	_ = json.Unmarshal([]byte(row.DenyJSON), &policy.Deny)
	_ = json.Unmarshal([]byte(row.NoUpstreamJSON), &policy.NoUpstream)
	if row.UpstreamEnc != "" {
		plain, err := openSecretBox(h.deps.Secret, "egress-upstream:"+node, row.UpstreamEnc)
		if err != nil {
			return policy, meta, err
		}
		policy.Upstream = string(plain)
		meta["hasUpstream"] = true
	}
	meta["appliedAt"], meta["applyError"], meta["updatedAt"] = nullableString(row.AppliedAt), nullableString(row.ApplyError), nullableString(row.UpdatedAt)
	return policy, meta, nil
}

// redactedUpstream keeps scheme and host so admins can see where traffic goes,
// but never returns stored credentials.
func redactedUpstream(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	if u.User != nil {
		u.User = url.User("***")
	}
	return u.String()
}

func (h *handler) getNodeEgress(w http.ResponseWriter, r *http.Request) {
	node, ok := h.requireNodeOwnerAdmin(w, r)
	if !ok {
		return
	}
	policy, meta, err := h.loadNodeEgress(r.Context(), node)
	if err != nil {
		statusErr(w, err)
		return
	}
	policy.Upstream = redactedUpstream(policy.Upstream)
	out := map[string]any{"policy": policy, "meta": meta, "live": nil}
	if runner, err := h.hubSession(node); err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		var live map[string]any
		if err := runner.call(ctx, "egress.status", map[string]any{}, &live); err == nil {
			out["live"] = live
		}
		cancel()
	}
	httpx.JSON(w, http.StatusOK, out)
}

func validEgressRules(rules []string) ([]string, error) {
	out := make([]string, 0, len(rules))
	for _, raw := range rules {
		rule := strings.TrimSpace(raw)
		if rule == "" {
			continue
		}
		// Coarse shape check only; the node parses and rejects bad rules too.
		if len(rule) > 253 || strings.ContainsAny(rule, " \t\r\n") || strings.Count(rule, "/") > 1 {
			return nil, errors.New("invalid egress rule: " + rule)
		}
		out = append(out, rule)
	}
	if len(out) > 500 {
		return nil, errors.New("at most 500 egress rules")
	}
	return out, nil
}

func (h *handler) putNodeEgress(w http.ResponseWriter, r *http.Request) {
	node, ok := h.requireNodeOwnerAdmin(w, r)
	if !ok {
		return
	}
	var in struct {
		nodeEgressPolicy
		// KeepUpstream preserves the stored upstream (including its secret)
		// when the admin edits rules without retyping credentials.
		KeepUpstream bool `json:"keepUpstream"`
	}
	if httpx.DecodeJSON(r, &in) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid egress policy")
		return
	}
	policy := in.nodeEgressPolicy
	if policy.Mode != "off" && policy.Mode != "allow" && policy.Mode != "deny" {
		httpx.Error(w, http.StatusBadRequest, "mode must be off, allow or deny")
		return
	}
	var err error
	for _, list := range []*[]string{&policy.Allow, &policy.Deny, &policy.NoUpstream} {
		if *list, err = validEgressRules(*list); err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	current, _, err := h.loadNodeEgress(r.Context(), node)
	if err != nil {
		statusErr(w, err)
		return
	}
	if in.KeepUpstream {
		policy.Upstream = current.Upstream
	} else if policy.Upstream = strings.TrimSpace(policy.Upstream); policy.Upstream != "" {
		u, err := url.Parse(policy.Upstream)
		if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "socks5" && u.Scheme != "socks5h" {
			httpx.Error(w, http.StatusBadRequest, "upstream proxy must be http:// or socks5://")
			return
		}
	}
	sealed := ""
	if policy.Upstream != "" {
		if sealed, err = secretBox(h.deps.Secret, "egress-upstream:"+node, []byte(policy.Upstream)); err != nil {
			statusErr(w, err)
			return
		}
	}
	allow, _ := json.Marshal(policy.Allow)
	deny, _ := json.Marshal(policy.Deny)
	noUp, _ := json.Marshal(policy.NoUpstream)
	stamp := runtimeTimeString(h.store.now())
	p := principal(r)
	if _, err = h.deps.DB.ExecContext(r.Context(), h.deps.Rebind(`INSERT INTO node_egress_policies(node_id,tenant_id,mode,allow_json,deny_json,no_upstream_json,upstream_enc,log_allowed,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(node_id) DO UPDATE SET mode=excluded.mode,allow_json=excluded.allow_json,deny_json=excluded.deny_json,no_upstream_json=excluded.no_upstream_json,upstream_enc=excluded.upstream_enc,log_allowed=excluded.log_allowed,updated_by=excluded.updated_by,updated_at=excluded.updated_at,applied_at=NULL,apply_error=NULL`),
		node, p.TenantID, policy.Mode, string(allow), string(deny), string(noUp), sealed, policy.LogAllowed, p.UserID, stamp); err != nil {
		statusErr(w, err)
		return
	}
	applyErr := h.pushNodeEgress(r.Context(), node)
	policy.Upstream = redactedUpstream(policy.Upstream)
	out := map[string]any{"policy": policy, "applied": applyErr == nil}
	if applyErr != nil {
		// Saved durably; the node gets it on its next connection.
		out["applyError"] = applyErr.Error()
	}
	httpx.JSON(w, http.StatusOK, out)
}

// pushNodeEgress sends the stored policy to a connected node and records the
// outcome. Offline nodes receive it during their next handshake.
func (h *handler) pushNodeEgress(ctx context.Context, node string) error {
	policy, meta, err := h.loadNodeEgress(ctx, node)
	if err != nil {
		return err
	}
	if meta["updatedAt"] == nil {
		// Never configured: leave the node at its default (no confinement).
		return nil
	}
	runner, err := h.hubSession(node)
	if err != nil {
		return err
	}
	var capabilities string
	_ = h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT capabilities_json FROM runtime_nodes WHERE id=?`), node).Scan(&capabilities)
	var caps map[string]any
	_ = json.Unmarshal([]byte(capabilities), &caps)
	if supported, _ := caps["egressPolicy"].(bool); !supported {
		err = errors.New("node does not support egress policy; upgrade the node")
	} else {
		callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err = runner.call(callCtx, "egress.apply", policy, nil)
		cancel()
	}
	stamp := runtimeTimeString(h.store.now())
	if err != nil {
		_, _ = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE node_egress_policies SET apply_error=? WHERE node_id=?`), err.Error(), node)
		return err
	}
	_, _ = h.deps.DB.ExecContext(ctx, h.deps.Rebind(`UPDATE node_egress_policies SET applied_at=?,apply_error=NULL WHERE node_id=?`), stamp, node)
	return nil
}
