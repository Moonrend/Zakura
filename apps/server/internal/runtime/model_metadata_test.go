// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"gorm.io/gorm"
)

func TestGatewayModelsLargeInventoryUsesBatchQueries(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	ctx := context.Background()
	up, err := store.CreateUpstream(ctx, "tenant", Upstream{Name: "Up", Protocol: "openai"})
	if err != nil {
		t.Fatal(err)
	}
	const count = 1200
	now := runtimeTimeString(d.Clock())
	err = d.Gorm.Transaction(func(tx *gorm.DB) error {
		for i := range count {
			id := fmt.Sprintf("model-%04d", i)
			if err := tx.Exec(`INSERT INTO model_routes(id,tenant_id,name,slug,capability,alias,upstream_id,model,options_json,priority,weight,is_default,status,created_at,updated_at) VALUES(?,'tenant',?,?,'chat',?,?,?,'{}','100','100',FALSE,'ready',?,?)`, id, id, id, id, up.ID, id, now, now).Error; err != nil {
				return err
			}
			if i == 1 {
				continue // Missing metadata must not remove the route.
			}
			meta := `{"contextWindow":200000,"max_output_tokens":16000,"reasoning":false,"attachment":true,"toolCall":false}`
			if i == 2 {
				meta = `{"contextWindow":"unknown","reasoning":"unknown"}`
			}
			if err := tx.Exec(`INSERT INTO upstream_models(id,tenant_id,upstream_id,native_model,canonical_model,capability,weight,is_default,options_json,meta_json,status,created_at,updated_at) VALUES(?,'tenant',?,?,?,'chat','100',FALSE,'{}',?,'ready',?,?)`, id, up.ID, id, id, meta, now, now).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	queries := 0
	callback := "test:count_model_queries"
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
	models, _, err := (&handler{deps: d, store: store}).acpGatewayModels(ctx, "tenant")
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != count || queries != 3 {
		t.Fatalf("models=%d queries=%d, want %d models in 3 queries", len(models), queries, count)
	}
	if models[0].ContextLimit != 200000 || models[0].OutputLimit != 16000 || models[0].Reasoning == nil || *models[0].Reasoning || models[0].Attachment == nil || !*models[0].Attachment || models[0].ToolCall == nil || *models[0].ToolCall {
		t.Fatalf("metadata lost: %+v", models[0])
	}
	if models[1].ContextLimit != 0 || models[2].ContextLimit != 0 {
		t.Fatal("missing or malformed metadata was not isolated")
	}
}

func TestACPOpenCodeLargeInventoryUsesManagedFile(t *testing.T) {
	const count = 2500
	models := make([]acpGatewayModel, count)
	for i := range models {
		models[i] = acpGatewayModel{ID: fmt.Sprintf("model-%04d", i)}
	}
	setup := acpSetup{ID: "opencode", SetupMode: "api_key", ModelProvider: "zakura", Managed: map[string]string{"zakura_api_key": "test-key", "zakura_base_url": "https://example.invalid/v1", "model": "missing-selected"}}
	fixture := newACPHomeFixture()
	fs := acpHomeTestFS(fixture, "opencode")
	files, env := acpRuntimeFiles(fs.home, setup, models, "missing-preferred")
	configPath := fs.home + "/.config/opencode/zakura.json"
	if env["OPENCODE_CONFIG"] != configPath || env["OPENCODE_CONFIG_CONTENT"] != "" {
		t.Fatal("model inventory is still passed as a large environment variable")
	}
	if err := fs.reconcile(context.Background(), setup, files); err != nil {
		t.Fatal(err)
	}
	content := fixture.files[strings.TrimPrefix(configPath, "/workspace")]
	if len(content) < 128<<10 {
		t.Fatal("test inventory does not exceed Linux's single environment string limit")
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(content), &config); err != nil {
		t.Fatal(err)
	}
	entries := gwMap(gwMap(gwMap(config["provider"])["zakura"])["models"])
	if len(entries) != count+2 || config["model"] != "zakura/missing-selected" {
		t.Fatalf("configuration lost models: count=%d selected=%v", len(entries), config["model"])
	}
	for id, value := range entries {
		limits := gwMap(gwMap(value)["limit"])
		if gwInt(limits["context"]) <= 0 || gwInt(limits["output"]) <= 0 {
			t.Fatalf("missing fallback limits for %s", id)
		}
	}
	setup.SetupMode, setup.ModelProvider = "oauth", "native"
	files, _ = acpRuntimeFiles(fs.home, setup, nil, "")
	if err := fs.reconcile(context.Background(), setup, files); err != nil {
		t.Fatal(err)
	}
	if _, exists := fixture.files[strings.TrimPrefix(configPath, "/workspace")]; exists {
		t.Fatal("generated gateway configuration survived native OAuth switch")
	}
}

func TestGatewayModelMetadataIgnoresMalformedOptionalData(t *testing.T) {
	metadata := gatewayModelMetadata(ModelRoute{Options: json.RawMessage(`{"contextLimit":64000,"toolCall":false}`)}, `{invalid`, `{"attachment":true,"limit":{"output":8000}}`)
	if gwInt(metadata["contextLimit"]) != 64000 || gwInt(metadata["outputLimit"]) != 8000 || metadata["toolCall"] != false || metadata["attachment"] != true {
		t.Fatalf("valid metadata lost: %v", metadata)
	}
	malformed := gatewayModelMetadata(ModelRoute{}, `{"reasoning":"unknown","attachment":{},"toolCall":1,"name":[],"contextLimit":"unknown","outputLimit":-1}`)
	if len(malformed) != 0 {
		t.Fatalf("malformed fields escaped into gateway inventory: %v", malformed)
	}
}
