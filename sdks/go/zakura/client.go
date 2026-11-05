// SPDX-License-Identifier: AGPL-3.0-only
package zakura

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const DefaultMaxResponseBytes int64 = 8 << 20

type TokenProvider func(context.Context) (string, error)
type RetryPolicy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}
type Config struct {
	BaseURL          string
	Token            string
	TokenProvider    TokenProvider
	HTTPClient       *http.Client
	Timeout          time.Duration
	MaxResponseBytes int64
	Retry            RetryPolicy
}
type Client struct {
	baseURL  string
	token    TokenProvider
	http     *http.Client
	timeout  time.Duration
	maxBytes int64
	retry    RetryPolicy
}
type CallOptions struct {
	Method      string
	Path        string
	Params      map[string]string
	Query       url.Values
	Headers     http.Header
	Body        any
	HasJSONBody bool
	RawBody     []byte
	ContentType string
	Timeout     time.Duration
}
type Response struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}
type APIError struct {
	StatusCode int
	Method     string
	Path       string
	RequestID  string
	Body       []byte
}

func (e *APIError) Error() string {
	return fmt.Sprintf("Zakura %s %s returned HTTP %d", e.Method, e.Path, e.StatusCode)
}
func (r *Response) Decode(target any) error {
	if target == nil {
		return errors.New("JSON target must not be nil")
	}
	if len(r.Body) == 0 {
		return io.EOF
	}
	decoder := json.NewDecoder(bytes.NewReader(r.Body))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("response contains more than one JSON value")
	}
	return nil
}

