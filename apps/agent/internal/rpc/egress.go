package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"runtime"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/egress"
)

const egressProxyPort = "3128"

var (
	egressOnce  sync.Once
	egressProxy *egress.Proxy
)

func proxyInstance() *egress.Proxy {
	egressOnce.Do(func() { egressProxy = egress.New() })
	return egressProxy
}

// egressApply installs the administrator policy. "off" returns containers to
// the default bridge; any other mode confines new containers to the internal
// network whose only exit is the proxy. Running containers keep their network
// until they are recreated, which the response reports.
func (h *Handler) egressApply(ctx context.Context, raw json.RawMessage) (any, error) {
	var policy egress.Policy
	if err := json.Unmarshal(raw, &policy); err != nil {
		return nil, err
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	p := proxyInstance()
	if policy.Mode == "off" {
		docker.SetEgress("", "")
		_ = p.Close()
		_ = p.SetPolicy(policy)
		return h.egressStatus(), nil
	}
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("egress enforcement requires a Linux node with Docker")
	}
	gateway, err := docker.EnsureEgressNetwork(ctx)
	if err != nil {
		return nil, err
	}
	if err := docker.GuardEgressHost(ctx, egressProxyPort); err != nil {
		// Without the host guard, containers could reach node services through
		// the gateway; refuse to report the policy as active.
		return nil, err
	}
	if err := p.SetPolicy(policy); err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(gateway, egressProxyPort)
	if p.Addr() != addr {
		if err := p.Listen(addr); err != nil {
			return nil, fmt.Errorf("bind egress proxy on %s: %w", addr, err)
		}
	}
	docker.SetEgress(docker.EgressNetworkName, "http://"+addr)
	return h.egressStatus(), nil
}

func (h *Handler) egressStatus() map[string]any {
	p := proxyInstance()
	audit, allowed, denied := p.Audit()
	if len(audit) > 200 {
		audit = audit[len(audit)-200:]
	}
	policy := p.Policy()
	// Never echo upstream credentials back to the control plane.
	policy.Upstream = redactUpstream(policy.Upstream)
	return map[string]any{"policy": policy, "proxy": p.Addr(), "builtinDeny": egress.BuiltinDeny(), "allowed": allowed, "denied": denied, "recent": audit}
}

func redactUpstream(raw string) string {
	if at := strings.LastIndex(raw, "@"); at > 0 {
		if scheme := strings.Index(raw, "://"); scheme >= 0 && scheme < at {
			return raw[:scheme+3] + "***@" + raw[at+1:]
		}
	}
	return raw
}
