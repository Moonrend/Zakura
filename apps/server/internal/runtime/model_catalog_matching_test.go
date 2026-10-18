// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

func TestModelCatalogMatchesOriginalProviderBehindResellers(t *testing.T) {
	entries, err := parseModelCatalog("models.dev", []byte(`{
		"origin":{"models":{"model-4-5":{"limit":{"context":200000},"canonical_model_id":"origin/model-4-5"}}},
		"relay-a":{"models":{"origin/model-4-5":{"limit":{"context":100000},"canonical_model_id":"origin/model-4-5"}}},
		"relay-b":{"models":{"origin/model-4-5":{"limit":{"context":120000},"canonical_model_id":"origin/model-4-5"}}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	index := newCatalogIndex(entries)
	for _, id := range []string{"origin/model-4-5", "model-4.5", "origin/model-4.5"} {
		entry := index.match(id, id, "chat", "https://custom-relay.example/v1")
		if entry == nil || entry.ProviderID != "origin" || gwInt(entry.Meta["contextLimit"]) != 200000 {
			t.Errorf("%s did not resolve to original provider: %+v", id, entry)
		}
	}
}

func TestModelCatalogMatchesCanonicalIdentityAcrossProviders(t *testing.T) {
	entries, err := parseModelCatalog("models.dev", []byte(`{
		"origin":{"models":{"model-5":{"limit":{"context":200000},"tool_call":true}}},
		"regional":{"models":{"model-5":{"limit":{"context":200000},"canonical_model_id":"origin/model-5"}}},
		"relay":{"models":{"creator/open-120b":{"limit":{"context":131072},"canonical_model_id":"creator/open-120b"}}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	index := newCatalogIndex(entries)
	entry := index.match("model-5", "model-5", "chat", "")
	if entry == nil || entry.ProviderID != "origin" {
		t.Fatalf("original and regional listings considered ambiguous: %+v", entry)
	}
	entry = index.match("open-120b", "open-120b", "chat", "")
	if entry == nil || entry.ModelID != "creator/open-120b" {
		t.Fatalf("canonical bare ID not indexed: %+v", entry)
	}
}

func TestModelCatalogMetadataDoesNotRequireCorrectDeploymentCapability(t *testing.T) {
	entries, err := parseModelCatalog("llm-metadata", []byte(`{"origin":{"models":{
		"text-embedding-small":{"limit":{"context":8192}},
		"image-model":{"modalities":{"output":["image"]},"limit":{"context":0}}
	}}}`))
	if err != nil {
		t.Fatal(err)
	}
	index := newCatalogIndex(entries)
	for _, id := range []string{"text-embedding-small", "image-model"} {
		if entry := index.match(id, id, "chat", ""); entry == nil {
			t.Errorf("metadata discarded because discovery defaulted %s to chat", id)
		}
	}
	if entry := index.match("image-model", "", "evaluation", ""); entry != nil {
		t.Fatal("evaluation model matched public catalog")
	}
}

func TestRefreshModelCatalogRepairsPreviousProviderMatch(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: "Custom relay"})
	if err != nil {
		t.Fatal(err)
	}
	payload := `{"origin":{"models":{"model-4-5":{"limit":{"context":200000},"canonical_model_id":"origin/model-4-5"}}},"relay":{"models":{"model-4.5":{"limit":{"context":100000},"canonical_model_id":"origin/model-4-5"}}}}`
	entries, err := parseModelCatalog("models.dev", []byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		id, now := d.NewID(), runtimeTimeString(d.Clock())
		raw, _ := json.Marshal(entry.Meta)
		if err := d.Gorm.Create(&models.ModelCatalogEntry{ID: &id, TenantID: "tenant", Source: entry.Source, ProviderID: entry.ProviderID, ProviderName: entry.ProviderName, ModelID: entry.ModelID, Name: entry.ModelID, MetaJSON: string(raw), CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
		if entry.ProviderID == "relay" {
			seedCatalogModel(t, d, "tenant", up.ID, "automatic", "model-4.5", "chat", string(raw))
			entry.Meta["contextLimit"] = float64(64000)
			raw, _ = json.Marshal(entry.Meta)
			seedCatalogModel(t, d, "tenant", up.ID, "manual", "model-4-5", "chat", string(raw))
		}
	}
	d.HTTPClient = &http.Client{Transport: catalogTestTransport(func(*http.Request) (*http.Response, error) {
		return catalogTestResponse(200, payload), nil
	})}
	result, err := (&handler{deps: d, store: store}).refreshCatalogMetadata(context.Background(), "tenant")
	if err != nil || result.Updated != 2 {
		t.Fatalf("repair: %+v %v", result, err)
	}
	if meta := readCatalogModel(t, d, "automatic"); meta["contextLimit"] != float64(200000) || meta["providerId"] != "origin" {
		t.Fatalf("old generated value treated as manual: %v", meta)
	}
	if meta := readCatalogModel(t, d, "manual"); meta["contextLimit"] != float64(64000) {
		t.Fatalf("manual override lost: %v", meta)
	}
}

func TestModelCatalogIdenticalRegionalAndRouterAliases(t *testing.T) {
	for _, id := range []string{"model-5", "~origin/model-latest"} {
		payload := `{"regional-a":{"models":{"` + id + `":{"limit":{"context":200000,"output":8000},"reasoning":true,"modalities":{"output":["text"]}}}},"regional-b":{"models":{"` + id + `":{"limit":{"context":200000,"output":8000},"reasoning":true,"modalities":{"output":["text"]}}}}}`
		entries, err := parseModelCatalog("llm-metadata", []byte(payload))
		if err != nil {
			t.Fatal(err)
		}
		entry := newCatalogIndex(entries).match(id, "", "chat", "")
		if entry == nil || gwInt(entry.Meta["contextLimit"]) != 200000 {
			t.Fatalf("identical regional metadata discarded for %s: %+v", id, entry)
		}
		entries[1].Meta["contextLimit"] = float64(100000)
		if entry := newCatalogIndex(entries).match(id, "", "chat", ""); entry != nil {
			t.Fatalf("conflicting unlinked models merged: %+v", entry)
		}
	}
}

func TestModelCatalogConsensusDoesNotChooseConflictingDeploymentLimits(t *testing.T) {
	entries, err := parseModelCatalog("models.dev", []byte(`{
		"a":{"models":{"sample":{"limit":{"context":128000,"output":16000},"canonical_model_id":"origin/sample","cost":{"input":1}}}},
		"b":{"models":{"sample":{"limit":{"context":200000,"output":16000},"canonical_model_id":"origin/sample","cost":{"input":2}}}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	entry := newCatalogIndex(entries).match("sample", "", "chat", "")
	if entry == nil || gwInt(entry.Meta["outputLimit"]) != 16000 {
		t.Fatalf("consistent metadata of the same model discarded: %+v", entry)
	}
	if _, exists := entry.Meta["contextLimit"]; exists {
		t.Fatalf("conflicting context limit invented: %+v", entry.Meta)
	}
	if _, exists := entry.Meta["cost"]; exists {
		t.Fatalf("reseller-specific price selected: %+v", entry.Meta)
	}
}
