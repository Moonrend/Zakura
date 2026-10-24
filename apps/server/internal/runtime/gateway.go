// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"
)

const maxProviderResponse = 64 << 20

type Gateway struct {
	store        *Store
	client       *http.Client
	captureSlots chan struct{}
	captureMu    sync.Mutex
	captureTails map[*gatewayCapture]gatewayCaptureKey
}

func NewGateway(store *Store) *Gateway {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 16
	transport.ResponseHeaderTimeout = 90 * time.Second
	return &Gateway{store: store, client: &http.Client{Transport: transport}, captureSlots: make(chan struct{}, gatewayCaptureSlots)}
}

type upstreamConfig struct {
	BaseURL          string            `json:"baseUrl"`
	APIKey           string            `json:"apiKey"`
	AccessToken      string            `json:"accessToken"`
	CredentialEnc    string            `json:"credentialEnc"`
	Headers          map[string]string `json:"headers"`
	ExtraHeaders     map[string]string `json:"extraHeaders"`
	AnthropicVersion string            `json:"anthropicVersion"`
	Timeout          int               `json:"timeoutMs"`
}

// ProviderResponse carries the raw upstream body in the upstream's own dialect.
// Protocol/Operation tell the HTTP layer which client dialect to translate into;
// internal callers read Body directly.
type ProviderResponse struct {
	Status    int
	Header    http.Header
	Body      io.ReadCloser
	Protocol  string
	Operation string
	// Stream reports whether the client asked for an event stream.
	Stream       bool
	Model        string
	UpstreamName string
	Tenant       string
	started      time.Time
}

// gatewayRouteError is returned when every candidate route failed. The last
// upstream HTTP failure is kept so the HTTP layer can surface a faithful status.
type gatewayRouteError struct {
	Attempts   []string
	Status     int
	Body       []byte
	Protocol   string
	RetryAfter string
}

func (e *gatewayRouteError) Error() string {
	return "all model routes failed: " + strings.Join(e.Attempts, "; ")
}

func isAnthropicProtocol(protocol string) bool {
	return protocol == "anthropic" || protocol == "claude-code"
}

func loadUpstreamConfig(secret []byte, tenant string, u Upstream) (upstreamConfig, error) {
	var cfg upstreamConfig
	if len(u.Config) > 0 {
		if err := json.Unmarshal(u.Config, &cfg); err != nil {
			return cfg, fmt.Errorf("invalid upstream config: %w", err)
		}
	}
	if cfg.CredentialEnc != "" {
		raw, err := openSecretBox(secret, "model:"+tenant+":"+u.ID, cfg.CredentialEnc)
		if err != nil {
			return cfg, errors.New("cannot decrypt upstream credentials")
		}
		var credentials map[string]string
		if err := json.Unmarshal(raw, &credentials); err != nil || credentials == nil {
			return cfg, errors.New("invalid encrypted upstream credentials")
		}
		cfg.APIKey = credentials["apiKey"]
		cfg.AccessToken = credentials["accessToken"]
	}
	if cfg.APIKey == "" {
		cfg.APIKey = cfg.AccessToken
	}
	return cfg, nil
}

func applyUpstreamHeaders(req *http.Request, protocol string, cfg upstreamConfig) {
	if isAnthropicProtocol(protocol) {
		version := strings.TrimSpace(cfg.AnthropicVersion)
		if version == "" {
			version = "2023-06-01"
		}
		req.Header.Set("anthropic-version", version)
		if cfg.APIKey != "" {
			if protocol == "claude-code" {
				req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
				req.Header.Set("anthropic-beta", "oauth-2025-04-20")
			} else {
				req.Header.Set("x-api-key", cfg.APIKey)
			}
		}
	} else if cfg.APIKey != "" {
		if protocol == "azure-openai" {
			req.Header.Set("api-key", cfg.APIKey)
		} else {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
	}
	for _, headers := range []map[string]string{cfg.ExtraHeaders, cfg.Headers} {
		for k, v := range headers {
			switch http.CanonicalHeaderKey(k) {
			case "Host", "Content-Length":
				continue
			}
			req.Header.Set(k, v)
		}
	}
}

func clientWithTimeout(client *http.Client, timeoutMs int) *http.Client {
	if timeoutMs <= 0 {
		return client
	}
	clone := *client
	clone.Timeout = time.Duration(timeoutMs) * time.Millisecond
	return &clone
}

func safeProviderURL(baseURL, endpoint string) (*url.URL, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("upstream baseUrl must be an absolute http(s) URL")
	}
	if u.User != nil {
		return nil, errors.New("credentials in upstream URL are not allowed")
	}
	host := strings.Trim(u.Hostname(), "[]")
	if ip := net.ParseIP(host); ip != nil && (ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return nil, errors.New("unsafe upstream address")
	}
	basePath := strings.TrimSuffix(u.Path, "/")
	if strings.HasPrefix(endpoint, "/v1/") && strings.HasSuffix(basePath, "/v1") {
		endpoint = strings.TrimPrefix(endpoint, "/v1")
	}
	u.Path = path.Join(basePath, endpoint)
	u.RawPath = ""
	return u, nil
}

