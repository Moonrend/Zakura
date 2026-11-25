package identity

import (
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

func TestRequestIPRequiresTrustedPeer(t *testing.T) {
	service := New(&appdeps.Dependencies{TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}})
	tests := []struct {
		name       string
		remoteAddr string
		xRealIP    string
		cfIP       string
		xForwarded string
		want       string
	}{
		{name: "untrusted peer", remoteAddr: "198.51.100.10:1234", xRealIP: "203.0.113.1", cfIP: "203.0.113.2", xForwarded: "203.0.113.3", want: "198.51.100.10"},
		{name: "trusted proxy", remoteAddr: "10.0.0.2:1234", xRealIP: "203.0.113.4", want: "203.0.113.4"},
		{name: "ignored aliases", remoteAddr: "10.0.0.3:1234", cfIP: "203.0.113.5", xForwarded: "203.0.113.6", want: "10.0.0.3"},
		{name: "invalid trusted header", remoteAddr: "10.0.0.4:1234", xRealIP: "not-an-ip", want: "10.0.0.4"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = test.remoteAddr
			r.Header.Set("X-Real-IP", test.xRealIP)
			r.Header.Set("CF-Connecting-IP", test.cfIP)
			r.Header.Set("X-Forwarded-For", test.xForwarded)
			if got := service.requestIP(r); got != test.want {
				t.Fatalf("requestIP()=%q, want %q", got, test.want)
			}
		})
	}
}
