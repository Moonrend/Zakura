//go:build tools

// Command gormgen regenerates GORM models for internal/platform/db/models from a
// live SQLite database.
//
// Run from the apps/server module root against a read-only copy of a migrated
// database:
//
//	CGO_ENABLED=1 go run -tags tools ./tools/gormgen -database 'file:data/zakura.db?mode=ro'
//
// The source database is opened read-only and is never modified. gorm.io/gen is
// only imported by this tools-tagged file, so it is excluded from every normal
// build.
//
// Only models are emitted because no ApplyBasic/ApplyInterface call installs
// query builders; gorm.io/gen therefore produces no gen.go query package.
//
// The generated output is reviewed and hand-corrected before commit:
//   - 0/1 flag columns (enabled, is_*, enable_*, allow_*, require_*, builtin,
//     auto_update, partial, always_allow, has_workspace, source_retained,
//     cancel_requested, onboarding_completed, setup_completed, ...) are retyped
//     from int32 to bool; nullable last_test_ok becomes *bool.
//   - api_keys.scopes and oauth_clients.response_types_json lose their
//     default:'[...]' tag because embedded double quotes make the struct tag
//     invalid.
//   - gofmt -w internal/platform/db/models afterwards.
//
// Post-generation checklist (naming strategy is NoLowerCase, so GORM does NOT
// snake_case field names — an untagged scan field silently reads the zero
// value):
//   - run CGO_ENABLED=1 go run -tags tools ./tools/scanlint — every struct
//     scanned via gorm Take/First/Find/Scan/ScanRows/Pluck/Last must carry an
//     explicit `gorm:"column:..."` tag on each mapped field;
//   - when hand-writing new scan structs or converting database/sql scans,
//     the same rule applies: alias aggregate SELECT columns (SUM(x) AS x).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"gorm.io/driver/sqlite"
	"gorm.io/gen"
	"gorm.io/gorm"
)

func main() {
	databaseURL := flag.String("database", "file:data/zakura.db?mode=ro", "read-only SQLite database used as the model source")
	outPath := flag.String("out", "internal/platform/db/models", "directory for generated models")
	flag.Parse()

	db, err := gorm.Open(sqlite.Open(*databaseURL), &gorm.Config{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "open source database:", err)
		os.Exit(1)
	}

	g := gen.NewGenerator(gen.Config{
		OutPath:          *outPath,
		ModelPkgPath:     filepath.Base(filepath.Clean(*outPath)),
		FieldWithTypeTag: true,
		FieldNullable:    true,
		Mode:             gen.WithoutContext,
	})
	g.UseDB(db)
	g.GenerateAllTable()
	g.Execute()
}
