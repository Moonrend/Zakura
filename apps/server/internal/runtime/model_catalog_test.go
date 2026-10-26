// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

func TestModelCatalogParsing(t *testing.T) {
	payload := `{"openai":{"name":"OpenAI","api":"https://api.openai.com/v1","models":{"sample":{"name":"Sample","limit":{"context":200000,"output":32000},"reasoning":true,"tool_call":false,"attachment":true,"open_weights":false,"modalities":{"input":["text","image"],"output":["text"]},"cost":{"input":0,"output":4,"cache_read":0.2,"cache_write":0.3},"reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","auto"]}],"release_date":"2026-01-01"},"unknown":{}}}}`
	for _, source := range []string{"models.dev", "llm-metadata"} {
		t.Run(source, func(t *testing.T) {
			entries, err := parseModelCatalog(source, []byte(payload))
			if err != nil || len(entries) != 2 {
				t.Fatalf("entries=%v err=%v", entries, err)
			}
			meta := entries[0].Meta
			if meta["source"] != source || meta["contextLimit"] != float64(200000) || meta["outputLimit"] != float64(32000) || meta["toolCall"] != false || meta["openWeights"] != false || meta["attachment"] != true {
				t.Fatalf("metadata mapping: %v", meta)
			}
			if !reflect.DeepEqual(catalogStrings(meta["reasoningLevels"]), []string{"none", "low", "high", "auto"}) || meta["defaultReasonLevel"] != "auto" {
				t.Fatalf("reasoning mapping: %v", meta)
			}
			cost := gwMap(meta["cost"])
			if cost["input"] != float64(0) || cost["cacheRead"] != 0.2 || cost["cacheWrite"] != 0.3 {
				t.Fatalf("cost mapping: %v", cost)
			}
			for _, key := range []string{"contextLimit", "reasoning", "toolCall", "cost", "reasoningLevels"} {
				if _, exists := entries[1].Meta[key]; exists {
					t.Fatalf("invented %s for missing metadata", key)
				}
			}
		})
	}
	entries, err := parseModelCatalog("llm-metadata", []byte(`{"providers":[{"id":"example","name":"Example"}],"models":[{"id":"embed-small","provider":"example","limit":{"context":0,"output":0},"reasoningLevels":[]}]}`))
	if err != nil || len(entries) != 1 || entries[0].ProviderName != "Example" || !containsCatalogString(entries[0].Meta["capabilities"], "embedding") || entries[0].Meta["contextLimit"] != float64(0) {
		t.Fatalf("array catalog: %v %v", entries, err)
	}
	for _, payload := range []string{`{}`, `null`, `[]`, `{broken`, `{"error":"unavailable"}`, `{"p":{"models":{"x":null}}}`} {
		if _, err := parseModelCatalog("models.dev", []byte(payload)); err == nil {
			t.Fatalf("accepted invalid catalog %s", payload)
		}
	}
}

