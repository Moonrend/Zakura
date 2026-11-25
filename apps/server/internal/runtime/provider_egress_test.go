// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func TestPublicProviderURLRejectsPrivateDestinations(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1/v1",
		"http://10.0.0.1/v1",
		"http://172.16.0.1/v1",
		"http://192.168.0.1/v1",
		"http://100.64.0.1/v1",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/v1",
		"http://[fc00::1]/v1",
		"http://[64:ff9b::7f00:1]/v1",
		"http://[2002:7f00:1::1]/v1",
		"http://localhost/v1",
		"http://service.internal/v1",
	}
	for _, target := range blocked {
		if _, err := providerURL(target, "", false); err == nil {
			t.Fatalf("accepted non-public provider URL %q", target)
		}
	}
	if _, err := safeProviderURL("http://127.0.0.1/v1", ""); err == nil {
		t.Fatal("safeProviderURL accepted loopback")
	}
	got, err := providerURL("https://api.example.com/v1", "/v1/models", false)
	if err != nil || got.String() != "https://api.example.com/v1/models" {
		t.Fatalf("public provider URL changed: %v %v", got, err)
	}
	if _, err = serviceURL("http://127.0.0.1/v1", ""); err != nil {
		t.Fatalf("intentional internal service URL rejected loopback: %v", err)
	}
}

func TestProviderDialRejectsPrivateDNSAnswers(t *testing.T) {
	for _, answers := range [][]netip.Addr{
		{netip.MustParseAddr("10.0.0.7")},
		{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("::ffff:192.168.1.2")},
	} {
		dialed := false
		lookup := func(context.Context, string) ([]netip.Addr, error) { return answers, nil }
		dial := func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("unexpected dial")
		}
		if _, err := providerDialContext(lookup, dial, false)(context.Background(), "tcp", "provider.example:443"); err == nil {
			t.Fatalf("accepted DNS answers %#v", answers)
		}
		if dialed {
			t.Fatalf("dialed before validating every DNS answer %#v", answers)
		}
	}
}

func TestProviderDialPinsValidatedAddress(t *testing.T) {
	const publicIP = "93.184.216.34"
	var dialed string
	lookupCalls := 0
	lookup := func(context.Context, string) ([]netip.Addr, error) {
		lookupCalls++
		return []netip.Addr{netip.MustParseAddr(publicIP)}, nil
	}
	dial := func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialed = address
		return nil, errors.New("fixture stop")
	}
	_, _ = providerDialContext(lookup, dial, false)(context.Background(), "tcp", "provider.example:443")
	if lookupCalls != 1 || dialed != publicIP+":443" {
		t.Fatalf("lookupCalls=%d dialed=%q", lookupCalls, dialed)
	}
}

func TestProviderRedirectPolicyRevalidatesTarget(t *testing.T) {
	policy := providerRedirectPolicy(false)
	previous := &http.Request{URL: &url.URL{Scheme: "https", Host: "api.example.com", Path: "/v1"}}
	allowed := &http.Request{URL: &url.URL{Scheme: "https", Host: "api.example.com", Path: "/v2"}}
	if err := policy(allowed, []*http.Request{previous}); err != nil {
		t.Fatalf("same-host HTTPS redirect rejected: %v", err)
	}
	for _, target := range []*http.Request{
		{URL: &url.URL{Scheme: "https", Host: "other.example.com"}},
		{URL: &url.URL{Scheme: "http", Host: "api.example.com"}},
		{URL: &url.URL{Scheme: "http", Host: "127.0.0.1"}},
	} {
		if err := policy(target, []*http.Request{previous}); err == nil {
			t.Fatalf("accepted unsafe redirect to %s", target.URL)
		}
	}
	client := newProviderHTTPClient(false)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || transport.DialContext == nil || client.CheckRedirect == nil {
		t.Fatal("provider client lost direct pinned transport or redirect validation")
	}
}

func TestMCPProbeHeaderAllowlist(t *testing.T) {
	headers, err := sanitizeMCPProbeHeaders(map[string]string{"authorization": "Bearer token", "x-api-key": "secret"})
	if err != nil || headers["Authorization"] != "Bearer token" || headers["X-Api-Key"] != "secret" {
		t.Fatalf("probe authentication headers changed: %#v %v", headers, err)
	}
	for _, key := range []string{"Host", "Cookie", "X-Forwarded-For", "Proxy-Authorization"} {
		if _, err = sanitizeMCPProbeHeaders(map[string]string{key: "value"}); err == nil {
			t.Fatalf("accepted probe header %q", key)
		}
	}
}

func TestProviderAdministrationBoundary(t *testing.T) {
	for _, principal := range []httpx.Principal{{Role: "owner"}, {Role: "admin"}, {IsPlatformAdmin: true}} {
		if !providerAdminAllowed(principal) {
			t.Fatalf("administrator rejected: %#v", principal)
		}
	}
	for _, principal := range []httpx.Principal{{Role: "member"}, {Role: "owner", APIKey: true}, {APIKey: true, APIKeyScopes: `["*"]`}} {
		if providerAdminAllowed(principal) {
			t.Fatalf("ordinary principal accepted: %#v", principal)
		}
	}
}

func TestMCPErrorReflectionIsBounded(t *testing.T) {
	detail := boundedMCPErrorDetail([]byte(strings.Repeat("sensitive ", maxMCPErrorText)))
	if len(detail) > maxMCPErrorText+3 || !strings.HasSuffix(detail, "…") {
		t.Fatalf("unbounded MCP error detail length=%d", len(detail))
	}
}
