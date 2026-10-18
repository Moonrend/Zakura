package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCreateReceiptNoSymlinkPaths(t *testing.T) {
	for _, target := range []string{"storage", "storage-ancestor", "receipts", "operation", "intent", "commit"} {
		t.Run(target, func(t *testing.T) {
			base, outside := t.TempDir(), t.TempDir()
			root := filepath.Join(base, "storage")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			spec, op := receiptFixture()
			intent, labeled, _ := prepareCreate(spec, op)
			var link, destination string
			switch target {
			case "storage":
				link, destination = filepath.Join(base, "alias"), root
				root = link
			case "storage-ancestor":
				link, destination = filepath.Join(base, "alias"), outside
				if err := os.Mkdir(filepath.Join(outside, "storage"), 0700); err != nil {
					t.Fatal(err)
				}
				root = filepath.Join(link, "storage")
			case "receipts":
				link, destination = filepath.Join(root, createReceiptDirectory), outside
			case "operation":
				if err := os.Mkdir(filepath.Join(root, createReceiptDirectory), 0700); err != nil {
					t.Fatal(err)
				}
				key := sha256.Sum256([]byte(op.ID))
				link, destination = filepath.Join(root, createReceiptDirectory, hex.EncodeToString(key[:])), outside
			case "intent", "commit":
				job, _, err := openCreateJob(root, op.ID, true)
				if err != nil {
					t.Fatal(err)
				}
				if target == "commit" {
					if err := saveCreateRecord(job, "intent.json", intent); err != nil {
						t.Fatal(err)
					}
				}
				jobPath := job.Name()
				job.Close()
				name := "intent.json"
				var value any = intent
				if target == "commit" {
					name, value = "committed.json", createCommit{intent, receiptInfo(labeled)}
				}
				file, err := os.Create(filepath.Join(outside, "record.json"))
				if err != nil {
					t.Fatal(err)
				}
				if err := json.NewEncoder(file).Encode(value); err != nil {
					t.Fatal(err)
				}
				file.Close()
				link, destination = filepath.Join(jobPath, name), filepath.Join(outside, "record.json")
			}
			if err := os.Symlink(destination, link); err != nil {
				if runtime.GOOS == "windows" {
					t.Skipf("symlinks unavailable without changing permissions: %v", err)
				}
				t.Fatal(err)
			}
			store := createReceipts{root: root,
				create: func(context.Context, RunSpec) (ContainerInfo, error) {
					t.Fatal("Docker called through symlink path")
					return ContainerInfo{}, nil
				},
				inspect: func(context.Context, string) (ContainerInfo, error) {
					t.Fatal("Docker inspected through symlink path")
					return ContainerInfo{}, nil
				},
			}
			if _, err := store.run(context.Background(), spec, op); !errors.Is(err, ErrCreateUnknown) {
				t.Fatalf("symlink path accepted: %v", err)
			}
			status, err := store.status(context.Background(), receiptStatusRequest(op))
			if status.State != "unknown" || status.Container != nil || (err != nil && !errors.Is(err, ErrCreateUnknown)) {
				t.Fatalf("symlink status: %+v %v", status, err)
			}
			if target != "intent" && target != "commit" {
				entries, err := os.ReadDir(outside)
				if err != nil {
					t.Fatal(err)
				}
				if target == "storage-ancestor" {
					entries, err = os.ReadDir(filepath.Join(outside, "storage"))
					if err != nil {
						t.Fatal(err)
					}
				}
				if len(entries) != 0 {
					t.Fatalf("receipt escaped root: %v", entries)
				}
			}
		})
	}
}

func TestCreateReceiptNonRegularRecordsAndImmutablePublish(t *testing.T) {
	spec, op := receiptFixture()
	root := t.TempDir()
	job, claimed, err := openCreateJob(root, op.ID, true)
	if err != nil || !claimed {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	defer job.Close()
	intent, _, _ := prepareCreate(spec, op)
	if err := saveCreateRecord(job, "intent.json", intent); err != nil {
		t.Fatal(err)
	}
	if err := saveCreateRecord(job, "intent.json", intent); err == nil {
		t.Fatal("overwrote immutable intent")
	}
	if err := job.Mkdir("committed.json", 0700); err != nil {
		t.Fatal(err)
	}
	store := createReceipts{root: root,
		create: func(context.Context, RunSpec) (ContainerInfo, error) {
			t.Fatal("unexpected create")
			return ContainerInfo{}, nil
		},
		inspect: func(context.Context, string) (ContainerInfo, error) {
			t.Fatal("nonregular receipt authorized inspect")
			return ContainerInfo{}, nil
		},
	}
	if _, err := store.run(context.Background(), spec, op); !errors.Is(err, ErrCreateUnknown) {
		t.Fatalf("nonregular committed record: %v", err)
	}
	// A second process can open, but can never re-claim, an existing operation.
	second, claimed, err := openCreateJob(root, op.ID, true)
	if err != nil || claimed {
		t.Fatalf("existing job reclaimed: %v %v", claimed, err)
	}
	second.Close()
}