func TestModelCatalogMatching(t *testing.T) {
	entries, err := parseModelCatalog("models.dev", []byte(`{"openai":{"api":"https://api.openai.com/v1","models":{"sample-1":{},"other-1":{},"shared":{},"a-b":{},"a_b":{}}},"relay":{"api":"https://relay.example/v1","models":{"shared":{}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, reverse := range []bool{false, true} {
		if reverse {
			for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
		index := newCatalogIndex(entries)
		for _, tc := range []struct{ native, canonical, base, provider string }{
			{"sample-1", "", "", "openai"},
			{"Sample_1", "", "", "openai"},
			{"models/sample-1", "", "", "openai"},
			{"openai/sample-1", "", "", "openai"},
			{"custom-alias", "sample-1", "", "openai"},
			{"shared", "", "", ""},
			{"shared", "sample-1", "", ""},
			{"shared", "", "https://relay.example/v1", "relay"},
			{"sample", "", "", ""},
			{"sample-1-20260101", "", "", ""},
			{"sample-1", "other-1", "", ""},
			{"a b", "", "", ""},
			{"a_b", "", "", "openai"},
		} {
			entry := index.match(tc.native, tc.canonical, "chat", tc.base)
			if tc.provider == "" && entry != nil || tc.provider != "" && (entry == nil || entry.ProviderID != tc.provider) {
				t.Fatalf("match %+v = %+v (reverse=%v)", tc, entry, reverse)
			}
		}
		if entry := index.match("sample-1", "", "evaluation", ""); entry != nil {
			t.Fatal("matched incompatible capability")
		}
	}
}

type catalogTestTransport func(*http.Request) (*http.Response, error)

func (f catalogTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func catalogTestResponse(status int, payload string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(payload))}
}

type catalogFixture struct {
	mu       sync.Mutex
	context  int
	fail     map[string]bool
	requests int
}

func (f *catalogFixture) client(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{Transport: catalogTestTransport(func(req *http.Request) (*http.Response, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if req.Header.Get("Authorization") != "" || req.Header.Get("x-api-key") != "" || req.Header.Get("Cookie") != "" {
			t.Error("credentials sent to a public catalog")
		}
		if _, ok := req.Context().Deadline(); !ok {
			t.Error("catalog request has no deadline")
		}
		f.requests++
		if f.fail[req.URL.Host] {
			return catalogTestResponse(503, "offline"), nil
		}
		switch req.URL.Host {
		case "models.dev":
			return catalogTestResponse(200, fmt.Sprintf(`{"openai":{"name":"OpenAI","api":"https://api.openai.com/v1","models":{"sample-1":{"limit":{"context":%d,"output":16000},"reasoning":true,"tool_call":false,"cost":{"input":1,"output":2}},"not-installed":{}}}}`, f.context)), nil
		case "basellm.github.io":
			return catalogTestResponse(200, `{"openai":{"name":"OpenAI","models":{"sample-1":{"reasoning_options":[{"type":"effort","values":["low","high"]}]}}}}`), nil
		default:
			return nil, fmt.Errorf("unexpected network request to %s", req.URL)
		}
	})}
}

func seedCatalogModel(t *testing.T, d *appdeps.Dependencies, tenant, upstream, id, native, capability, meta string) {
	t.Helper()
	now := runtimeTimeString(d.Clock())
	if err := d.Gorm.Table("upstream_models").Create(map[string]any{"id": id, "tenant_id": tenant, "upstream_id": upstream, "native_model": native, "canonical_model": native, "capability": capability, "weight": "100", "is_default": false, "options_json": `{"customOption":true}`, "meta_json": meta, "status": "ready", "created_at": now, "updated_at": now}).Error; err != nil {
		t.Fatal(err)
	}
}

func readCatalogModel(t *testing.T, d *appdeps.Dependencies, id string) map[string]any {
	t.Helper()
	var raw string
	if err := d.DB.QueryRow("SELECT meta_json FROM upstream_models WHERE id=?", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return catalogMetaJSON(raw)
}

func TestRefreshModelCatalogEndToEnd(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	seedTenant(t, d, "other")
	fixture := &catalogFixture{context: 200000, fail: map[string]bool{}}
	d.HTTPClient = fixture.client(t)
	store := NewStore(d)
	ctx := context.Background()
	up, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: "Up", Protocol: "openai", Config: json.RawMessage(`{"baseUrl":"https://api.openai.com/v1","apiKey":"private-key"}`)})
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateUpstream(ctx, "other", Upstream{Name: "Other", Protocol: "openai"})
	if err != nil {
		t.Fatal(err)
	}
	seedCatalogModel(t, d, "tenant", up.ID, "installed", "sample-1", "chat", `{}`)
	seedCatalogModel(t, d, "tenant", up.ID, "unknown", "custom-private", "chat", `{"contextLimit":12345}`)
	seedCatalogModel(t, d, "other", other.ID, "other-model", "sample-1", "chat", `{}`)
	alias := "my-alias"
	if _, err := store.CreateRoute(ctx, "tenant", ModelRoute{Name: "Sample", Alias: &alias, UpstreamID: up.ID, Model: "sample-1", Capability: "chat"}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	refresh := func() map[string]any {
		t.Helper()
		status, result := doJSON(t, server.Client(), "POST", server.URL+"/api/model-catalog/refresh", token, map[string]any{})
		if status != 200 {
			t.Fatalf("refresh status=%d: %v", status, result)
		}
		return result
	}
	result := refresh()
	if result["catalogEntries"] != float64(3) || result["matched"] != float64(1) || result["updated"] != float64(1) || result["unmatched"] != float64(1) {
		t.Fatalf("incorrect refresh counts: %v", result)
	}
	meta := readCatalogModel(t, d, "installed")
	if meta["contextLimit"] != float64(200000) || meta["outputLimit"] != float64(16000) || meta["toolCall"] != false || !reflect.DeepEqual(catalogStrings(meta["reasoningLevels"]), []string{"low", "high"}) {
		t.Fatalf("metadata not persisted: %v", meta)
	}
	for _, endpoint := range []string{"/api/upstream-models?grouped=1", "/api/model-routes?capability=chat"} {
		status, body := doJSON(t, server.Client(), "GET", server.URL+endpoint, token, nil)
		if status != 200 {
			t.Fatalf("%s status=%d: %v", endpoint, status, body)
		}
		var meta map[string]any
		if strings.Contains(endpoint, "model-routes") {
			routes := body["routes"].([]any)
			if len(routes) != 1 || gwMap(routes[0])["alias"] != alias {
				t.Fatalf("refresh changed routes: %v", routes)
			}
			meta = gwMap(gwMap(routes[0])["meta"])
		} else {
			for _, group := range body["models"].([]any) {
				if gwMap(group)["canonicalModel"] == "sample-1" {
					meta = gwMap(gwMap(gwMap(group)["deployments"].([]any)[0])["meta"])
				}
			}
		}
		if meta["contextLimit"] != float64(200000) || len(catalogStrings(meta["reasoningLevels"])) != 2 {
			t.Fatalf("%s lost metadata: %v", endpoint, meta)
		}
	}
	h := &handler{deps: d, store: store}
	gateway, err := h.gatewayModels(ctx, "tenant")
	if err != nil || len(gateway) != 1 || gwInt(gateway[0].Metadata["contextLimit"]) != 200000 {
		t.Fatalf("gateway metadata: %v %v", gateway, err)
	}
	acp, _, err := h.acpGatewayModels(ctx, "tenant")
	if err != nil || len(acp) != 1 || acp[0].ContextLimit != 200000 || acp[0].ToolCall == nil || *acp[0].ToolCall {
		t.Fatalf("ACP metadata: %v %v", acp, err)
	}
	if result := refresh(); result["updated"] != float64(0) || result["unchanged"] != float64(1) {
		t.Fatalf("identical refresh not reported as unchanged: %v", result)
	} else {
		unmatched := result["unmatchedModels"].([]any)
		if len(unmatched) != 1 || gwMap(unmatched[0])["nativeModel"] != "custom-private" || gwMap(unmatched[0])["reason"] != "not_found" {
			t.Fatalf("missing unmatched model diagnostics: %v", result)
		}
	}
	meta["contextLimit"] = float64(64000)
	meta["custom"] = "keep"
	gwMap(meta["cost"])["input"] = float64(0)
	raw, _ := json.Marshal(meta)
	if err := d.Gorm.Table("upstream_models").Where("id=?", "installed").Update("meta_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	fixture.context = 300000
	fixture.mu.Unlock()
	refresh()
	meta = readCatalogModel(t, d, "installed")
	if meta["contextLimit"] != float64(64000) || meta["custom"] != "keep" || gwMap(meta["cost"])["input"] != float64(0) {
		t.Fatalf("manual metadata overwritten: %v", meta)
	}
	if len(readCatalogModel(t, d, "other-model")) != 0 || readCatalogModel(t, d, "unknown")["contextLimit"] != float64(12345) {
		t.Fatal("unmatched or other-tenant metadata changed")
	}
	var count int64
	d.Gorm.Table("upstream_models").Count(&count)
	if count != 3 {
		t.Fatalf("refresh discovered uninstalled models: %d", count)
	}
	d.Gorm.Table("model_catalog_entries").Where("tenant_id=?", "other").Count(&count)
	if count != 0 {
		t.Fatal("catalog escaped tenant")
	}
	var options string
	if err := d.DB.QueryRow("SELECT options_json FROM upstream_models WHERE id='installed'").Scan(&options); err != nil || options != `{"customOption":true}` {
		t.Fatalf("deployment options changed: %s %v", options, err)
	}
	fixture.mu.Lock()
	fixture.fail["models.dev"], fixture.fail["basellm.github.io"] = true, true
	fixture.mu.Unlock()
	status, failure := doJSON(t, server.Client(), "POST", server.URL+"/api/model-catalog/refresh", token, nil)
	if status != http.StatusBadGateway || !strings.Contains(fmt.Sprint(failure), "models.dev") || !strings.Contains(fmt.Sprint(failure), "llm-metadata") {
		t.Fatalf("all-source failure appeared successful: %d %v", status, failure)
	}
}

func TestRefreshModelCatalogFailuresAndRollback(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	fixture := &catalogFixture{context: 200000, fail: map[string]bool{}}
	d.HTTPClient = fixture.client(t)
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up"})
	if err != nil {
		t.Fatal(err)
	}
	seedCatalogModel(t, d, "tenant", up.ID, "model", "sample-1", "chat", `{}`)
	h := &handler{deps: d, store: store}
	if _, err := h.refreshCatalogMetadata(context.Background(), "tenant"); err != nil {
		t.Fatal(err)
	}
	fixture.fail["basellm.github.io"] = true
	fixture.context = 300000
	result, err := h.refreshCatalogMetadata(context.Background(), "tenant")
	if err != nil || len(result.Failed) != 1 || result.Updated != 1 || readCatalogModel(t, d, "model")["contextLimit"] != float64(300000) {
		t.Fatalf("partial refresh: %+v %v", result, err)
	}
	fixture.fail["models.dev"] = true
	result, err = h.refreshCatalogMetadata(context.Background(), "tenant")
	if err == nil || len(result.Failed) != 2 || readCatalogModel(t, d, "model")["contextLimit"] != float64(300000) {
		t.Fatalf("total source failure: %+v %v", result, err)
	}
	delete(fixture.fail, "models.dev")
	fixture.context = 400000
	if err := d.Gorm.Exec(`CREATE TRIGGER fail_catalog_update BEFORE UPDATE OF meta_json ON upstream_models BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.refreshCatalogMetadata(context.Background(), "tenant"); err == nil {
		t.Fatal("inventory write failure ignored")
	}
	var cache string
	if err := d.DB.QueryRow("SELECT meta_json FROM model_catalog_entries WHERE tenant_id='tenant' AND source='models.dev' AND model_id='sample-1'").Scan(&cache); err != nil {
		t.Fatal(err)
	}
	if catalogMetaJSON(cache)["contextLimit"] != float64(300000) {
		t.Fatal("catalog baseline advanced despite inventory rollback")
	}
	if err := d.Gorm.Exec("DROP TRIGGER fail_catalog_update").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.refreshCatalogMetadata(context.Background(), "tenant"); err != nil || readCatalogModel(t, d, "model")["contextLimit"] != float64(400000) {
		t.Fatalf("retry misclassified generated values as manual: %v", err)
	}
}

func TestModelCatalogFetchRejectsInvalidResponses(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		payload string
		err     error
	}{
		{"http", 503, "offline", nil},
		{"invalid", 200, "{invalid", nil},
		{"empty", 200, "{}", nil},
		{"large", 200, strings.Repeat(" ", modelCatalogMaxBytes+1), nil},
		{"timeout", 0, "", context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &appdeps.Dependencies{HTTPClient: &http.Client{Transport: catalogTestTransport(func(*http.Request) (*http.Response, error) {
				if tc.err != nil {
					return nil, tc.err
				}
				return catalogTestResponse(tc.status, tc.payload), nil
			})}}
			if _, err := (&handler{deps: d}).fetchModelCatalog(context.Background(), "models.dev", modelCatalogSources[0].url); err == nil {
				t.Fatal("bad catalog accepted")
			}
		})
	}
}

