// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"
)

type providerLookup func(context.Context, string) ([]netip.Addr, error)
type providerDial func(context.Context, string, string) (net.Conn, error)

var nonPublicProviderPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
	netip.MustParsePrefix("fec0::/10"),
}

func publicProviderIP(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicProviderPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func validateProviderURL(u *url.URL, allowPrivate bool) error {
	if u == nil || u.Host == "" || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("upstream baseUrl must be an absolute http(s) URL")
	}
	if u.User != nil {
		return errors.New("credentials in upstream URL are not allowed")
	}
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(u.Hostname())), ".")
	if host == "" {
		return errors.New("upstream baseUrl must include a host")
	}
	if !allowPrivate && (host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal")) {
		return errors.New("unsafe upstream address")
	}
	if addr, err := netip.ParseAddr(host); err == nil && !allowPrivate && !publicProviderIP(addr) {
		return errors.New("unsafe upstream address")
	}
	return nil
}

func providerURL(baseURL, endpoint string, allowPrivate bool) (*url.URL, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	if err = validateProviderURL(u, allowPrivate); err != nil {
		return nil, err
	}
	basePath := strings.TrimSuffix(u.Path, "/")
	if strings.HasPrefix(endpoint, "/v1/") && strings.HasSuffix(basePath, "/v1") {
		endpoint = strings.TrimPrefix(endpoint, "/v1")
	}
	u.Path = path.Join(basePath, endpoint)
	u.RawPath = ""
	u.Fragment = ""
	return u, nil
}

func safeProviderURL(baseURL, endpoint string) (*url.URL, error) {
	return providerURL(baseURL, endpoint, false)
}

func serviceURL(baseURL, endpoint string) (*url.URL, error) {
	u, err := providerURL(baseURL, endpoint, true)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(strings.Trim(u.Hostname(), "[]")); ip != nil && (ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return nil, errors.New("unsafe upstream address")
	}
	return u, nil
}

func (h *handler) providerURL(baseURL, endpoint string) (*url.URL, error) {
	if h != nil && h.service != nil && h.service.gateway != nil {
		return h.service.gateway.providerURL(baseURL, endpoint)
	}
	return providerURL(baseURL, endpoint, false)
}

func resolveProviderIPs(ctx context.Context, host string, lookup providerLookup, allowPrivate bool) ([]netip.Addr, error) {
	if addr, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		if !allowPrivate && !publicProviderIP(addr) {
			return nil, errors.New("unsafe upstream address")
		}
		return []netip.Addr{addr.Unmap()}, nil
	}
	addrs, err := lookup(ctx, host)
	if err != nil || len(addrs) == 0 {
		return nil, errors.New("upstream host could not be resolved")
	}
	for _, addr := range addrs {
		if !allowPrivate && !publicProviderIP(addr) {
			return nil, errors.New("upstream host resolved to a non-public address")
		}
	}
	return addrs, nil
}

func providerDialContext(lookup providerLookup, dial providerDial, allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid upstream address")
		}
		addrs, err := resolveProviderIPs(ctx, host, lookup, allowPrivate)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, addr := range addrs {
			conn, dialErr := dial(ctx, network, net.JoinHostPort(addr.Unmap().String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, fmt.Errorf("upstream connection failed: %w", lastErr)
	}
}

func sameProviderRedirectHost(current, previous *url.URL) bool {
	if current == nil || previous == nil {
		return false
	}
	currentHost := strings.TrimSuffix(strings.ToLower(current.Hostname()), ".")
	previousHost := strings.TrimSuffix(strings.ToLower(previous.Hostname()), ".")
	return currentHost != "" && currentHost == previousHost
}

func providerRedirectPolicy(allowPrivate bool) func(*http.Request, []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many upstream redirects")
		}
		if err := validateProviderURL(req.URL, allowPrivate); err != nil {
			return err
		}
		if len(via) > 0 {
			previous := via[len(via)-1].URL
			if !sameProviderRedirectHost(req.URL, previous) || previous.Scheme == "https" && req.URL.Scheme != "https" {
				return errors.New("cross-origin upstream redirect is not allowed")
			}
		}
		return nil
	}
}

func providerTransport(dialContext func(context.Context, string, string) (net.Conn, error)) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dialContext
	transport.DialTLSContext = nil
	transport.MaxIdleConns = 256
	transport.MaxIdleConnsPerHost = 64
	transport.ResponseHeaderTimeout = 90 * time.Second
	return transport
}

func newProviderHTTPClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	lookup := func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	return &http.Client{
		Transport:     providerTransport(providerDialContext(lookup, dialer.DialContext, allowPrivate)),
		CheckRedirect: providerRedirectPolicy(allowPrivate),
	}
}

func newPinnedProviderHTTPClient(addr netip.Addr) *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	dialContext := func(ctx context.Context, network, address string) (net.Conn, error) {
		_, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid runtime MCP address")
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(addr.Unmap().String(), port))
	}
	return &http.Client{
		Transport: providerTransport(dialContext),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("runtime MCP redirects are not allowed")
		},
	}
}