// endpointFor maps a client operation onto the upstream's native endpoint. The
// three chat dialects (chat, responses, messages) are all bridged onto whatever
// chat surface the upstream protocol actually serves.
func endpointFor(protocol, operation string) string {
	switch operation {
	case "embeddings":
		return "/v1/embeddings"
	case "rerank":
		return "/v1/rerank"
	case "images":
		return "/v1/images/generations"
	}
	if isAnthropicProtocol(protocol) {
		return "/v1/messages"
	}
	return "/v1/chat/completions"
}

// failoverStatus reports upstream statuses that are specific to one deployment
// (credentials, missing model, overload) and therefore worth trying elsewhere.
func failoverStatus(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return true
	}
	return status >= 500
}

func retrySameUpstream(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
}

func (g *Gateway) Do(ctx context.Context, tenant, capability, operation, model string, payload []byte) (*ProviderResponse, error) {
	candidates, err := g.resolveCandidates(ctx, tenant, capability, model)
	if err != nil {
		return nil, err
	}
	preferContextRoute(ctx, candidates)
	failure := &gatewayRouteError{}
	for _, candidate := range candidates {
		resp, callErr := g.doCandidate(ctx, tenant, operation, payload, candidate.Route, candidate.Upstream)
		if callErr == nil && !failoverStatus(resp.Status) {
			if resp.Status >= 200 && resp.Status < 300 {
				rememberContextRoute(ctx, candidate.Route.ID)
			}
			return resp, nil
		}
		if resp != nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			failure.Status = resp.Status
			failure.Body = body
			failure.Protocol = resp.Protocol
			failure.RetryAfter = resp.Header.Get("Retry-After")
			attempt := fmt.Sprintf("%s: HTTP %d", candidate.Upstream.Name, resp.Status)
			if detail := gwErrorMessage(body); detail != "" {
				attempt += ": " + gwTruncate(detail, 200)
			}
			failure.Attempts = append(failure.Attempts, attempt)
		} else if callErr != nil {
			failure.Attempts = append(failure.Attempts, candidate.Upstream.Name+": "+callErr.Error())
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, failure
}

type gatewayClientHeadersKey struct{}

// withGatewayClientHeaders lets the HTTP layer forward a small allowlist of
// client headers (Anthropic beta flags) without widening Gateway.Do.
func withGatewayClientHeaders(ctx context.Context, h http.Header) context.Context {
	forward := http.Header{}
	if v := h.Values("anthropic-beta"); len(v) > 0 {
		forward["Anthropic-Beta"] = append([]string(nil), v...)
	}
	if len(forward) == 0 {
		return ctx
	}
	return context.WithValue(ctx, gatewayClientHeadersKey{}, forward)
}

func (g *Gateway) doCandidate(ctx context.Context, tenant, operation string, originalPayload []byte, route ModelRoute, upstream Upstream) (*ProviderResponse, error) {
	if upstream.Protocol == "typesafe" || route.Capability == "evaluation" {
		return nil, errors.New("evaluation models cannot be used for chat or generation")
	}
	cfg, err := loadUpstreamConfig(g.store.deps.Secret, tenant, upstream)
	if err != nil {
		return nil, err
	}
	if cfg.BaseURL == "" {
		return nil, errors.New("upstream baseUrl is not configured")
	}
	u, err := safeProviderURL(cfg.BaseURL, endpointFor(upstream.Protocol, operation))
	if err != nil {
		return nil, err
	}
	body, err := decodeGatewayBody(originalPayload)
	if err != nil {
		return nil, err
	}
	streaming, _ := body["stream"].(bool)
	body = prepareUpstreamRequest(upstream.Protocol, operation, route, body)
	applyContextCache(ctx, upstream.Protocol, body)
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	client := clientWithTimeout(g.client, cfg.Timeout)
	forwarded, _ := ctx.Value(gatewayClientHeadersKey{}).(http.Header)
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 200 * time.Millisecond):
			}
		}
		started := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if streaming {
			req.Header.Set("Accept", "text/event-stream")
		} else {
			req.Header.Set("Accept", "application/json")
		}
		applyUpstreamHeaders(req, upstream.Protocol, cfg)
		if isAnthropicProtocol(upstream.Protocol) && operation == "messages" {
			for _, v := range forwarded.Values("Anthropic-Beta") {
				req.Header.Add("anthropic-beta", v)
			}
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		if retrySameUpstream(resp.StatusCode) && attempt < 2 {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			continue
		}
		if streaming && resp.StatusCode >= 200 && resp.StatusCode < 300 && isEventStream(resp.Header.Get("Content-Type")) {
			committed, e := commitStream(resp.Body)
			if e != nil {
				resp.Body.Close()
				lastErr = e
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				continue
			}
			resp.Body = committed
		}
		return &ProviderResponse{Status: resp.StatusCode, Header: resp.Header.Clone(), Body: resp.Body, Protocol: upstream.Protocol, Operation: operation, Stream: streaming, Model: route.Model, UpstreamName: upstream.Name, Tenant: tenant, started: started}, nil
	}
	return nil, fmt.Errorf("upstream unavailable: %w", lastErr)
}

