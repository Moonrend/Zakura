package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type cimdDocument struct {
	ClientID         string   `json:"client_id"`
	ClientName       string   `json:"client_name"`
	RedirectURIs     []string `json:"redirect_uris"`
	GrantTypes       []string `json:"grant_types"`
	ResponseTypes    []string `json:"response_types"`
	TokenAuthMethod  string   `json:"token_endpoint_auth_method"`
	TokenAuthMethods []string `json:"token_endpoint_auth_methods_supported"`
	Scope            string   `json:"scope"`
	JWKSURI          string   `json:"jwks_uri"`
	ClientURI        string   `json:"client_uri"`
	LogoURI          string   `json:"logo_uri"`
}

type cimdCacheEntry struct {
	Document  cimdDocument
	ExpiresAt time.Time
}

func isCIMDClientID(clientID string) bool {
	if strings.Contains(clientID, "/../") || strings.Contains(clientID, "/./") || strings.HasSuffix(clientID, "/..") || strings.HasSuffix(clientID, "/.") {
		return false
	}
	u, err := url.Parse(clientID)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Path == "" || u.Path == "/" || u.User != nil || u.Fragment != "" {
		return false
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func privateOrLocalIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() {
		return true
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1]&0xc0 == 0x40 {
		return true
	}
	return false
}

func (s *Service) assertPublicOAuthURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return errors.New("OAuth metadata URL must use public HTTPS")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || host == "metadata.google.internal" {
		return errors.New("OAuth metadata host is not allowed")
	}
	if parsed := net.ParseIP(host); parsed != nil {
		if privateOrLocalIP(parsed) {
			return errors.New("OAuth metadata host is not public")
		}
		return nil
	}
	var ips []net.IP
	if s.deps.ResolveIPs != nil {
		ips, err = s.deps.ResolveIPs(ctx, host)
	} else {
		var addresses []net.IPAddr
		addresses, err = net.DefaultResolver.LookupIPAddr(ctx, host)
		for _, address := range addresses {
			ips = append(ips, address.IP)
		}
	}
	if err != nil || len(ips) == 0 {
		return errors.New("OAuth metadata host could not be resolved")
	}
	for _, ip := range ips {
		if privateOrLocalIP(ip) {
			return errors.New("OAuth metadata host resolved to a private address")
		}
	}
	return nil
}

func parseCIMDDocument(raw []byte, expected string) (cimdDocument, error) {
	var doc cimdDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return doc, errors.New("CIMD response is not valid JSON")
	}
	if doc.ClientID != expected {
		return doc, errors.New("CIMD client_id must exactly match its document URL")
	}
	if len(doc.RedirectURIs) == 0 {
		return doc, errors.New("CIMD document is missing redirect_uris")
	}
	for _, redirect := range doc.RedirectURIs {
		if strings.TrimSpace(redirect) == "" || !allowedOAuthRedirect(redirect) {
			return doc, errors.New("CIMD document contains an invalid redirect URI")
		}
	}
	forbidden := func(value string) bool {
		return value == "client_secret_post" || value == "client_secret_basic" || value == "client_secret_jwt"
	}
	if forbidden(doc.TokenAuthMethod) {
		return doc, errors.New("CIMD document cannot use a symmetric client secret")
	}
	if len(doc.TokenAuthMethods) > 0 {
		allowed := false
		for _, method := range doc.TokenAuthMethods {
			if !forbidden(method) {
				allowed = true
			}
		}
		if !allowed {
			return doc, errors.New("CIMD document has no public client authentication method")
		}
	}
	return doc, nil
}

