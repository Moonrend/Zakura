// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	_ "github.com/lib/pq"
)

func TestProjectReviewInboxPostgresSnapshotAndCompactArguments(t *testing.T) {
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; real PostgreSQL review snapshot was not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err = admin.PingContext(ctx); err != nil {
		t.Fatal("PostgreSQL review integration connection failed")
	}
	nonce := make([]byte, 12)
	if _, err = rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	schema := "zakura_review_" + hex.EncodeToString(nonce)
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Error("drop review test schema:", err)
		}
	}()
	isolated := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
		isolated = u.String()
	} else {
		isolated += " search_path='" + schema + "'"
	}
	db, err := sql.Open("postgres", isolated)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)
	if err = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); err != nil {
		t.Fatal(err)
	}
	var ids atomic.Int64
	d := &appdeps.Dependencies{DB: db, Dialect: "postgres", Rebind: appdeps.PostgresRebind, NewID: func() string { return fmt.Sprintf("review-pg-%d", ids.Add(1)) }}
	f := newReviewFixture(t, d)
	p := f.project("pg-review", "pg-project", "Postgres snapshot")
	old := reviewStamp(f.now.Add(-time.Hour))
	f.add(p, "operation", "pg-op", "pending_approval", old)
	f.add(p, "source", "pg-source", "unknown", old)
	f.add(p, "baseline", "pg-baseline", "draft", old)
	owner := reviewPrincipal(p.tenant, "owner")
	page := f.list("limit=1&q="+url.QueryEscape("snapshot"), owner)
	if page.Total != 3 || len(page.Items) != 1 || len(page.Items[0].ArgumentFields) != 2 || page.Items[0].Kind != "operation" || page.NextCursor == "" {
		t.Fatalf("Postgres compact hydration: %+v", page)
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	filter := projectReviewFilter{SourceVisible: true}
	before, err := f.h.reviewSummary(ctx, tx, p.tenant, filter, reviewStamp(f.now))
	if err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE execution_operations SET status='completed',revision=3,operation_json='{"call":{"arguments":{"newField":"later value"}}}',updated_at=? WHERE id='pg-op'`, reviewStamp(f.now))
	f.exec(`UPDATE execution_source_attestations SET status='completed',updated_at=? WHERE id='pg-source'`, reviewStamp(f.now))
	after, err := f.h.reviewSummary(ctx, tx, p.tenant, filter, reviewStamp(f.now))
	if err != nil {
		t.Fatal(err)
	}
	if before.Total != 3 || after.Total != before.Total {
		t.Fatalf("summary escaped repeatable snapshot: before=%+v after=%+v", before, after)
	}
	request := httptest.NewRequest("GET", "/api/project-reviews/", nil)
	request = request.WithContext(httpx.WithPrincipal(request.Context(), owner))
	item := page.Items[0]
	if err = f.h.hydrateReview(ctx, tx, request, &item, f.now); err != nil || item.Status != "pending_approval" || len(item.ArgumentFields) != 2 {
		t.Fatalf("hydration escaped same snapshot: %+v %v", item, err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	fresh := f.list("", owner)
	if fresh.Total != 1 || fresh.Items[0].Kind != "baseline" {
		t.Fatalf("fresh read did not observe settled states: %+v", fresh)
	}
	if result := f.summary("", reviewPrincipal("foreign-tenant", "member")); result.Total != 0 {
		t.Fatal("Postgres review tenant isolation failed")
	}
}
