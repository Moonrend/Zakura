// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
)

const (
	webSearchDefaultLimit = 5
	webSearchMinLimit     = 1
	webSearchMaxLimit     = 10
	webSearchTimeout      = 15 * time.Second
	webFetchDefaultBytes  = 20000
	webFetchMaxBytes      = 100000
	webFetchTimeout       = 20 * time.Second
	webFetchMaxReadBytes  = 1 << 20
	webFetchUserAgent     = "Mozilla/5.0 (compatible; ZakuraAgent)"
)

var (
	webSearchHTTPClient = &http.Client{Timeout: webSearchTimeout}
	webFetchHTTPClient  = &http.Client{Timeout: webFetchTimeout}
	webSearchEngineIDs  = []string{"tavily", "serper", "brave", "jina", "bing", "searxng"}
)

type webSearchEngine struct {
	ID      string
	APIKey  string
	BaseURL string
}

type webSearchResult struct {
	Title   string
	URL     string
	Snippet string
}

type webFetchBackend struct {
	ID                string
	APIKey            string
	BaseURL           string
	AllowPrivateHosts bool
}

func providerToolEnabled(providers map[string]any, key string) bool {
	cfg, _ := providers[key].(map[string]any)
	if enabled, ok := cfg["enabled"].(bool); ok {
		return enabled
	}
	return true
}

func nestedMap(root map[string]any, keys ...string) map[string]any {
	current := root
	for _, key := range keys {
		next, ok := current[key].(map[string]any)
		if !ok {
			return map[string]any{}
		}
		current = next
	}
	return current
}

func mapStringValue(value any) string {
	text, _ := value.(string)
	return text
}

func mapBoolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (h *handler) platformServiceEndpoint(ctx context.Context, key string) string {
	var row struct {
		EndpointURL *string `gorm:"column:endpoint_url"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("platform_services").Select("endpoint_url").Where("service_key = ?", key).Take(&row).Error; err != nil {
		return ""
	}
	if row.EndpointURL == nil {
		return ""
	}
	return strings.TrimSuffix(strings.TrimSpace(*row.EndpointURL), "/")
}

func agentProviderConfig(record Agent, key string) map[string]any {
	cfg := map[string]any{}
	_ = json.Unmarshal(record.Config, &cfg)
	return nestedMap(cfg, "providers", key)
}

func webSearchEngineFromEntry(h *handler, ctx context.Context, id string, entry map[string]any) (webSearchEngine, bool) {
	if enabled, ok := entry["enabled"].(bool); ok && !enabled {
		return webSearchEngine{}, false
	}
	engine := webSearchEngine{ID: id, APIKey: strings.TrimSpace(mapStringValue(entry["apiKey"])), BaseURL: strings.TrimSuffix(strings.TrimSpace(mapStringValue(entry["baseUrl"])), "/")}
	switch id {
	case "tavily", "serper", "brave", "bing":
		if engine.APIKey == "" {
			return webSearchEngine{}, false
		}
	case "jina":
	case "searxng":
		if engine.BaseURL == "" {
			engine.BaseURL = h.platformServiceEndpoint(ctx, "searxng")
		}
		if engine.BaseURL == "" {
			return webSearchEngine{}, false
		}
	default:
		return webSearchEngine{}, false
	}
	return engine, true
}

func (h *handler) webSearchConfig(ctx context.Context, tenant, agent string) (webSearchEngine, error) {
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return webSearchEngine{}, err
	}
	agentSearch := agentProviderConfig(record, "webSearch")
	if enabled, ok := agentSearch["enabled"].(bool); ok && !enabled {
		return webSearchEngine{}, errors.New("web search is disabled for this agent")
	}
	settings := map[string]any{}
	if value, settingErr := h.getSetting(ctx, "tenant:"+tenant, "web-search"); settingErr == nil {
		settings = value
	} else if !errors.Is(settingErr, gorm.ErrRecordNotFound) {
		return webSearchEngine{}, settingErr
	}
	engines := map[string]map[string]any{}
	if rawEngines, ok := settings["engines"].(map[string]any); ok {
		for id, rawEntry := range rawEngines {
			if entry, ok := rawEntry.(map[string]any); ok {
				engines[id] = entry
			}
		}
	}
	pick := func(id string) (webSearchEngine, bool) {
		entry, ok := engines[id]
		if !ok {
			return webSearchEngine{}, false
		}
		return webSearchEngineFromEntry(h, ctx, id, entry)
	}
	defaultEngine := firstNonEmpty(mapStringValue(agentSearch["defaultEngine"]), mapStringValue(settings["defaultEngine"]))
	if defaultEngine != "" {
		if engine, ok := pick(defaultEngine); ok {
			return engine, nil
		}
	}
	for _, id := range webSearchEngineIDs {
		if engine, ok := pick(id); ok {
			return engine, nil
		}
	}
	return webSearchEngine{}, errors.New("web search is not configured")
}

func (h *handler) webFetchConfig(ctx context.Context, tenant, agent string) (webFetchBackend, error) {
	record, err := h.store.GetAgent(ctx, tenant, agent)
	if err != nil {
		return webFetchBackend{}, err
	}
	agentFetch := agentProviderConfig(record, "webFetch")
	if enabled, ok := agentFetch["enabled"].(bool); ok && !enabled {
		return webFetchBackend{}, errors.New("web fetch is disabled for this agent")
	}
	settings := map[string]any{}
	if value, settingErr := h.getSetting(ctx, "tenant:"+tenant, "web-fetch"); settingErr == nil {
		settings = value
	} else if !errors.Is(settingErr, gorm.ErrRecordNotFound) {
		return webFetchBackend{}, settingErr
	}
	backends := map[string]map[string]any{}
	if rawBackends, ok := settings["backends"].(map[string]any); ok {
		for id, rawEntry := range rawBackends {
			if entry, ok := rawEntry.(map[string]any); ok {
				backends[id] = entry
			}
		}
	}
	backendID := firstNonEmpty(mapStringValue(agentFetch["defaultBackend"]), mapStringValue(settings["defaultBackend"]))
	if backendID == "" {
		backendID = "native"
	}
	entry := backends[backendID]
	backend := webFetchBackend{
		ID:                backendID,
		AllowPrivateHosts: mapBoolValue(settings["allowPrivateHosts"]) || mapBoolValue(agentFetch["allowPrivateHosts"]) || mapBoolValue(entry["allowPrivateHosts"]),
	}
	switch backendID {
	case "native":
	case "jina-reader":
		backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, "jina-reader"), "https://r.jina.ai")
	case "firecrawl":
		backend.APIKey = strings.TrimSpace(mapStringValue(entry["apiKey"]))
		backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, "firecrawl"), "https://api.firecrawl.dev")
	case "crawl4ai":
		backend.BaseURL = firstNonEmpty(mapStringValue(entry["baseUrl"]), h.platformServiceEndpoint(ctx, "crawl4ai"))
		if backend.BaseURL == "" {
			return webFetchBackend{}, errors.New("web fetch backend crawl4ai is not configured")
		}
	default:
		return webFetchBackend{}, fmt.Errorf("unknown web fetch backend %q", backendID)
	}
	return backend, nil
}

func (h *handler) runWebSearch(ctx context.Context, tenant, agent string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	query := strings.TrimSpace(builtinStringArg(parsed, "query"))
	if query == "" {
		return nil, errors.New("query is required")
	}
	limit := builtinIntArg(parsed, "limit", webSearchDefaultLimit)
	if limit < webSearchMinLimit {
		limit = webSearchMinLimit
	}
	if limit > webSearchMaxLimit {
		limit = webSearchMaxLimit
	}
	engine, err := h.webSearchConfig(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	results, err := executeWebSearch(ctx, engine, query, limit)
	if err != nil {
		return nil, err
	}
	text, _ := h.truncateToolText(ctx, tenant, agent, formatWebSearchResults(results), "websearch")
	return json.RawMessage(text), nil
}

func formatWebSearchResults(results []webSearchResult) string {
	if len(results) == 0 {
		return "No results found."
	}
	var b strings.Builder
	for _, result := range results {
		b.WriteString("- " + result.Title + "\n")
		b.WriteString("  " + result.URL + "\n")
		if snippet := strings.TrimSpace(result.Snippet); snippet != "" {
			b.WriteString("  " + snippet + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func executeWebSearch(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	switch engine.ID {
	case "tavily":
		return webSearchTavily(ctx, engine, query, limit)
	case "serper":
		return webSearchSerper(ctx, engine, query, limit)
	case "brave":
		return webSearchBrave(ctx, engine, query, limit)
	case "jina":
		return webSearchJina(ctx, engine, query, limit)
	case "bing":
		return webSearchBing(ctx, engine, query, limit)
	case "searxng":
		return webSearchSearxng(ctx, engine, query, limit)
	}
	return nil, fmt.Errorf("web search engine %s is not supported", engine.ID)
}

func webSearchRequest(ctx context.Context, method, endpoint string, body any, headers map[string]string) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := webSearchHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxReadBytes))
	return raw, resp.StatusCode, err
}

func webSearchStatusError(engine webSearchEngine, status int) error {
	return fmt.Errorf("web search engine %s failed: HTTP %d", engine.ID, status)
}

func webSearchTavily(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	base := engine.BaseURL
	if base == "" {
		base = "https://api.tavily.com"
	}
	raw, status, err := webSearchRequest(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/search", map[string]any{"api_key": engine.APIKey, "query": query, "max_results": limit}, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var out struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]webSearchResult, 0, len(out.Results))
	for _, item := range out.Results {
		results = append(results, webSearchResult{Title: item.Title, URL: item.URL, Snippet: item.Content})
	}
	return results, nil
}

func webSearchSerper(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	base := engine.BaseURL
	if base == "" {
		base = "https://google.serper.dev"
	}
	raw, status, err := webSearchRequest(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/search", map[string]any{"q": query, "num": limit}, map[string]string{"X-API-KEY": engine.APIKey})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var out struct {
		Organic []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
		} `json:"organic"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]webSearchResult, 0, len(out.Organic))
	for _, item := range out.Organic {
		results = append(results, webSearchResult{Title: item.Title, URL: item.Link, Snippet: item.Snippet})
	}
	return results, nil
}