func TestModelRoutesMetadataBatchAndIsolation(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	seedTenant(t, d, "other")
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up"})
	if err != nil {
		t.Fatal(err)
	}
	up2, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Second"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.CreateUpstream(context.Background(), "other", Upstream{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	seedCatalogModel(t, d, "tenant", up.ID, "chat", "same", "chat", `{"contextLimit":200000,"reasoningLevels":["low","high"],"defaultReasonLevel":"high"}`)
	seedCatalogModel(t, d, "tenant", up.ID, "embedding", "same", "embedding", `{"contextLimit":8192}`)
	seedCatalogModel(t, d, "tenant", up2.ID, "bad", "same", "chat", `{invalid`)
	seedCatalogModel(t, d, "other", other.ID, "foreign", "same", "chat", `{"contextLimit":1}`)
	queries := 0
	callback := "test:catalog_routes_queries"
	if err := d.Gorm.Callback().Query().Before("gorm:query").Register(callback, func(*gorm.DB) { queries++ }); err != nil {
		t.Fatal(err)
	}
	if err := d.Gorm.Callback().Row().Before("gorm:row").Register(callback, func(*gorm.DB) { queries++ }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.Gorm.Callback().Query().Remove(callback)
		d.Gorm.Callback().Row().Remove(callback)
	})
	routes := []ModelRoute{
		{UpstreamID: up.ID, Model: "same", Capability: "chat"},
		{UpstreamID: up.ID, Model: "same", Capability: "embedding"},
		{UpstreamID: up2.ID, Model: "same", Capability: "chat"},
		{UpstreamID: other.ID, Model: "same", Capability: "chat"},
	}
	for range 1200 {
		routes = append(routes, routes[0])
	}
	out, err := (&handler{deps: d, store: store}).modelRoutesWithMetadata(context.Background(), "tenant", routes)
	if err != nil || len(out) != len(routes) || queries != 1 {
		t.Fatalf("batch routes len=%d queries=%d err=%v", len(out), queries, err)
	}
	if gwInt(out[0].Meta["contextLimit"]) != 200000 || gwInt(out[1].Meta["contextLimit"]) != 8192 || out[2].Meta["contextLimit"] != nil || out[3].Meta["contextLimit"] != nil || out[0].Meta["defaultReasonLevel"] != "high" {
		t.Fatalf("metadata association failed: %v", out[:4])
	}
}

