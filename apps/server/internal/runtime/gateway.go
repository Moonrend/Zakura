// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
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
	"time"
)

const maxProviderResponse = 64 << 20

type Gateway struct {
	store  *Store
	client *http.Client
}

func NewGateway(store *Store) *Gateway {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 16
	transport.ResponseHeaderTimeout = 90 * time.Second
	return &Gateway{store: store, client: &http.Client{Transport: transport}}
}

type upstreamConfig struct {
	BaseURL       string            `json:"baseUrl"`
	APIKey        string            `json:"apiKey"`
	AccessToken   string            `json:"accessToken"`
	CredentialEnc string            `json:"credentialEnc"`
	Headers       map[string]string `json:"headers"`
	Timeout       int               `json:"timeoutMs"`
}

type ProviderResponse struct {
	Status    int
	Header    http.Header
	Body      io.ReadCloser
	Protocol  string
	Operation string
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
	u.Path = path.Join(strings.TrimSuffix(u.Path, "/"), endpoint)
	return u, nil
}

func endpointFor(protocol, operation string) string {
	switch operation {
	case "responses":
		return "/v1/responses"
	case "messages":
		return "/v1/messages"
	case "embeddings":
		return "/v1/embeddings"
	case "rerank":
		return "/v1/rerank"
	case "images":
		return "/v1/images/generations"
	default:
		if protocol == "anthropic" {
			return "/v1/messages"
		}
		return "/v1/chat/completions"
	}
}

func (g *Gateway) Do(ctx context.Context, tenant, capability, operation, model string, payload []byte) (*ProviderResponse, error) {
	candidates, err := g.store.ResolveCandidates(ctx, tenant, capability, model)
	if err != nil {
		return nil, err
	}
	errs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		resp, callErr := g.doCandidate(ctx, tenant, operation, payload, candidate.Route, candidate.Upstream)
		if callErr == nil && resp.Status < 500 && resp.Status != http.StatusTooManyRequests {
			return resp, nil
		}
		if resp != nil {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			errs = append(errs, fmt.Sprintf("%s: HTTP %d", candidate.Upstream.Name, resp.Status))
		} else if callErr != nil {
			errs = append(errs, candidate.Upstream.Name+": "+callErr.Error())
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, fmt.Errorf("all model routes failed: %s", strings.Join(errs, "; "))
}

func (g *Gateway) doCandidate(ctx context.Context, tenant, operation string, originalPayload []byte, route ModelRoute, upstream Upstream) (*ProviderResponse, error) {
	payload := append([]byte(nil), originalPayload...)
	var cfg upstreamConfig
	if err := json.Unmarshal(upstream.Config, &cfg); err != nil {
		return nil, fmt.Errorf("invalid upstream config: %w", err)
	}
	if cfg.CredentialEnc != "" {
		if raw, e := openSecretBox(g.store.deps.Secret, "model:"+tenant+":"+upstream.ID, cfg.CredentialEnc); e == nil {
			var credentials map[string]any
			if json.Unmarshal(raw, &credentials) == nil {
				if v, ok := credentials["apiKey"].(string); ok {
					cfg.APIKey = v
				}
				if v, ok := credentials["accessToken"].(string); ok {
					cfg.AccessToken = v
				}
			}
		}
	}
	if cfg.APIKey == "" {
		cfg.APIKey = cfg.AccessToken
	}
	if cfg.BaseURL == "" {
		return nil, errors.New("upstream baseUrl is not configured")
	}
	u, err := safeProviderURL(cfg.BaseURL, endpointFor(upstream.Protocol, operation))
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, errors.New("invalid JSON body")
	}
	body["model"] = route.Model
	body = normalizeProviderRequest(upstream.Protocol, operation, body)
	payload, _ = json.Marshal(body)
	streaming, _ := body["stream"].(bool)
	client := g.client
	if cfg.Timeout > 0 {
		clone := *client
		clone.Timeout = time.Duration(cfg.Timeout) * time.Millisecond
		client = &clone
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if cfg.APIKey != "" {
			if upstream.Protocol == "anthropic" {
				req.Header.Set("x-api-key", cfg.APIKey)
				req.Header.Set("anthropic-version", "2023-06-01")
			} else {
				req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
			}
		}
		for k, v := range cfg.Headers {
			if http.CanonicalHeaderKey(k) != "Host" {
				req.Header.Set(k, v)
			}
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			time.Sleep(time.Duration(attempt+1) * 50 * time.Millisecond)
			continue
		}
		if (resp.StatusCode == 429 || resp.StatusCode >= 500) && attempt < 2 {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
			}
			continue
		}
		if streaming && resp.StatusCode >= 200 && resp.StatusCode < 300 && strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
			prefix, e := readStreamCommit(resp.Body)
			if e != nil {
				resp.Body.Close()
				lastErr = e
				continue
			}
			resp.Body = structReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix), resp.Body), Closer: resp.Body}
		}
		return &ProviderResponse{Status: resp.StatusCode, Header: resp.Header.Clone(), Body: resp.Body, Protocol: upstream.Protocol, Operation: operation}, nil
	}
	return nil, fmt.Errorf("upstream unavailable: %w", lastErr)
}

