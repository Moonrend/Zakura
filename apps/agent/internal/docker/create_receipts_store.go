package docker

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const createReceiptDirectory = ".docker-create-receipts"

var errCreateRecordMissing = fs.ErrNotExist

type createJob struct{ *os.Root }

// All child access is relative to pinned roots. Reject symlinks (including
// StorageRoot's ancestors), non-regular records, and directory-swap races.
func realCreateRoot(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("receipt directory is not a real directory")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	file, err := root.Open(".")
	if err != nil {
		root.Close()
		return nil, err
	}
	after, statErr := file.Stat()
	file.Close()
	if statErr != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, fmt.Errorf("receipt directory changed during access")
	}
	return root, nil
}

func createStorageRoot(path string) (*os.Root, error) {
	if path == "" {
		return nil, fmt.Errorf("receipt storage root is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	volume := filepath.VolumeName(absolute)
	root, err := os.OpenRoot(volume + string(filepath.Separator))
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(absolute[len(volume):], string(filepath.Separator)), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		child, err := realCreateRoot(root, component)
		root.Close()
		if err != nil {
			return nil, err
		}
		root = child
	}
	return root, nil
}

func openCreateJob(path, operationID string, create bool) (createJob, bool, error) {
	storage, err := createStorageRoot(path)
	if err != nil {
		return createJob{}, false, err
	}
	defer storage.Close()
	if create {
		if err := storage.Mkdir(createReceiptDirectory, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
			return createJob{}, false, err
		}
	}
	receipts, err := realCreateRoot(storage, createReceiptDirectory)
	if err != nil {
		return createJob{}, false, err
	}
	defer receipts.Close()
	// Always sync the parent, even if another process just created the receipts
	// directory. No effect may precede durable existence of this claim chain.
	if create {
		if err := syncCreateDirectory(storage); err != nil {
			return createJob{}, false, err
		}
	}
	key := sha256.Sum256([]byte(operationID))
	name := hex.EncodeToString(key[:])
	claimed := false
	if create {
		err := receipts.Mkdir(name, 0700)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return createJob{}, false, err
		}
		claimed = err == nil
		if err := syncCreateDirectory(receipts); err != nil {
			return createJob{}, false, err
		}
	}
	job, err := realCreateRoot(receipts, name)
	return createJob{job}, claimed, err
}

func readCreateRecord(job createJob, name string, value any) error {
	before, err := job.Lstat(name)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > 65536 {
		return fmt.Errorf("invalid receipt record")
	}
	file, err := job.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return fmt.Errorf("receipt record changed during access")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 65537))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("invalid receipt record tail")
	}
	return nil
}

func readCreateIntent(job createJob) (createIntent, error) {
	var intent createIntent
	if err := readCreateRecord(job, "intent.json", &intent); err != nil {
		return intent, err
	}
	digest, err := hex.DecodeString(intent.ConfigDigest)
	if intent.Version != 1 || !intent.Operation.valid() || !createName.MatchString(intent.Name) ||
		err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != intent.ConfigDigest {
		return intent, fmt.Errorf("invalid receipt intent")
	}
	return intent, nil
}

func saveCreateRecord(job createJob, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 65536 {
		return fmt.Errorf("receipt record too large")
	}
	// Records are immutable. In particular an existing malformed or symlinked
	// record is never removed/replaced to manufacture a fresh authorization.
	if _, err := job.Lstat(name); err == nil {
		return fmt.Errorf("receipt record already exists")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := ".receipt-" + hex.EncodeToString(nonce[:])
	file, err := job.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer job.Remove(temporary)
	_, err = io.Copy(file, bytes.NewReader(raw))
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Link publishes the entire fsynced record atomically without replacing an
	// existing record, including one published by a concurrent status process.
	if err := job.Link(temporary, name); err != nil {
		// Concurrent recovery is valid only when it published the same bytes.
		var existing json.RawMessage
		if readErr := readCreateRecord(job, name, &existing); readErr != nil || !bytes.Equal(existing, raw) {
			return err
		}
	}
	return syncCreateDirectory(job.Root)
}