func TestModelCatalogLiveSources(t *testing.T) {
	if os.Getenv("ZAKURA_TEST_LIVE_MODEL_CATALOG") != "1" {
		t.Skip("live catalog check is opt-in")
	}
	h := &handler{deps: &appdeps.Dependencies{}}
	var entries []catalogEntry
	for _, source := range modelCatalogSources {
		fetched, err := h.fetchModelCatalog(context.Background(), source.name, source.url)
		if err != nil {
			t.Errorf("%s: %v", source.name, err)
			continue
		}
		t.Logf("%s: %d entries", source.name, len(fetched))
		entries = append(entries, fetched...)
	}
	index := newCatalogIndex(entries)
	for _, tc := range []struct{ id, base, provider string }{
		{"gpt-4o", "", "openai"},
		{"gemini-flash-latest", "", "google"},
		{"qwen-flash", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "alibaba"},
	} {
		entry := index.match(tc.id, "", "chat", tc.base)
		if entry == nil || entry.ProviderID != tc.provider || gwInt(entry.Meta["contextLimit"]) == 0 {
			t.Errorf("live catalog did not match %s to %s", tc.id, tc.provider)
			continue
		}
		t.Logf("%s: provider=%s context=%v", tc.id, entry.ProviderID, entry.Meta["contextLimit"])
	}
}