type structReadCloser struct {
	io.Reader
	io.Closer
}

func readStreamCommit(body io.Reader) ([]byte, error) {
	var out bytes.Buffer
	one := make([]byte, 1)
	for out.Len() < 64<<10 {
		n, e := body.Read(one)
		if n > 0 {
			out.WriteByte(one[0])
			if bytes.HasSuffix(out.Bytes(), []byte("\n\n")) {
				return out.Bytes(), nil
			}
		}
		if e != nil {
			return nil, fmt.Errorf("stream failed before first complete event: %w", e)
		}
	}
	return nil, errors.New("first stream event exceeds 64 KiB")
}
func normalizeProviderRequest(protocol, operation string, body map[string]any) map[string]any {
	if protocol == "anthropic" {
		if _, ok := body["max_tokens"]; !ok {
			if v, ok := body["max_completion_tokens"]; ok {
				body["max_tokens"] = v
			} else {
				body["max_tokens"] = 1024
			}
		}
		if messages, ok := body["messages"].([]any); ok {
			filtered, systems := make([]any, 0, len(messages)), []string{}
			for _, item := range messages {
				m, _ := item.(map[string]any)
				role, _ := m["role"].(string)
				if role == "system" {
					if text, ok := m["content"].(string); ok {
						systems = append(systems, text)
					}
					continue
				}
				if role == "tool" {
					filtered = append(filtered, map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}}})
					continue
				}
				if role == "assistant" {
					if calls, ok := m["tool_calls"].([]any); ok {
						blocks := []any{}
						if text, ok := m["content"].(string); ok && text != "" {
							blocks = append(blocks, map[string]any{"type": "text", "text": text})
						}
						for _, raw := range calls {
							x, _ := raw.(map[string]any)
							f, _ := x["function"].(map[string]any)
							var input any
							if arg, ok := f["arguments"].(string); ok {
								_ = json.Unmarshal([]byte(arg), &input)
							}
							blocks = append(blocks, map[string]any{"type": "tool_use", "id": x["id"], "name": f["name"], "input": input})
						}
						m["content"] = blocks
						delete(m, "tool_calls")
					}
				}
				filtered = append(filtered, m)
			}
			body["messages"] = filtered
			if len(systems) > 0 {
				body["system"] = strings.Join(systems, "\n\n")
			}
		}
		if tools, ok := body["tools"].([]any); ok {
			converted := []any{}
			for _, item := range tools {
				m, _ := item.(map[string]any)
				if f, ok := m["function"].(map[string]any); ok {
					converted = append(converted, map[string]any{"name": f["name"], "description": f["description"], "input_schema": f["parameters"]})
				} else {
					converted = append(converted, item)
				}
			}
			body["tools"] = converted
		}
		delete(body, "max_completion_tokens")
		return body
	}
	if operation == "messages" {
		if tools, ok := body["tools"].([]any); ok {
			converted := []any{}
			for _, item := range tools {
				m, _ := item.(map[string]any)
				if _, ok := m["function"]; ok {
					converted = append(converted, m)
				} else {
					converted = append(converted, map[string]any{"type": "function", "function": map[string]any{"name": m["name"], "description": m["description"], "parameters": m["input_schema"]}})
				}
			}
			body["tools"] = converted
		}
	}
	return body
}

