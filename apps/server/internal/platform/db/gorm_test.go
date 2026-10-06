package db_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
)

func TestGormSharesSQLiteConnectionPool(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.Open(ctx, "file:"+filepath.Join(t.TempDir(), "shared.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	pool, ok := gdb.ConnPool.(*sql.DB)
	if !ok || pool != conn.DB {
		t.Fatalf("gorm does not share the database/sql pool: %T", gdb.ConnPool)
	}

	var raw int
	if err = conn.DB.QueryRowContext(ctx, `SELECT 1`).Scan(&raw); err != nil || raw != 1 {
		t.Fatalf("database/sql SELECT 1: value=%d err=%v", raw, err)
	}
	var viaGorm int
	if err = gdb.Raw(`SELECT 1`).Scan(&viaGorm).Error; err != nil || viaGorm != 1 {
		t.Fatalf("gorm SELECT 1: value=%d err=%v", viaGorm, err)
	}

	if _, err = conn.DB.ExecContext(ctx, `CREATE TEMP TABLE shared_probe(value TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.DB.ExecContext(ctx, `INSERT INTO shared_probe(value) VALUES('raw')`); err != nil {
		t.Fatal(err)
	}
	if err = gdb.Exec(`INSERT INTO shared_probe(value) VALUES('gorm')`).Error; err != nil {
		t.Fatal(err)
	}
	var count int
	if err = gdb.Raw(`SELECT COUNT(*) FROM shared_probe`).Scan(&count).Error; err != nil || count != 2 {
		t.Fatalf("shared temp table count=%d err=%v", count, err)
	}
}

func TestGormGeneratedModelsSmoke(t *testing.T) {
	ctx := context.Background()
	conn, err := platformdb.OpenGorm(ctx, "file:"+filepath.Join(t.TempDir(), "models.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.DB.Close()
	if err := migrations.Apply(ctx, conn.DB, conn.Dialect, conn.Rebind); err != nil {
		t.Fatal(err)
	}
	gdb, err := conn.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	now := "2026-10-05T00:00:00Z"
	for _, statement := range []string{
		`INSERT INTO platform_meta(singleton,setup_completed,version,mode,settings_json,created_at,updated_at) VALUES(1,1,'go-rewrite','local','{}','` + now + `','` + now + `')`,
		`INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,created_at,updated_at) VALUES('tenant-1','tenant-1','Tenant One',1,0,'{}','` + now + `','` + now + `')`,
		`INSERT INTO users(id,email,is_platform_admin,can_use_local_runner,recovery_codes_json,status,created_at,updated_at) VALUES('user-1','user@example.test',1,0,'[]','active','` + now + `','` + now + `')`,
	} {
		if err = gdb.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}

	var meta models.PlatformMetum
	if err = gdb.First(&meta, "singleton = ?", 1).Error; err != nil {
		t.Fatal(err)
	}
	if !meta.SetupCompleted {
		t.Fatalf("setup_completed scanned as %v", meta.SetupCompleted)
	}
	var tenant models.Tenant
	if err = gdb.First(&tenant, "id = ?", "tenant-1").Error; err != nil {
		t.Fatal(err)
	}
	if !tenant.IsDefault || tenant.OnboardingCompleted {
		t.Fatalf("tenant flags scanned as is_default=%v onboarding_completed=%v", tenant.IsDefault, tenant.OnboardingCompleted)
	}
	var users []models.User
	if err = gdb.Where("email = ?", "user@example.test").Find(&users).Error; err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || !users[0].IsPlatformAdmin || users[0].CanUseLocalRunner {
		t.Fatalf("user scan rows=%d flags=%v/%v", len(users), users[0].IsPlatformAdmin, users[0].CanUseLocalRunner)
	}
}