func TestRefreshModelCatalogConcurrent(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	fixture := &catalogFixture{context: 200000, fail: map[string]bool{}}
	d.HTTPClient = fixture.client(t)
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up"})
	if err != nil {
		t.Fatal(err)
	}
	seedCatalogModel(t, d, "tenant", up.ID, "model", "sample-1", "chat", `{}`)
	h := &handler{deps: d, store: store}
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if _, err := h.refreshCatalogMetadata(context.Background(), "tenant"); err != nil {
				t.Errorf("concurrent refresh: %v", err)
			}
		})
	}
	wg.Wait()
	if result, err := h.refreshCatalogMetadata(context.Background(), "tenant"); err != nil || result.Updated != 0 {
		t.Fatalf("concurrent refresh advanced inconsistent snapshots: %+v %v", result, err)
	}
}

func TestRefreshModelCatalogPreservesEditsDuringFetch(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	fixture := &catalogFixture{context: 200000, fail: map[string]bool{}}
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Up"})
	if err != nil {
		t.Fatal(err)
	}
	seedCatalogModel(t, d, "tenant", up.ID, "model", "sample-1", "chat", `{}`)
	started, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	transport := fixture.client(t).Transport
	d.HTTPClient = &http.Client{Transport: catalogTestTransport(func(req *http.Request) (*http.Response, error) {
		once.Do(func() {
			close(started)
			<-resume
		})
		return transport.RoundTrip(req)
	})}
	done := make(chan error, 1)
	go func() {
		_, err := (&handler{deps: d, store: store}).refreshCatalogMetadata(context.Background(), "tenant")
		done <- err
	}()
	<-started
	err = d.Gorm.Table("upstream_models").Where("id=?", "model").Update("meta_json", `{"contextLimit":64000,"custom":"edited"}`).Error
	close(resume)
	refreshErr := <-done
	if err != nil || refreshErr != nil {
		t.Fatalf("edit=%v refresh=%v", err, refreshErr)
	}
	meta := readCatalogModel(t, d, "model")
	if meta["contextLimit"] != float64(64000) || meta["custom"] != "edited" || meta["outputLimit"] != float64(16000) {
		t.Fatalf("concurrent manual edit lost: %v", meta)
	}
}

