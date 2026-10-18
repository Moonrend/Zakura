// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Opt-in read-only diagnosis against a local Docker PostgreSQL database.
// Only model metadata is selected; no keys or upstream configuration is read.
func TestModelCatalogLocalInventory(t *testing.T) {
	container, database := os.Getenv("ZAKURA_TEST_CATALOG_CONTAINER"), os.Getenv("ZAKURA_TEST_CATALOG_DATABASE")
	if container == "" || database == "" {
		t.Skip("local inventory check is opt-in")
	}
	user, err := exec.Command("docker", "exec", container, "printenv", "POSTGRES_USER").Output()
	if err != nil {
		t.Fatal(err)
	}
	query := `SELECT json_build_object(
		'catalog', (SELECT json_agg(json_build_object('source',source,'provider',provider_id,'providerName',provider_name,'model',model_id,'meta',meta_json::json)) FROM model_catalog_entries),
		'inventory', (SELECT json_agg(json_build_object('native',native_model,'canonical',canonical_model,'capability',capability,'meta',meta_json::json)) FROM upstream_models)
	)`
	raw, err := exec.Command("docker", "exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", container, "psql", "-U", strings.TrimSpace(string(user)), "-d", database, "-Atc", query).Output()
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Catalog []struct {
			Source, Provider, ProviderName, Model string
			Meta                                  map[string]any
		}
		Inventory []struct {
			Native, Canonical, Capability string
			Meta                          map[string]any
		}
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	entries := make([]catalogEntry, 0, len(snapshot.Catalog))
	for _, row := range snapshot.Catalog {
		entries = append(entries, catalogEntry{row.Source, row.Provider, row.ProviderName, row.Model, row.Meta})
	}
	index := newCatalogIndex(entries)
	matched, recovered, previouslyFilled := 0, 0, 0
	for _, row := range snapshot.Inventory {
		if len(row.Meta) > 0 {
			previouslyFilled++
		}
		entry, reason := index.resolve(row.Native, row.Canonical, row.Capability, "")
		if entry == nil {
			t.Logf("unmatched %s: %s", row.Native, reason)
			continue
		}
		matched++
		if len(row.Meta) == 0 {
			recovered++
			t.Logf("recovered %s -> %s/%s context=%v", row.Native, entry.ProviderID, entry.ModelID, entry.Meta["contextLimit"])
		}
	}
	t.Logf("inventory=%d previouslyFilled=%d matched=%d recovered=%d unmatched=%d", len(snapshot.Inventory), previouslyFilled, matched, recovered, len(snapshot.Inventory)-matched)
}
