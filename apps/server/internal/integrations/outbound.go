// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type resolveIPsFunc func(context.Context, string) ([]net.IP, error)
type dialContextFunc func(context.Context, string, string) (net.Conn, error)

var wellKnownNAT64Prefix = netip.MustParsePrefix("64:ff9b::/96")

var nonPublicIPPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("::ffff:0:0:0/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("fec0::/10"),
}

func isPublicIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if wellKnownNAT64Prefix.Contains(addr) {
		bytes := addr.As16()
		return isPublicIP(net.IPv4(bytes[12], bytes[13], bytes[14], bytes[15]))
	}
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range nonPublicIPPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func connectorURL(raw string) (string, error) {
	target, err := safeURL(raw)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(target)
	host := strings.Trim(u.Hostname(), "[]")
	if strings.Contains(host, "%") {
		return "", errors.New("unsafe endpoint")
	}
	if ip := net.ParseIP(host); ip != nil && !isPublicIP(ip) {
		return "", errors.New("unsafe endpoint")
	}
	return target, nil
}

func lookupConnectorIPs(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		ips = append(ips, address.IP)
	}
	return ips, nil
}

func resolvePublicIPs(ctx context.Context, resolve resolveIPsFunc, host string) ([]net.IP, error) {
	if host == "" || resolve == nil {
		return nil, errors.New("unsafe endpoint")
	}
	ips, err := resolve(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("endpoint could not be resolved")
	}
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return nil, errors.New("unsafe endpoint")
		}
	}
	return ips, nil
}

func publicDialContext(resolve resolveIPsFunc, dial dialContextFunc) dialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid endpoint address")
		}
		ips, err := resolvePublicIPs(ctx, resolve, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, ip := range ips {
			conn, dialErr := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, fmt.Errorf("endpoint connection failed: %w", lastErr)
	}
}

func newConnectorHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// A proxy would resolve the target itself and bypass the validated, pinned destination.
	transport.Proxy = nil
	transport.DialContext = publicDialContext(lookupConnectorIPs, dialer.DialContext)
	transport.DialTLSContext = nil
	return &http.Client{
		Transport: transport,
		Timeout:   60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