func TestModelCatalogSourceOverlayAndPrefixedIDs(t *testing.T) {
	base, err := parseModelCatalog("models.dev", []byte(`{"origin":{"api":"https://origin.example/v1","models":{"sample":{"limit":{"context":100000},"tool_call":true}}},"relay":{"api":"https://relay.example/v1","models":{"origin/sample":{"limit":{"context":80000}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	overlay, err := parseModelCatalog("llm-metadata", []byte(`{"origin":{"models":{"sample":{"reasoning_options":[{"type":"effort","values":["low","high"]}]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, entries := range [][]catalogEntry{append(append([]catalogEntry{}, base...), overlay...), append(append([]catalogEntry{}, overlay...), base...)} {
		index := newCatalogIndex(entries)
		entry := index.match("sample", "", "chat", "")
		if entry == nil || entry.Meta["contextLimit"] != float64(100000) || entry.Meta["toolCall"] != true || len(catalogStrings(entry.Meta["reasoningLevels"])) != 2 {
			t.Fatalf("source overlay lost fields: %v", entry)
		}
		entry = index.match("origin/sample", "", "chat", "https://relay.example/v1")
		if entry == nil || entry.ProviderID != "relay" || entry.Meta["contextLimit"] != float64(80000) {
			t.Fatalf("provider prefix overrode exact deployment ID: %v", entry)
		}
	}
}

func TestModelCatalogManualMerge(t *testing.T) {
	previous := catalogMetaJSON(`{"contextLimit":200000,"reasoning":true,"toolCall":false,"cost":{"input":1,"output":2},"description":"obsolete"}`)
	current := catalogMetaJSON(`{"contextLimit":64000,"reasoning":true,"toolCall":false,"cost":{"input":0,"output":2},"description":"obsolete","manual":"keep"}`)
	next := catalogMetaJSON(`{"contextLimit":300000,"reasoning":false,"toolCall":true,"cost":{"input":3,"output":4}}`)
	merged := mergeCatalogMeta(current, previous, next, true)
	if merged["contextLimit"] != float64(64000) || merged["reasoning"] != false || merged["toolCall"] != true || merged["manual"] != "keep" || merged["description"] != nil || gwMap(merged["cost"])["input"] != float64(0) || gwMap(merged["cost"])["output"] != float64(4) {
		t.Fatalf("merge: %v", merged)
	}
	initial := mergeCatalogMeta(current, nil, next, true)
	if !reflect.DeepEqual(initial, current) {
		t.Fatalf("initial manual fields overwritten: %v", initial)
	}
}
