package identity

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const clientAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

type rsaJWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (s *Service) fetchJWKS(ctx context.Context, rawURL string, skipSSRF bool) ([]rsaJWK, error) {
	if !skipSSRF {
		if err := s.assertPublicOAuthURL(ctx, rawURL); err != nil {
			return nil, err
		}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Zakura-MCP-OAuth/1.0 (private_key_jwt)")
	client := s.deps.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New("JWKS fetch failed")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return nil, errors.New("JWKS response is too large")
	}
	var document struct {
		Keys []rsaJWK `json:"keys"`
	}
	if json.Unmarshal(raw, &document) != nil || len(document.Keys) == 0 {
		return nil, errors.New("JWKS is missing keys")
	}
	return document.Keys, nil
}

func publicKeyFromJWK(jwk rsaJWK) (*rsa.PublicKey, error) {
	if jwk.Kty != "RSA" || jwk.N == "" || jwk.E == "" || jwk.Alg != "" && jwk.Alg != "RS256" {
		return nil, errors.New("JWKS key is not RS256 RSA")
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil || len(eBytes) == 0 || len(eBytes) > 4 {
		return nil, errors.New("invalid RSA exponent")
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e < 3 {
		return nil, errors.New("invalid RSA exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func (s *Service) verifyClientAssertion(ctx context.Context, c oauthClient, assertion, assertionType string) error {
	if assertion == "" {
		return errors.New("private_key_jwt requires client_assertion")
	}
	if assertionType != "" && assertionType != clientAssertionType {
		return errors.New("invalid client_assertion_type")
	}
	doc, err := s.fetchCIMD(ctx, c.ID, false)
	if err != nil || strings.TrimSpace(doc.JWKSURI) == "" {
		return errors.New("client did not provide jwks_uri")
	}
	keys, err := s.fetchJWKS(ctx, doc.JWKSURI, false)
	if err != nil {
		return err
	}
	var header struct {
		Kid string `json:"kid"`
	}
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		return errors.New("client_assertion is not a JWT")
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(headerRaw, &header) != nil {
		return errors.New("invalid client_assertion header")
	}
	var chosen *rsa.PublicKey
	for _, candidate := range keys {
		if header.Kid != "" && candidate.Kid != header.Kid {
			continue
		}
		if key, parseErr := publicKeyFromJWK(candidate); parseErr == nil {
			chosen = key
			break
		}
	}
	if chosen == nil {
		return errors.New("matching RSA key not found in JWKS")
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(assertion, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodRS256 {
			return nil, errors.New("client_assertion must use RS256")
		}
		return chosen, nil
	}, jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"RS256"}), jwt.WithTimeFunc(func() time.Time { return s.deps.Clock() }))
	if err != nil || !token.Valid {
		return errors.New("invalid client_assertion signature or time claims")
	}
	issuer, _ := claims["iss"].(string)
	subject, _ := claims["sub"].(string)
	if issuer != c.ID || subject != c.ID {
		return errors.New("client_assertion iss and sub must equal client_id")
	}
	audiences, err := claims.GetAudience()
	if err != nil {
		return errors.New("client_assertion is missing aud")
	}
	validAudience := false
	for _, audience := range audiences {
		trimmed := strings.TrimRight(audience, "/")
		if trimmed == strings.TrimRight(s.deps.PublicURL+"/token", "/") || trimmed == strings.TrimRight(s.deps.PublicURL+"/oauth/token", "/") {
			validAudience = true
		}
	}
	if !validAudience {
		return errors.New("client_assertion aud must be the token endpoint")
	}
	return nil
}
