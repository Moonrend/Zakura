package projectknowledge

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/lib/pq"
)

func postgresKnowledgeFixture(t *testing.T) (*Store, mission.Scope) {
	t.Helper()
	dsn := os.Getenv("ZAKURA_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("ZAKURA_TEST_POSTGRES_DSN is absent; real PostgreSQL knowledge integration was not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err = admin.PingContext(ctx); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	id, err := newID()
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "zakura_knowledge_" + id
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	isolated := dsn
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, e := url.Parse(dsn)
		if e != nil {
			t.Fatal(e)
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
	db.SetMaxOpenConns(8)
	t.Cleanup(func() {
		db.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, e := admin.ExecContext(cleanup, `DROP SCHEMA "`+schema+`" CASCADE`); e != nil {
			t.Error(e)
		}
		admin.Close()
	})
	if err = migrations.Apply(ctx, db, "postgres", appdeps.PostgresRebind); err != nil {
		t.Fatal(err)
	}
	now := stamp(time.Now().UTC())
	for _, tenant := range []string{"tenant-a", "tenant-b"} {
		if _, err = db.ExecContext(ctx, appdeps.PostgresRebind(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`), tenant, tenant, tenant, now, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.ExecContext(ctx, appdeps.PostgresRebind(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES('space-a','tenant-a','Space','space',?,?)`), now, now); err != nil {
		t.Fatal(err)
	}
	exec := projectexec.NewStore(db, "postgres", appdeps.PostgresRebind)
	p, err := exec.CreateProject(ctx, mission.Project{ID: "project-a", TenantID: "tenant-a", SpaceID: "space-a", Name: "Knowledge", Goal: "Share durable references", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "build", Title: "Build", Prompt: "Build", AgentID: "agent", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Path: "result.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1}, MaxTasks: 100}})
	if err != nil {
		t.Fatal(err)
	}
	return NewStore(db, "postgres", appdeps.PostgresRebind), mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}
}

func TestKnowledgePostgresCASAndSearchMVCC(t *testing.T) {
	s, scope := postgresKnowledgeFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	entry, err := s.Create(ctx, scope, knowledge.Draft{Kind: "note", Title: "cache", Body: "cache", Tags: []string{"数据库"}}, "human")
	if err != nil {
		t.Fatal(err)
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.Update(ctx, scope, entry.ID, 1, knowledge.Draft{Kind: "note", Title: "cache", Body: "cache", Tags: []string{"数据库"}}, "race", "human")
			if e == nil {
				winners.Add(1)
			} else if !errors.Is(e, ErrConflict) {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("CAS winners %d", winners.Load())
	}
	entry, err = s.Get(ctx, scope, entry.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			next, e := s.Update(ctx, scope, entry.ID, entry.Revision, knowledge.Draft{Kind: "note", Title: "cache", Body: strings.Repeat("cache ", i%6+1), Tags: []string{"数据库"}}, "MVCC edit", "human")
			if e != nil {
				t.Error(e)
				return
			}
			entry = next
		}
	}()
	for i := 0; i < 50; i++ {
		result, e := s.Search(ctx, scope, knowledge.Query{Text: "cache", Filter: knowledge.Filter{Tags: []string{"数据库"}}, Limit: 1})
		if e != nil {
			t.Fatal(e)
		}
		if len(result.Items) != 1 || result.CorpusSize != 1 {
			t.Fatalf("corpus %+v", result)
		}
		hit := result.Items[0]
		frequency := 3 + float64(strings.Count(hit.Entry.Body, "cache"))
		want := math.Log(1+0.5/1.5) * (frequency * 2.2) / (frequency + 1.2)
		if math.Abs(hit.Score-want) > 1e-10 {
			t.Fatalf("metadata/posting revision drift: revision%d score%g want%g body%q", hit.Entry.Revision, hit.Score, want, hit.Entry.Body)
		}
	}
	wg.Wait()
	if _, err = s.Get(ctx, mission.Scope{TenantID: "tenant-b", SpaceID: "space-a", ProjectID: scope.ProjectID}, entry.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant leak %v", err)
	}
}
