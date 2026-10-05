package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	platformdb "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/db"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	switch os.Args[1] {
	case "backup":
		fs := flag.NewFlagSet("backup", flag.ExitOnError)
		databaseURL := fs.String("database", os.Getenv("DATABASE_URL"), "SQLite DATABASE_URL")
		out := fs.String("out", "", "new backup file")
		_ = fs.Parse(os.Args[2:])
		if *databaseURL == "" || *out == "" {
			fs.Usage()
			os.Exit(2)
		}
		conn, err := platformdb.Open(ctx, *databaseURL)
		fatalIf(err)
		defer conn.DB.Close()
		if conn.Dialect != "sqlite" {
			fatalIf(fmt.Errorf("PostgreSQL backup requires pg_dump; see docs/OPERATIONS.md"))
		}
		fatalIf(platformdb.BackupSQLite(ctx, conn.DB, *out))
		fmt.Println(*out)
	case "verify":
		fs := flag.NewFlagSet("verify", flag.ExitOnError)
		file := fs.String("file", "", "SQLite backup file")
		_ = fs.Parse(os.Args[2:])
		if *file == "" {
			fs.Usage()
			os.Exit(2)
		}
		fatalIf(platformdb.VerifySQLite(ctx, *file))
		fmt.Println("ok")
	case "restore":
		fs := flag.NewFlagSet("restore", flag.ExitOnError)
		databaseURL := fs.String("database", os.Getenv("DATABASE_URL"), "offline SQLite DATABASE_URL")
		from := fs.String("from", "", "verified backup file")
		_ = fs.Parse(os.Args[2:])
		if *databaseURL == "" || *from == "" {
			fs.Usage()
			os.Exit(2)
		}
		target, err := platformdb.SQLiteFilePath(*databaseURL)
		fatalIf(err)
		previous, err := platformdb.RestoreSQLite(ctx, *from, target)
		fatalIf(err)
		fmt.Printf("restored %s; previous database: %s\n", target, previous)
	default:
		usage()
	}
}

func fatalIf(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: zakura-db <backup|verify|restore> [flags]")
	os.Exit(2)
}