func NewClient(cfg Config) (*Client, error) {
	base, err := url.Parse(cfg.BaseURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("base URL must be an absolute HTTP(S) URL without credentials, query or fragment")
	}
	if cfg.Timeout < 0 {
		return nil, errors.New("timeout cannot be negative")
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.MaxResponseBytes == 0 {
		cfg.MaxResponseBytes = DefaultMaxResponseBytes
	}
	if cfg.MaxResponseBytes < 1 || cfg.MaxResponseBytes > 1<<30 {
		return nil, errors.New("response byte limit must be between 1 and 1 GiB")
	}
	if cfg.Retry.MaxAttempts == 0 {
		cfg.Retry.MaxAttempts = 1
	}
	if cfg.Retry.MaxAttempts < 1 || cfg.Retry.MaxAttempts > 8 {
		return nil, errors.New("retry attempts must be between 1 and 8")
	}
	if cfg.Retry.BaseDelay < 0 || cfg.Retry.MaxDelay < 0 {
		return nil, errors.New("retry delay cannot be negative")
	}
	if cfg.Retry.MaxDelay == 0 {
		cfg.Retry.MaxDelay = 2 * time.Second
	}
	transport := &http.Client{}
	if cfg.HTTPClient != nil {
		copy := *cfg.HTTPClient
		transport = &copy
	}
	// Even same-origin redirect chains can change method/body semantics. Return
	// redirects to the caller rather than forwarding credentials or mutations.
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	provider := cfg.TokenProvider
	if provider == nil {
		provider = func(context.Context) (string, error) { return cfg.Token, nil }
	}
	return &Client{baseURL: strings.TrimRight(cfg.BaseURL, "/"), token: provider, http: transport, timeout: cfg.Timeout, maxBytes: cfg.MaxResponseBytes, retry: cfg.Retry}, nil
}
func cloneQuery(values url.Values) url.Values {
	out := url.Values{}
	for k, v := range values {
		out[k] = append([]string{}, v...)
	}
	return out
}
func cloneHeaders(values http.Header) http.Header {
	copy := http.Header{}
	for key, items := range values {
		canonical := http.CanonicalHeaderKey(key)
		copy[canonical] = append(copy[canonical], items...)
	}
	return copy
}
func cloneOptions(o CallOptions) CallOptions {
	o.Params = cloneParams(o.Params)
	o.Query = cloneQuery(o.Query)
	o.Headers = cloneHeaders(o.Headers)
	o.RawBody = append([]byte(nil), o.RawBody...)
	return o
}
func cloneParams(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func routePath(path string, params map[string]string) (string, error) {
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "?#") {
		return "", errors.New("route must be an absolute path without query or fragment")
	}
	for name, value := range params {
		placeholder := "{" + name + "}"
		if !strings.Contains(path, placeholder) {
			return "", fmt.Errorf("unexpected path parameter %s", name)
		}
		if value == "" || len(value) > 4096 || value == "." || value == ".." {
			return "", fmt.Errorf("path parameter %s is empty or too large", name)
		}
		escaped := url.PathEscape(value)
		path = strings.ReplaceAll(path, placeholder, escaped)
	}
	if strings.ContainsAny(path, "{}") {
		return "", errors.New("required path parameter is missing")
	}
	return path, nil
}
func (c *Client) Build(ctx context.Context, o CallOptions) (*http.Request, error) {
	path, err := routePath(o.Path, o.Params)
	if err != nil {
		return nil, err
	}
	raw := append([]byte(nil), o.RawBody...)
	contentType := o.ContentType
	if o.Body != nil || o.HasJSONBody {
		if o.RawBody != nil {
			return nil, errors.New("JSON and raw bodies are mutually exclusive")
		}
		raw, err = json.Marshal(o.Body)
		if err != nil {
			return nil, err
		}
		contentType = "application/json"
	}
	target := c.baseURL + path
	if len(o.Query) > 0 {
		target += "?" + o.Query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, o.Method, target, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header = cloneHeaders(o.Headers)
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	token, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("token contains newline characters")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("User-Agent", "zakura-go-sdk/1")
	return request, nil
}
func limitedRead(reader io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("response exceeds configured byte limit")
	}
	return body, nil
}
func (c *Client) Open(ctx context.Context, o CallOptions) (*http.Response, error) {
	request, err := c.Build(ctx, o)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		body, readErr := limitedRead(response.Body, c.maxBytes)
		if readErr != nil {
			return nil, readErr
		}
		return nil, &APIError{StatusCode: response.StatusCode, Method: o.Method, Path: o.Path, RequestID: response.Header.Get("X-Request-ID"), Body: body}
	}
	return response, nil
}
func retryable(status int) bool {
	return status == 429 || status == 502 || status == 503 || status == 504
}
func (c *Client) delay(attempt int, headers http.Header) time.Duration {
	delay := c.retry.BaseDelay
	for i := 1; i < attempt && delay < c.retry.MaxDelay; i++ {
		if delay > c.retry.MaxDelay/2 {
			delay = c.retry.MaxDelay
		} else {
			delay *= 2
		}
	}
	value := headers.Get("Retry-After")
	if seconds, err := strconv.ParseInt(value, 10, 32); err == nil && seconds >= 0 {
		delay = time.Duration(seconds) * time.Second
	} else if when, err := http.ParseTime(value); err == nil {
		delay = time.Until(when)
	}
	if delay < 0 {
		delay = 0
	}
	if delay > c.retry.MaxDelay {
		delay = c.retry.MaxDelay
	}
	return delay
}
func (c *Client) Execute(ctx context.Context, o CallOptions) (*Response, error) {
	timeout := o.Timeout
	if timeout < 0 {
		return nil, errors.New("timeout cannot be negative")
	}
	if timeout == 0 {
		timeout = c.timeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	attempts := 1
	if o.Method == http.MethodGet || o.Method == http.MethodHead {
		attempts = c.retry.MaxAttempts
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		request, err := c.Build(ctx, o)
		if err != nil {
			return nil, err
		}
		response, err := c.http.Do(request)
		if err != nil {
			return nil, err
		}
		body, readErr := limitedRead(response.Body, c.maxBytes)
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return &Response{StatusCode: response.StatusCode, Headers: response.Header.Clone(), Body: body}, nil
		}
		if attempt == attempts || !retryable(response.StatusCode) {
			return nil, &APIError{StatusCode: response.StatusCode, Method: o.Method, Path: o.Path, RequestID: response.Header.Get("X-Request-ID"), Body: body}
		}
		timer := time.NewTimer(c.delay(attempt, response.Header))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, errors.New("unreachable retry state")
}

// Pages does not assume the server's envelope shape. The caller extracts the
// next cursor and consumes the response, with a cap and repeated-cursor guard.
func (c *Client) Pages(ctx context.Context, o CallOptions, key string, maxPages int, next func(*Response) (string, error)) error {
	if o.Method != http.MethodGet || key == "" || maxPages < 1 || maxPages > 10000 || next == nil {
		return errors.New("invalid pagination configuration")
	}
	o = cloneOptions(o)
	seen := map[string]bool{}
	for page := 0; page < maxPages; page++ {
		response, err := c.Execute(ctx, o)
		if err != nil {
			return err
		}
		cursor, err := next(response)
		if err != nil {
			return err
		}
		if cursor == "" {
			return nil
		}
		if seen[cursor] {
			return errors.New("pagination repeated a cursor")
		}
		seen[cursor] = true
		o.Query.Set(key, cursor)
	}
	return errors.New("pagination reached configured page limit")
}