func decodeGatewayBody(payload []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		return nil, errors.New("invalid JSON body")
	}
	return body, nil
}

type structReadCloser struct {
	io.Reader
	io.Closer
}

func isEventStream(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "text/event-stream")
}

// commitStream is the failover barrier for streams: nothing is handed to the
// caller until the upstream has produced one complete event, so a connection
// that dies (or reports an error) before its first event can still fail over.
func commitStream(body io.ReadCloser) (io.ReadCloser, error) {
	br := bufio.NewReaderSize(body, 32<<10)
	var prefix bytes.Buffer
	sawField := false
	for prefix.Len() < 64<<10 {
		line, err := br.ReadSlice('\n')
		prefix.Write(line)
		if err == bufio.ErrBufferFull {
			sawField = true
			continue
		}
		if len(line) > 0 {
			if len(bytes.TrimRight(line, "\r\n")) == 0 {
				if sawField {
					if msg, failed := firstEventError(prefix.Bytes()); failed {
						return nil, fmt.Errorf("upstream stream error: %s", msg)
					}
					return structReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix.Bytes()), br), Closer: body}, nil
				}
			} else {
				sawField = true
			}
		}
		if err != nil {
			return nil, fmt.Errorf("stream failed before first complete event: %w", err)
		}
	}
	return nil, errors.New("first stream event exceeds 64 KiB")
}

func firstEventError(raw []byte) (string, bool) {
	ev, _ := gwNewSSEReader(bytes.NewReader(raw)).Next()
	data := strings.TrimSpace(ev.Data)
	if ev.Event == "error" {
		return gwOr(gwErrorMessage([]byte(data)), "error event"), true
	}
	if !strings.HasPrefix(data, "{") {
		return "", false
	}
	var probe struct {
		Type    string          `json:"type"`
		Error   json.RawMessage `json:"error"`
		Choices json.RawMessage `json:"choices"`
	}
	if json.Unmarshal([]byte(data), &probe) != nil {
		return "", false
	}
	if probe.Type == "error" || (len(probe.Error) > 0 && string(probe.Error) != "null" && len(probe.Choices) == 0) {
		return gwOr(gwErrorMessage([]byte(data)), "error event"), true
	}
	return "", false
}

func rawJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func redactUpstream(u Upstream) Upstream {
	cfg := map[string]any{}
	if json.Unmarshal(u.Config, &cfg) != nil || cfg == nil {
		u.Config = json.RawMessage(`{}`)
		return u
	}
	for _, key := range modelCredentialKeys {
		flag := "has" + strings.ToUpper(key[:1]) + key[1:]
		if value, ok := cfg[key].(string); ok && value != "" {
			cfg[flag] = true
		}
		delete(cfg, key)
	}
	if envelope, _ := cfg["credentialEnc"].(string); envelope != "" {
		// Old envelopes predate existence flags; never expose their contents.
		if _, known := cfg["hasApiKey"]; !known {
			cfg["hasApiKey"] = true
		}
	}
	delete(cfg, "credentialEnc")
	for _, key := range []string{"token", "password", "secret"} {
		delete(cfg, key)
	}
	for _, key := range []string{"headers", "extraHeaders"} {
		if headers, ok := cfg[key].(map[string]any); ok {
			for name := range headers {
				if sensitiveEvaluationKey(name) {
					delete(headers, name)
				}
			}
		}
	}
	u.Config, _ = json.Marshal(cfg)
	return u
}
