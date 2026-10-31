package egress

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func addrs(values ...string) []netip.Addr {
	out := make([]netip.Addr, 0, len(values))
	for _, v := range values {
		out = append(out, netip.MustParseAddr(v))
	}
	return out
}

func TestPolicyDecisions(t *testing.T) {
	allowAll, err := compile(Policy{Mode: "allow", Deny: []string{"*.blocked.test", "10.0.0.0/8"}})
	if err != nil {
		t.Fatal(err)
	}
	locked, err := compile(Policy{Mode: "deny", Allow: []string{"**.github.com", "pypi.org:443", "203.0.113.0/24"}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		c     compiled
		host  string
		port  int
		addrs []netip.Addr
		want  bool
	}{
		{"open public", allowAll, "example.com", 443, addrs("93.184.215.14"), true},
		{"aws metadata", allowAll, "169.254.169.254", 80, addrs("169.254.169.254"), false},
		{"tencent metadata", allowAll, "169.254.0.23", 80, addrs("169.254.0.23"), false},
		{"ecs credentials", allowAll, "169.254.170.2", 80, addrs("169.254.170.2"), false},
		{"aliyun metadata", allowAll, "100.100.100.200", 80, addrs("100.100.100.200"), false},
		{"aws ipv6 metadata", allowAll, "fd00:ec2::254", 80, addrs("fd00:ec2::254"), false},
		{"gcp metadata name", allowAll, "metadata.google.internal", 80, nil, false},
		{"rebinding to metadata", allowAll, "evil.example", 80, addrs("169.254.169.254"), false},
		{"mapped v4 metadata", allowAll, "evil.example", 80, addrs("::ffff:169.254.169.254"), false},
		{"node loopback", allowAll, "localhost", 18788, addrs("127.0.0.1"), false},
		{"admin deny wildcard", allowAll, "a.blocked.test", 443, addrs("198.51.100.1"), false},
		{"admin deny cidr", allowAll, "intranet", 443, addrs("10.1.2.3"), false},
		{"locked apex", locked, "github.com", 443, addrs("140.82.112.3"), true},
		{"locked sub", locked, "api.github.com", 443, addrs("140.82.112.6"), true},
		{"locked port mismatch", locked, "pypi.org", 80, addrs("151.101.0.223"), false},
		{"locked port match", locked, "pypi.org", 443, addrs("151.101.0.223"), true},
		{"locked other", locked, "example.com", 443, addrs("93.184.215.14"), false},
		{"locked cidr", locked, "203.0.113.9", 22, addrs("203.0.113.9"), true},
		{"locked mixed records", locked, "split.example", 443, addrs("203.0.113.9", "93.184.215.14"), false},
		{"locked allow cannot beat builtin", locked, "x.github.com", 80, addrs("169.254.169.254"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, reason := tc.c.decide(tc.host, tc.port, tc.addrs); got != tc.want {
				t.Fatalf("decide(%s:%d %v) = %v (%s)", tc.host, tc.port, tc.addrs, got, reason)
			}
		})
	}
	if err := (Policy{Mode: "deny", Allow: []string{"bad rule here"}}).Validate(); err == nil {
		t.Fatal("invalid rule accepted")
	}
	if err := (Policy{Upstream: "ftp://proxy"}).Validate(); err == nil {
		t.Fatal("invalid upstream accepted")
	}
}

// offlineResolver keeps tests off real DNS: names only resolve via upstream.
func offlineResolver() *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("no dns in tests")
	}}
}

func startProxy(t *testing.T, policy Policy) *Proxy {
	t.Helper()
	p := New()
	p.resolver = offlineResolver()
	if err := p.SetPolicy(policy); err != nil {
		t.Fatal(err)
	}
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p
}

func connect(t *testing.T, proxy, target string) (int, net.Conn) {
	t.Helper()
	conn, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, conn
}

func TestProxyEnforcesPolicyEndToEnd(t *testing.T) {
	// The test server is on loopback, which the built-in policy denies, so a
	// plain allow-everything policy must still refuse it.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "secret") }))
	defer backend.Close()
	target := strings.TrimPrefix(backend.URL, "http://")
	p := startProxy(t, Policy{Mode: "allow"})
	if status, conn := connect(t, p.Addr(), target); status != http.StatusForbidden {
		conn.Close()
		t.Fatalf("loopback CONNECT allowed: %d", status)
	} else {
		conn.Close()
	}
	proxyURL, _ := url.Parse("http://" + p.Addr())
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	resp, err := client.Get(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || strings.Contains(string(body), "secret") {
		t.Fatalf("loopback forward allowed: %d %s", resp.StatusCode, body)
	}
	if status, conn := connect(t, p.Addr(), "169.254.169.254:80"); status != http.StatusForbidden {
		conn.Close()
		t.Fatalf("metadata allowed: %d", status)
	} else {
		conn.Close()
	}
	audit, allowed, denied := p.Audit()
	if allowed != 0 || denied < 3 || len(audit) < 3 || audit[len(audit)-1].Allowed {
		t.Fatalf("audit: %v allowed=%d denied=%d", audit, allowed, denied)
	}
}

func TestProxyTunnelsThroughUpstream(t *testing.T) {
	// A fake parent proxy that accepts CONNECT with credentials and echoes.
	parent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	seen := make(chan string, 1)
	go func() {
		conn, err := parent.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			return
		}
		seen <- req.Method + " " + req.Host + " " + req.Header.Get("Proxy-Authorization")
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n")
		_, _ = io.Copy(conn, conn)
	}()
	p := startProxy(t, Policy{Mode: "deny", Allow: []string{"api.example.test"}, Upstream: "http://user:pass@" + parent.Addr().String()})
	status, conn := connect(t, p.Addr(), "api.example.test:443")
	defer conn.Close()
	if status != http.StatusOK {
		t.Fatalf("allowed host via upstream: %d", status)
	}
	if got := <-seen; got != "CONNECT api.example.test:443 Basic dXNlcjpwYXNz" {
		t.Fatalf("upstream request: %q", got)
	}
	_, _ = conn.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("tunnel: %q %v", buf, err)
	}
	if status, c := connect(t, p.Addr(), "other.example.test:443"); status != http.StatusForbidden {
		c.Close()
		t.Fatalf("non-allowlisted host reached upstream: %d", status)
	} else {
		c.Close()
	}
}