func webSearchBrave(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	base := engine.BaseURL
	if base == "" {
		base = "https://api.search.brave.com"
	}
	params := url.Values{"q": {query}, "count": {strconv.Itoa(limit)}}
	raw, status, err := webSearchRequest(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/res/v1/web/search?"+params.Encode(), nil, map[string]string{"X-Subscription-Token": engine.APIKey})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var out struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]webSearchResult, 0, len(out.Web.Results))
	for _, item := range out.Web.Results {
		results = append(results, webSearchResult{Title: item.Title, URL: item.URL, Snippet: item.Description})
	}
	return results, nil
}

func webSearchJina(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	base := engine.BaseURL
	if base == "" {
		base = "https://s.jina.ai"
	}
	raw, status, err := webSearchRequest(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/"+url.PathEscape(query), nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var out struct {
		Data []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil
	}
	results := make([]webSearchResult, 0, len(out.Data))
	for _, item := range out.Data {
		if len(results) >= limit {
			break
		}
		results = append(results, webSearchResult{Title: item.Title, URL: item.URL, Snippet: item.Content})
	}
	return results, nil
}

func webSearchSearxng(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	params := url.Values{"q": {query}, "format": {"json"}}
	raw, status, err := webSearchRequest(ctx, http.MethodGet, strings.TrimSuffix(engine.BaseURL, "/")+"/search?"+params.Encode(), nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var out struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
			Snippet string `json:"snippet"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	results := make([]webSearchResult, 0, len(out.Results))
	for _, item := range out.Results {
		snippet := item.Content
		if strings.TrimSpace(snippet) == "" {
			snippet = item.Snippet
		}
		results = append(results, webSearchResult{Title: item.Title, URL: item.URL, Snippet: snippet})
		if len(results) >= limit {
			break
		}
	}
	return results, nil
}

type webSearchRSS struct {
	Channel struct {
		Items []struct {
			Title       string `xml:"title"`
			Link        string `xml:"link"`
			Description string `xml:"description"`
		} `xml:"item"`
	} `xml:"channel"`
}

func webSearchBing(ctx context.Context, engine webSearchEngine, query string, limit int) ([]webSearchResult, error) {
	base := engine.BaseURL
	if base == "" {
		base = "https://www.bing.com"
	}
	params := url.Values{"q": {query}, "format": {"rss"}}
	raw, status, err := webSearchRequest(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/search?"+params.Encode(), nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, webSearchStatusError(engine, status)
	}
	var feed webSearchRSS
	if err := xml.Unmarshal(raw, &feed); err != nil {
		return nil, nil
	}
	results := make([]webSearchResult, 0, len(feed.Channel.Items))
	for _, item := range feed.Channel.Items {
		if len(results) >= limit {
			break
		}
		results = append(results, webSearchResult{Title: item.Title, URL: item.Link, Snippet: item.Description})
	}
	return results, nil
}

func (h *handler) runWebFetch(ctx context.Context, tenant, agent string, args json.RawMessage) (json.RawMessage, error) {
	parsed := map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return nil, fmt.Errorf("invalid tool arguments: %w", err)
		}
	}
	rawURL := strings.TrimSpace(builtinStringArg(parsed, "url"))
	if rawURL == "" {
		return nil, errors.New("url is required")
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil || parsedURL.Host == "" {
		return nil, errors.New("invalid URL: must include http:// or https://")
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, fmt.Errorf("invalid URL protocol: %s (must be http or https)", parsedURL.Scheme)
	}
	maxBytes := builtinIntArg(parsed, "max_bytes", webFetchDefaultBytes)
	if maxBytes < 1 {
		maxBytes = webFetchDefaultBytes
	}
	if maxBytes > webFetchMaxBytes {
		maxBytes = webFetchMaxBytes
	}
	backend, err := h.webFetchConfig(ctx, tenant, agent)
	if err != nil {
		return nil, err
	}
	if backend.ID == "native" && !backend.AllowPrivateHosts {
		if err := rejectPrivateHost(parsedURL.Hostname()); err != nil {
			return nil, err
		}
	}
	var content string
	switch backend.ID {
	case "native":
		content, err = fetchNative(ctx, parsedURL, maxBytes)
	case "jina-reader":
		content, err = fetchJinaReader(ctx, backend, rawURL)
	case "firecrawl":
		content, err = fetchFirecrawl(ctx, backend, rawURL)
	case "crawl4ai":
		content, err = fetchCrawl4AI(ctx, backend, rawURL)
	}
	if err != nil {
		return nil, err
	}
	text, _ := h.truncateToolText(ctx, tenant, agent, "# Content from "+rawURL+"\n\n"+content, "webfetch")
	return json.RawMessage(text), nil
}

func rejectPrivateHost(host string) error {
	name := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	if name == "" || name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return errors.New("fetching private addresses is not allowed")
	}
	ip := net.ParseIP(name)
	if ip == nil {
		return nil
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return errors.New("fetching private addresses is not allowed")
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return errors.New("fetching private addresses is not allowed")
	}
	return nil
}

var (
	htmlScriptRE    = regexp.MustCompile(`(?is)<script[^>]*>.*?</script\s*>`)
	htmlStyleRE     = regexp.MustCompile(`(?is)<style[^>]*>.*?</style\s*>`)
	htmlCommentRE   = regexp.MustCompile(`(?s)<!--.*?-->`)
	htmlBreakRE     = regexp.MustCompile(`(?i)<\s*(?:br|/p|/div|/li|/tr|/h[1-6]|/section|/article|/table|/ul|/ol)\s*/?>`)
	htmlTagRE       = regexp.MustCompile(`(?s)<[^>]*>`)
	htmlSpaceRE     = regexp.MustCompile(`[ \t\f\v]+`)
	htmlBlankLineRE = regexp.MustCompile(`\n{3,}`)
)

func htmlToText(input string) string {
	text := htmlScriptRE.ReplaceAllString(input, " ")
	text = htmlStyleRE.ReplaceAllString(text, " ")
	text = htmlCommentRE.ReplaceAllString(text, "")
	text = htmlBreakRE.ReplaceAllString(text, "\n")
	text = htmlTagRE.ReplaceAllString(text, "")
	text = html.UnescapeString(text)
	text = htmlSpaceRE.ReplaceAllString(text, " ")
	text = htmlBlankLineRE.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

func fetchNative(ctx context.Context, target *url.URL, maxBytes int) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", webFetchUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
	resp, err := webFetchHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("web fetch failed: HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxReadBytes))
	if err != nil {
		return "", err
	}
	text := htmlToText(string(raw))
	if len(text) > maxBytes {
		text = text[:maxBytes]
	}
	return text, nil
}

func webFetchRequest(ctx context.Context, method, endpoint string, body any, headers map[string]string) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := webFetchHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxReadBytes))
	return raw, resp.StatusCode, err
}

func webFetchBackendError(backend webFetchBackend, status int) error {
	return fmt.Errorf("web fetch backend %s failed: HTTP %d", backend.ID, status)
}

func fetchJinaReader(ctx context.Context, backend webFetchBackend, rawURL string) (string, error) {
	base := backend.BaseURL
	if base == "" {
		base = "https://r.jina.ai"
	}
	raw, status, err := webFetchRequest(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/r/"+rawURL, nil, map[string]string{"Accept": "text/plain"})
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", webFetchBackendError(backend, status)
	}
	return string(raw), nil
}

func fetchFirecrawl(ctx context.Context, backend webFetchBackend, rawURL string) (string, error) {
	base := backend.BaseURL
	if base == "" {
		base = "https://api.firecrawl.dev"
	}
	headers := map[string]string{}
	if backend.APIKey != "" {
		headers["Authorization"] = "Bearer " + backend.APIKey
	}
	raw, status, err := webFetchRequest(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/v1/scrape", map[string]any{"url": rawURL, "formats": []string{"markdown"}}, headers)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", webFetchBackendError(backend, status)
	}
	var out struct {
		Data struct {
			Markdown string `json:"markdown"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	return out.Data.Markdown, nil
}

func fetchCrawl4AI(ctx context.Context, backend webFetchBackend, rawURL string) (string, error) {
	raw, status, err := webFetchRequest(ctx, http.MethodPost, strings.TrimSuffix(backend.BaseURL, "/")+"/markdown", map[string]any{"url": rawURL}, nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", webFetchBackendError(backend, status)
	}
	var out struct {
		Markdown string `json:"markdown"`
		Results  []struct {
			Markdown string `json:"markdown"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if out.Markdown != "" {
		return out.Markdown, nil
	}
	if len(out.Results) > 0 {
		return out.Results[0].Markdown, nil
	}
	return "", nil
}