func copyProviderResponse(w http.ResponseWriter, resp *ProviderResponse) error {
	defer resp.Body.Close()
	for _, k := range []string{"Content-Type", "Cache-Control", "X-Request-Id"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") && resp.Status >= 200 && resp.Status < 300 {
		raw, e := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
		if e != nil {
			return e
		}
		raw = normalizeProviderResponse(resp.Protocol, resp.Operation, raw)
		w.WriteHeader(resp.Status)
		_, e = w.Write(raw)
		return e
	}
	w.WriteHeader(resp.Status)
	_, err := io.Copy(w, io.LimitReader(resp.Body, maxProviderResponse+1))
	return err
}
func normalizeProviderResponse(protocol, operation string, raw []byte) []byte {
	if protocol == "anthropic" && (operation == "chat" || operation == "responses") {
		var a struct {
			ID         string `json:"id"`
			Model      string `json:"model"`
			StopReason string `json:"stop_reason"`
			Content    []struct {
				Type  string `json:"type"`
				Text  string `json:"text"`
				ID    string `json:"id"`
				Name  string `json:"name"`
				Input any    `json:"input"`
			} `json:"content"`
			Usage struct {
				Input  int `json:"input_tokens"`
				Output int `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(raw, &a) != nil {
			return raw
		}
		text := ""
		tools := []any{}
		for _, c := range a.Content {
			if c.Type == "text" {
				text += c.Text
			} else if c.Type == "tool_use" {
				tools = append(tools, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": string(rawJSON(c.Input))}})
			}
		}
		finish := "stop"
		if a.StopReason == "tool_use" {
			finish = "tool_calls"
		}
		msg := map[string]any{"role": "assistant", "content": text}
		if len(tools) > 0 {
			msg["tool_calls"] = tools
		}
		out, _ := json.Marshal(map[string]any{"id": a.ID, "object": "chat.completion", "model": a.Model, "choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": a.Usage.Input, "completion_tokens": a.Usage.Output, "total_tokens": a.Usage.Input + a.Usage.Output}})
		return out
	}
	if protocol != "anthropic" && operation == "messages" {
		var o struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Choices []struct {
				Message struct {
					Content   string           `json:"content"`
					ToolCalls []map[string]any `json:"tool_calls"`
				} `json:"message"`
				Finish string `json:"finish_reason"`
			} `json:"choices"`
			Usage struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(raw, &o) != nil || len(o.Choices) == 0 {
			return raw
		}
		content := []any{}
		if o.Choices[0].Message.Content != "" {
			content = append(content, map[string]any{"type": "text", "text": o.Choices[0].Message.Content})
		}
		for _, tc := range o.Choices[0].Message.ToolCalls {
			f, _ := tc["function"].(map[string]any)
			var input any
			if arg, ok := f["arguments"].(string); ok {
				_ = json.Unmarshal([]byte(arg), &input)
			}
			content = append(content, map[string]any{"type": "tool_use", "id": tc["id"], "name": f["name"], "input": input})
		}
		stop := "end_turn"
		if o.Choices[0].Finish == "tool_calls" {
			stop = "tool_use"
		}
		out, _ := json.Marshal(map[string]any{"id": o.ID, "type": "message", "role": "assistant", "model": o.Model, "content": content, "stop_reason": stop, "usage": map[string]any{"input_tokens": o.Usage.Prompt, "output_tokens": o.Usage.Completion}})
		return out
	}
	return raw
}

func rawJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func redactUpstream(u Upstream) Upstream {
	var cfg map[string]any
	if json.Unmarshal(u.Config, &cfg) == nil {
		for _, k := range []string{"apiKey", "token", "password", "secret", "clientSecret"} {
			if _, ok := cfg[k]; ok {
				cfg[k] = "***"
			}
		}
		u.Config, _ = json.Marshal(cfg)
	}
	return u
}
