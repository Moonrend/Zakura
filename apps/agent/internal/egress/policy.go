// Package egress is the node's outbound filter for workspace containers. They
// sit on an internal Docker network with no route out; this proxy, bound on that
// network's gateway, is the only exit, and it applies the administrator policy.
package egress

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

// Policy is pushed by the control plane. Deny always wins over allow; the
// built-in denies cannot be removed.
type Policy struct {
	// Mode "allow" permits anything not denied; "deny" permits only matches of
	// Allow. "off" disables enforcement (containers keep the default bridge).
	Mode  string   `json:"mode"`
	Allow []string `json:"allow"`
	Deny  []string `json:"deny"`
	// Upstream is an optional parent proxy: http://, https:// or socks5://,
	// with optional user:password.
	Upstream string `json:"upstream"`
	// NoUpstream lists destinations dialed directly even when Upstream is set.
	NoUpstream []string `json:"noUpstream"`
	// Log records every decision when true; denials are always logged.
	LogAllowed bool `json:"logAllowed"`
}

// builtinDeny protects the node and cloud credentials. Link-local covers the
// metadata endpoints of AWS, GCP, Azure, OpenStack, Tencent (169.254.0.23) and
// ECS task credentials (169.254.170.2); the other entries are vendors that use
// addresses outside link-local. Loopback and the unspecified address keep a
// container from reaching services on the node itself through the proxy.
var builtinDeny = []string{
	"169.254.0.0/16", "fe80::/10", "fd00:ec2::254/128", "100.100.100.200/32",
	"127.0.0.0/8", "::1/128", "0.0.0.0/8", "::/128",
	"metadata.google.internal", "metadata.goog", "metadata.tencentyun.com", "metadata.azure.com",
}

// BuiltinDeny is shown read-only in the admin UI.
func BuiltinDeny() []string { return append([]string(nil), builtinDeny...) }

type rule struct {
	prefix   netip.Prefix
	host     string // exact host, or suffix when wildcard
	wildcard bool   // *.example.com matches subdomains only; **.example.com also matches the apex
	apex     bool
	port     int // 0 = any
}

type compiled struct {
	mode  string
	allow []rule
	deny  []rule
}

func parseRule(raw string) (rule, error) {
	text := strings.ToLower(strings.TrimSpace(raw))
	if text == "" {
		return rule{}, fmt.Errorf("empty rule")
	}
	var r rule
	if prefix, err := netip.ParsePrefix(text); err == nil {
		r.prefix = prefix.Masked()
		return r, nil
	}
	if addr, err := netip.ParseAddr(strings.Trim(text, "[]")); err == nil {
		r.prefix = netip.PrefixFrom(addr, addr.BitLen())
		return r, nil
	}
	host := text
	if h, p, err := net.SplitHostPort(text); err == nil {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return rule{}, fmt.Errorf("invalid port in %q", raw)
		}
		host, r.port = h, port
		if addr, err := netip.ParseAddr(host); err == nil {
			r.prefix = netip.PrefixFrom(addr, addr.BitLen())
			return r, nil
		}
	}
	switch {
	case strings.HasPrefix(host, "**."):
		r.wildcard, r.apex, host = true, true, strings.TrimPrefix(host, "**.")
	case strings.HasPrefix(host, "*."):
		r.wildcard, host = true, strings.TrimPrefix(host, "*.")
	}
	if host == "" || strings.ContainsAny(host, "*/ ") {
		return rule{}, fmt.Errorf("invalid rule %q", raw)
	}
	r.host = strings.TrimSuffix(host, ".")
	return r, nil
}

// Validate reports the first unparsable rule so the admin sees it on save.
func (p Policy) Validate() error {
	switch p.Mode {
	case "", "off", "allow", "deny":
	default:
		return fmt.Errorf("mode must be off, allow or deny")
	}
	for _, list := range [][]string{p.Allow, p.Deny, p.NoUpstream} {
		for _, raw := range list {
			if _, err := parseRule(raw); err != nil {
				return err
			}
		}
	}
	if p.Upstream != "" {
		if _, err := parseUpstream(p.Upstream); err != nil {
			return err
		}
	}
	return nil
}

func compile(p Policy) (compiled, error) {
	c := compiled{mode: p.Mode}
	if c.mode == "" {
		c.mode = "allow"
	}
	for _, raw := range p.Allow {
		r, err := parseRule(raw)
		if err != nil {
			return c, err
		}
		c.allow = append(c.allow, r)
	}
	for _, raw := range append(append([]string(nil), builtinDeny...), p.Deny...) {
		r, err := parseRule(raw)
		if err != nil {
			return c, err
		}
		c.deny = append(c.deny, r)
	}
	return c, nil
}

func (r rule) matchHost(host string, port int) bool {
	if r.host == "" || r.port != 0 && r.port != port {
		return false
	}
	if !r.wildcard {
		return host == r.host
	}
	return strings.HasSuffix(host, "."+r.host) || r.apex && host == r.host
}

func (r rule) matchAddr(addr netip.Addr, port int) bool {
	return r.prefix.IsValid() && (r.port == 0 || r.port == port) && r.prefix.Contains(addr.Unmap())
}

// decide checks the requested name and every address it resolves to. A name
// that is allowed but resolves into a denied range is refused, which defeats
// DNS rebinding onto metadata or node-local services.
func (c compiled) decide(host string, port int, addrs []netip.Addr) (bool, string) {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, r := range c.deny {
		if r.matchHost(host, port) {
			return false, "denied host"
		}
		for _, addr := range addrs {
			if r.matchAddr(addr, port) {
				return false, "denied address " + addr.String()
			}
		}
	}
	if c.mode != "deny" {
		return true, "allowed"
	}
	for _, r := range c.allow {
		if r.matchHost(host, port) {
			return true, "allow rule"
		}
	}
	if len(addrs) > 0 {
		// Every resolved address must be allowed, otherwise a name could point
		// one record inside the allowlist and another outside it.
		for _, addr := range addrs {
			ok := false
			for _, r := range c.allow {
				if r.matchAddr(addr, port) {
					ok = true
					break
				}
			}
			if !ok {
				return false, "not in allowlist"
			}
		}
		return true, "allow rule"
	}
	return false, "not in allowlist"
}

func matchesAny(rules []rule, host string, port int, addrs []netip.Addr) bool {
	for _, r := range rules {
		if r.matchHost(host, port) {
			return true
		}
		for _, addr := range addrs {
			if r.matchAddr(addr, port) {
				return true
			}
		}
	}
	return false
}
