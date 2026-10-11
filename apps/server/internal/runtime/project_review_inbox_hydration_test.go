// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func hydrateOperationReviewAgain(t *testing.T, f *reviewFixture, p reviewFixtureProject, item *projectReviewItem) {
	t.Helper()
	request := httptest.NewRequest("GET", "/api/project-reviews/", nil)
	request = request.WithContext(httpx.WithPrincipal(request.Context(), reviewPrincipal(p.tenant, "owner")))
	tx, err := f.d.DB.BeginTx(request.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = f.h.hydrateReview(request.Context(), tx, request, item, f.now); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestProjectReviewInboxOperationHydrationReplacesPreviousArguments(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-hydration", "review-hydration-project", "Repeated review hydration")
	f.add(p, "operation", "review-hydration-op", "pending_approval", reviewStamp(f.now.Add(-time.Hour)))
	page := f.list("", reviewPrincipal(p.tenant, "owner"))
	if len(page.Items) != 1 {
		t.Fatalf("operation fixture: %+v", page)
	}
	item := page.Items[0]
	want := []string{"destination", "token"}
	for i := 0; i < 3; i++ {
		hydrateOperationReviewAgain(t, f, p, &item)
		if !reflect.DeepEqual(item.ArgumentFields, want) {
			t.Fatalf("repeat %d accumulated old fields: %v", i, item.ArgumentFields)
		}
	}

	// Reuse the same hydrated item after the persisted argument shape changes.
	// Fields from the previous read must disappear, including when the new
	// payload has no object-shaped arguments at all.
	f.exec(`UPDATE execution_operations SET operation_json=? WHERE id=?`, `{"call":{"name":"publish_artifact","effect":"external_write","arguments":{"replacement":"TOP_SECRET_REPLACEMENT"}}}`, item.ID)
	hydrateOperationReviewAgain(t, f, p, &item)
	if !reflect.DeepEqual(item.ArgumentFields, []string{"replacement"}) {
		t.Fatalf("changed arguments retained old names: %v", item.ArgumentFields)
	}
	for _, payload := range []string{
		`{"call":{"arguments":null}}`,
		`{"call":{"arguments":"TOP_SECRET_SCALAR"}}`,
		`{"call":{"arguments":["TOP_SECRET_ARRAY"]}}`,
		`{"call":{"name":"publish_artifact"}}`,
	} {
		item.ArgumentFields = []string{"stale-field"}
		f.exec(`UPDATE execution_operations SET operation_json=? WHERE id=?`, payload, item.ID)
		hydrateOperationReviewAgain(t, f, p, &item)
		if len(item.ArgumentFields) != 0 {
			t.Fatalf("non-object arguments retained stale fields: %v", item.ArgumentFields)
		}
	}
}

func TestProjectReviewInboxRepeatedHydrationKeepsArgumentsBoundedAndPrivate(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-hydration-private", "review-hydration-private-project", "Private operation")
	f.add(p, "operation", "review-hydration-private-op", "unknown", reviewStamp(f.now.Add(-time.Hour)))
	arguments := map[string]any{
		"0 TOP_SECRET_KEY https://private.example/token": "TOP_SECRET_KEY_VALUE",
	}
	for i := 0; i < 40; i++ {
		arguments[fmt.Sprintf("field%02d", i)] = map[string]any{"value": strings.Repeat("TOP_SECRET_ARGUMENT", 100)}
	}
	raw, err := json.Marshal(map[string]any{
		"error": "HTTP status 403 TOP_SECRET_ERROR",
		"call":  map[string]any{"name": "publish_artifact", "effect": "external_write", "arguments": arguments},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE execution_operations SET operation_json=? WHERE id=?`, string(raw), "review-hydration-private-op")
	page := f.list("", reviewPrincipal(p.tenant, "owner"))
	if len(page.Items) != 1 {
		t.Fatalf("private operation fixture: %+v", page)
	}
	item := page.Items[0]
	for i := 0; i < 5; i++ {
		hydrateOperationReviewAgain(t, f, p, &item)
		if len(item.ArgumentFields) != 12 {
			t.Fatalf("repeat %d escaped the 12-field bound: %v", i, item.ArgumentFields)
		}
		if !item.HasError || item.ErrorCategory != "http_403" {
			t.Fatalf("error classification changed: %+v", item)
		}
		if !containsReviewArgumentPlaceholder(item.ArgumentFields) {
			t.Fatal("unsafe argument name was not replaced")
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "TOP_SECRET") || strings.Contains(string(encoded), "private.example") {
			t.Fatalf("hydrated review leaked arguments or raw error: %s", encoded)
		}
	}
}

func containsReviewArgumentPlaceholder(fields []string) bool {
	for _, field := range fields {
		if field == "[自定义参数名]" {
			return true
		}
	}
	return false
}
