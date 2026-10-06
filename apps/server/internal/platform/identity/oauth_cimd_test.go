package identity

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCIMDValidationAndCachedFetch(t *testing.T) {
	const clientID = "https://client.example/oauth/client.json"
	if !isCIMDClientID(clientID) || isCIMDClientID("https://client.example/") || isCIMDClientID("https://client.example/a/../b.json") || isCIMDClientID("http://client.example/client.json") {
		t.Fatal("CIMD client-id URL validation mismatch")
	}
	if _, err := parseCIMDDocument([]byte(`{"client_id":"https://other.example/client.json","redirect_uris":["https://client.example/cb"]}`), clientID); err == nil {
		t.Fatal("mismatched CIMD client_id accepted")
	}
	var calls atomic.Int32
	clock := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": {"max-age=3600"}}, Body: io.NopCloser(strings.NewReader(`{"client_id":"https://client.example/oauth/client.json","client_name":"Example","redirect_uris":["https://client.example/cb"],"token_endpoint_auth_methods_supported":["none","private_key_jwt"],"jwks_uri":"https://client.example/jwks"}`)), Request: req}, nil
	})}
	s := New(&appdeps.Dependencies{Clock: func() time.Time { return clock }, HTTPClient: client})
	first, err := s.fetchCIMD(context.Background(), clientID, true)
	if err != nil || first.ClientName != "Example" || first.JWKSURI == "" {
		t.Fatalf("first fetch: %+v err=%v", first, err)
	}
	second, err := s.fetchCIMD(context.Background(), clientID, true)
	if err != nil || second.ClientName != "Example" || calls.Load() != 1 {
		t.Fatalf("cached fetch: %+v calls=%d err=%v", second, calls.Load(), err)
	}
	method, err := chooseCIMDAuthMethod(first)
	if err != nil || method != "private_key_jwt" {
		t.Fatalf("auth method=%q err=%v", method, err)
	}
}

func TestPrivateKeyJWTWithFakeCIMDAndJWKS(t *testing.T) {
	const clientID = "https://client.example/oauth/client.json"
	const jwksURL = "https://client.example/oauth/jwks.json"
	clock := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	exponent := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes())
	modulus := base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes())
	docRaw, _ := json.Marshal(map[string]any{"client_id": clientID, "redirect_uris": []string{"https://client.example/callback"}, "token_endpoint_auth_methods_supported": []string{"private_key_jwt"}, "jwks_uri": jwksURL})
	jwksRaw, _ := json.Marshal(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "alg": "RS256", "kid": "client-key", "n": modulus, "e": exponent}}})
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := docRaw
		if req.URL.String() == jwksURL {
			body = jwksRaw
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body))), Request: req}, nil
	})}
	s := New(&appdeps.Dependencies{Clock: func() time.Time { return clock }, PublicURL: "https://zakura.example", HTTPClient: client, ResolveIPs: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("203.0.113.10")}, nil }})
	claims := jwt.MapClaims{"iss": clientID, "sub": clientID, "aud": "https://zakura.example/token", "iat": clock.Unix(), "exp": clock.Add(5 * time.Minute).Unix(), "jti": "assertion-1"}
	assertion := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	assertion.Header["kid"] = "client-key"
	rawAssertion, err := assertion.SignedString(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	clientRecord := oauthClient{ID: clientID, Method: "private_key_jwt", Registration: "cimd"}
	if err = s.verifyClientAssertion(context.Background(), clientRecord, rawAssertion, clientAssertionType); err != nil {
		t.Fatalf("valid assertion rejected: %v", err)
	}
	bad := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": clientID, "sub": "wrong", "aud": "https://zakura.example/token", "exp": clock.Add(time.Minute).Unix()})
	bad.Header["kid"] = "client-key"
	badRaw, _ := bad.SignedString(privateKey)
	if err = s.verifyClientAssertion(context.Background(), clientRecord, badRaw, clientAssertionType); err == nil {
		t.Fatal("assertion with wrong subject accepted")
	}
}
