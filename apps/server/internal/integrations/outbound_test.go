// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
)

func TestConnectorPublicIPPolicy(t *testing.T) {
	tests := []struct {
		address string
		public  bool
	}{
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"64:ff9b::808:808", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"100.64.0.1", false},
		{"169.254.169.254", false},
		{"192.0.2.1", false},
		{"::1", false},
		{"::ffff:127.0.0.1", false},
		{"64:ff9b::7f00:1", false},
		{"fc00::1", false},
		{"fe80::1", false},
	}
	for _, test := range tests {
		if got := isPublicIP(net.ParseIP(test.address)); got != test.public {
			t.Errorf("isPublicIP(%q) = %v, want %v", test.address, got, test.public)
		}
	}
}

func TestConnectorDialRejectsMixedDNSBeforeConnecting(t *testing.T) {
	dialed := false
	dial := publicDialContext(
		func(context.Context, string) ([]net.IP, error) {
			return []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("10.0.0.1")}, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("unexpected dial")
		},
	)
	if _, err := dial(context.Background(), "tcp", "provider.example:443"); err == nil {
		t.Fatal("mixed public and private DNS results must be rejected")
	}
	if dialed {
		t.Fatal("dial must not run when any DNS result is non-public")
	}
}

func TestConnectorDialPinsResolvedPublicAddress(t *testing.T) {
	stop := errors.New("stop after observing address")
	gotAddress := ""
	dial := publicDialContext(
		func(_ context.Context, host string) ([]net.IP, error) {
			if host != "provider.example" {
				t.Fatalf("resolved host = %q", host)
			}
			return []net.IP{net.ParseIP("8.8.8.8")}, nil
		},
		func(_ context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" {
				t.Fatalf("network = %q", network)
			}
			gotAddress = address
			return nil, stop
		},
	)
	if _, err := dial(context.Background(), "tcp", "provider.example:443"); !errors.Is(err, stop) {
		t.Fatalf("dial error = %v", err)
	}
	if gotAddress != "8.8.8.8:443" {
		t.Fatalf("dial address = %q", gotAddress)
	}
}

func TestConnectorClientDisablesRedirectsAndProxy(t *testing.T) {
	client := newConnectorHTTPClient()
	req, _ := http.NewRequest(http.MethodGet, "https://provider.example/next", nil)
	if err := client.CheckRedirect(req, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("redirect policy = %v", err)
	}
	transport := client.Transport.(*http.Transport)
	if transport.Proxy != nil || transport.DialContext == nil || transport.DialTLSContext != nil {
		t.Fatal("connector transport must use only its pinned direct dialer")
	}
}

func TestConnectorURLRejectsNonPublicLiterals(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1/service",
		"http://10.0.0.1/service",
		"http://[::ffff:127.0.0.1]/service",
		"http://[fe80::1%25eth0]/service",
	} {
		if _, err := connectorURL(raw); err == nil {
			t.Errorf("connectorURL(%q) accepted a non-public literal", raw)
		}
	}
	if got, err := connectorURL("https://provider.example/api"); err != nil || got != "https://provider.example/api" {
		t.Fatalf("public provider URL rejected: got %q err %v", got, err)
	}
	if got, err := connectorURL("http://provider.example/api"); err != nil || got != "http://provider.example/api" {
		t.Fatalf("public HTTP provider URL rejected: got %q err %v", got, err)
	}
}