func trustedCIMDFallback(clientID string) (cimdDocument, bool) {
	if !isCIMDClientID(clientID) {
		return cimdDocument{}, false
	}
	u, _ := url.Parse(clientID)
	switch strings.ToLower(u.Hostname()) {
	case "chatgpt.com", "chat.openai.com":
		return cimdDocument{ClientID: clientID, ClientName: "ChatGPT", RedirectURIs: []string{"https://chatgpt.com/connector/oauth/", "https://chatgpt.com/connector_platform_oauth_redirect", "https://chat.openai.com/connector/oauth/"}, TokenAuthMethods: []string{"none", "private_key_jwt"}, GrantTypes: []string{"authorization_code", "refresh_token"}, ResponseTypes: []string{"code"}}, true
	case "claude.ai":
		return cimdDocument{ClientID: clientID, ClientName: "Claude", RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback", "https://claude.ai/oauth/"}, TokenAuthMethods: []string{"none", "private_key_jwt"}, GrantTypes: []string{"authorization_code", "refresh_token"}, ResponseTypes: []string{"code"}}, true
	default:
		return cimdDocument{}, false
	}
}

func (s *Service) fetchCIMD(ctx context.Context, clientID string, skipSSRF bool) (cimdDocument, error) {
	if !isCIMDClientID(clientID) {
		return cimdDocument{}, errors.New("client_id is not a valid CIMD URL")
	}
	s.cimdMu.Lock()
	if hit, ok := s.cimdCache[clientID]; ok && hit.ExpiresAt.After(s.deps.Clock()) {
		s.cimdMu.Unlock()
		return hit.Document, nil
	}
	s.cimdMu.Unlock()
	if !skipSSRF {
		if err := s.assertPublicOAuthURL(ctx, clientID); err != nil {
			return cimdDocument{}, err
		}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Zakura-MCP-OAuth/1.0 (CIMD)")
	client := s.deps.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, err := client.Do(req)
	if err != nil {
		if fallback, ok := trustedCIMDFallback(clientID); ok {
			s.cacheCIMD(clientID, fallback, time.Hour)
			return fallback, nil
		}
		return cimdDocument{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if fallback, ok := trustedCIMDFallback(clientID); ok {
			s.cacheCIMD(clientID, fallback, time.Hour)
			return fallback, nil
		}
		return cimdDocument{}, fmt.Errorf("CIMD fetch failed: HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return cimdDocument{}, errors.New("CIMD document is too large")
	}
	doc, err := parseCIMDDocument(raw, clientID)
	if err != nil {
		return cimdDocument{}, err
	}
	ttl := time.Hour
	for _, part := range strings.Split(resp.Header.Get("Cache-Control"), ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToLower(part), "max-age=") {
			if seconds, parseErr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(strings.ToLower(part), "max-age="))); parseErr == nil {
				ttl = time.Duration(seconds) * time.Second
			}
		}
	}
	if ttl < time.Minute {
		ttl = time.Minute
	}
	if ttl > 24*time.Hour {
		ttl = 24 * time.Hour
	}
	s.cacheCIMD(clientID, doc, ttl)
	return doc, nil
}

func (s *Service) cacheCIMD(clientID string, doc cimdDocument, ttl time.Duration) {
	s.cimdMu.Lock()
	s.cimdCache[clientID] = cimdCacheEntry{Document: doc, ExpiresAt: s.deps.Clock().Add(ttl)}
	s.cimdMu.Unlock()
}

func chooseCIMDAuthMethod(doc cimdDocument) (string, error) {
	methods := doc.TokenAuthMethods
	if len(methods) == 0 && doc.TokenAuthMethod != "" {
		methods = []string{doc.TokenAuthMethod}
	}
	if len(methods) == 0 {
		methods = []string{"none"}
	}
	for _, method := range methods {
		if method == "private_key_jwt" {
			return method, nil
		}
	}
	for _, method := range methods {
		if method == "none" {
			return method, nil
		}
	}
	return "", errors.New("CIMD and authorization server have no common client authentication method")
}

func (s *Service) resolveOAuthClient(ctx context.Context, clientID string) (oauthClient, error) {
	c, err := s.getOAuthClient(ctx, clientID)
	if err == nil && c.Registration != "cimd" {
		return c, nil
	}
	if !isCIMDClientID(clientID) {
		if err == nil {
			return c, nil
		}
		return c, errors.New("unknown client")
	}
	doc, fetchErr := s.fetchCIMD(ctx, clientID, false)
	if fetchErr != nil {
		if err == nil {
			return c, nil
		}
		return c, fetchErr
	}
	method, err := chooseCIMDAuthMethod(doc)
	if err != nil {
		return c, err
	}
	grants := doc.GrantTypes
	if len(grants) == 0 {
		grants = []string{"authorization_code", "refresh_token"}
	}
	responses := doc.ResponseTypes
	if len(responses) == 0 {
		responses = []string{"code"}
	}
	redirects, _ := json.Marshal(doc.RedirectURIs)
	grantRaw, _ := json.Marshal(grants)
	responseRaw, _ := json.Marshal(responses)
	name := strings.TrimSpace(doc.ClientName)
	if name == "" {
		name = "MCP Client (CIMD)"
	}
	now := s.now()
	_, err = s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO oauth_clients(id,tenant_id,client_id,client_secret_hash,client_name,redirect_uris_json,grant_types_json,response_types_json,token_endpoint_auth_method,scope,registration_type,created_at,updated_at)
		VALUES(?,NULL,?,NULL,?,?,?,?,?,?,'cimd',?,?)
		ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name,redirect_uris_json=excluded.redirect_uris_json,grant_types_json=excluded.grant_types_json,response_types_json=excluded.response_types_json,token_endpoint_auth_method=excluded.token_endpoint_auth_method,scope=excluded.scope,registration_type='cimd',updated_at=excluded.updated_at`), s.deps.NewID(), clientID, name, string(redirects), string(grantRaw), string(responseRaw), method, defaultString(strings.TrimSpace(doc.Scope), "mcp"), now, now)
	if err != nil {
		return c, err
	}
	return s.getOAuthClient(ctx, clientID)
}

func (s *Service) getOAuthClient(ctx context.Context, clientID string) (oauthClient, error) {
	var c oauthClient
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT client_id,client_name,COALESCE(client_secret_hash,''),redirect_uris_json,token_endpoint_auth_method,scope,registration_type,tenant_id FROM oauth_clients WHERE client_id=?`), clientID).
		Scan(&c.ID, &c.Name, &c.SecretHash, &c.Redirects, &c.Method, &c.Scope, &c.Registration, &c.TenantID)
	return c, err
}

func allowedOAuthRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return false
	}
	if u.Scheme == "https" {
		return u.Host != ""
	}
	if u.Scheme == "zakurabot" || u.Scheme == "vscode" || u.Scheme == "cursor" || u.Scheme == "vscode-insiders" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsPrivate()
}

func redirectRegistered(c oauthClient, redirect string) bool {
	var allowed []string
	_ = json.Unmarshal([]byte(c.Redirects), &allowed)
	for _, item := range allowed {
		if item == redirect || strings.HasSuffix(item, "/") && strings.HasPrefix(redirect, item) {
			return true
		}
	}
	if c.Registration != "cimd" {
		return false
	}
	u, err := url.Parse(redirect)
	clientURL, clientErr := url.Parse(c.ID)
	if err != nil || clientErr != nil || u.Scheme != "https" {
		return false
	}
	host, clientHost := strings.ToLower(u.Hostname()), strings.ToLower(clientURL.Hostname())
	if (host == "chatgpt.com" || host == "chat.openai.com" || clientHost == "chatgpt.com") && (strings.HasPrefix(u.Path, "/connector/oauth/") || u.Path == "/connector_platform_oauth_redirect") {
		return true
	}
	return (host == "claude.ai" || clientHost == "claude.ai") && (strings.HasPrefix(u.Path, "/api/mcp/auth_callback") || strings.HasPrefix(u.Path, "/oauth/") || strings.Contains(u.Path, "callback"))
}
