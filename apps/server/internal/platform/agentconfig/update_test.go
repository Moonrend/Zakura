package agentconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func testConfigDB(t *testing.T, initial string) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "config.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.Exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, config_json TEXT NOT NULL, updated_at TEXT, enable_memory BOOLEAN)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO agents (id,tenant_id,config_json,enable_memory) VALUES ('agent','tenant',?,true)`, initial).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func TestUpdateRetriesAgainstFreshConfig(t *testing.T) {
	db := testConfigDB(t, `{"executionMode":"host","cloud":{"model":"before"},"large":9007199254740993}`)
	checkUpdateRetriesAgainstFreshConfig(t, db)
}

func checkUpdateRetriesAgainstFreshConfig(t *testing.T, db *gorm.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db = db.WithContext(ctx)
	calls := 0
	changed, err := Update(ctx, db, "tenant", "agent", "now", map[string]any{"enable_memory": false}, func(config map[string]any) error {
		calls++
		if calls == 1 {
			if err := db.Exec(`UPDATE agents SET config_json=? WHERE id='agent'`, `{"executionMode":"sandbox","cloud":{"model":"newer","keep":true},"large":9007199254740993}`).Error; err != nil {
				return err
			}
		}
		config["cloud"].(map[string]any)["systemPrompt"] = "hello"
		return nil
	})
	if err != nil || !changed || calls != 2 {
		t.Fatalf("changed=%v calls=%d err=%v", changed, calls, err)
	}
	var row struct {
		Config string `gorm:"column:config_json"`
		Memory bool   `gorm:"column:enable_memory"`
	}
	if err := db.Table("agents").Take(&row).Error; err != nil {
		t.Fatal(err)
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal([]byte(row.Config), &config); err != nil {
		t.Fatal(err)
	}
	if string(config["executionMode"]) != `"sandbox"` || string(config["large"]) != "9007199254740993" || row.Memory {
		t.Fatalf("unrelated fields lost: %+v", row)
	}
	var cloud map[string]any
	_ = json.Unmarshal(config["cloud"], &cloud)
	if cloud["model"] != "newer" || cloud["keep"] != true || cloud["systemPrompt"] != "hello" {
		t.Fatalf("stale cloud fields: %#v", cloud)
	}
	// Intentional full replacement remains supported in either policy direction.
	for _, mode := range []string{"host", "sandbox"} {
		explicit, _ := json.Marshal(map[string]any{"executionMode": mode})
		if err := db.Exec(`UPDATE agents SET config_json=? WHERE tenant_id='tenant' AND id='agent'`, string(explicit)).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := Update(ctx, db, "tenant", "agent", "later", nil, func(config map[string]any) error {
			config["cloud"] = map[string]any{"model": "requested"}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := db.Table("agents").Take(&row).Error; err != nil {
			t.Fatal(err)
		}
		var saved map[string]any
		if err := json.Unmarshal([]byte(row.Config), &saved); err != nil {
			t.Fatal(err)
		}
		if saved["executionMode"] != mode || saved["cloud"].(map[string]any)["model"] != "requested" {
			t.Fatalf("explicit policy change lost: %s", row.Config)
		}
	}
}

func TestUpdateBoundsContentionAndPreservesLatestConfig(t *testing.T) {
	db := testConfigDB(t, `{"executionMode":"sandbox"}`)
	calls := 0
	changed, err := Update(context.Background(), db, "tenant", "agent", "now", nil, func(config map[string]any) error {
		calls++
		config["cloud"] = map[string]any{"model": "requested"}
		return db.Exec(`UPDATE agents SET config_json=? WHERE id='agent'`, fmt.Sprintf(`{"executionMode":"sandbox","revision":%d}`, calls)).Error
	})
	if changed || !errors.Is(err, ErrConflict) || calls != maxUpdateAttempts {
		t.Fatalf("changed=%v calls=%d err=%v", changed, calls, err)
	}
	var stored string
	if err := db.Raw(`SELECT config_json FROM agents WHERE id='agent'`).Scan(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored != fmt.Sprintf(`{"executionMode":"sandbox","revision":%d}`, calls) {
		t.Fatalf("conflict overwrote latest config: %s", stored)
	}
}

func TestUpdateRejectsInvalidConfigAndWrongTenant(t *testing.T) {
	for _, initial := range []string{`null`, `[]`, `"text"`, `{"executionMode":`} {
		t.Run(initial, func(t *testing.T) {
			db := testConfigDB(t, initial)
			called := false
			_, err := Update(context.Background(), db, "tenant", "agent", "now", nil, func(map[string]any) error {
				called = true
				return nil
			})
			if err == nil || called {
				t.Fatalf("invalid config reached mutation: called=%v err=%v", called, err)
			}
		})
	}
	db := testConfigDB(t, `{"executionMode":"sandbox"}`)
	_, err := Update(context.Background(), db, "other-tenant", "agent", "now", nil, func(map[string]any) error {
		t.Fatal("wrong tenant reached mutation")
		return nil
	})
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("wrong-tenant result: %v", err)
	}
}
