package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type Repository struct {
	root string
	opts Options
	mu   chan struct{}
}

var repositoryLocks sync.Map

func New(root string, options Options) (*Repository, error) {
	if root == "" {
		return nil, ErrUnsafePath
	}
	abs, err := filepath.Abs(root)
	if err != nil || abs == string(filepath.Separator) {
		return nil, ErrUnsafePath
	}
	if err = checkAncestors(abs); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	if options.MaxFiles == 0 {
		options.MaxFiles = 100000
	}
	if options.MaxFileBytes == 0 {
		options.MaxFileBytes = 64 << 20
	}
	if options.MaxTotalBytes == 0 {
		options.MaxTotalBytes = 1 << 30
	}
	if options.MaxPathBytes == 0 {
		options.MaxPathBytes = 1024
	}
	if options.MaxTextBytes == 0 {
		options.MaxTextBytes = 2 << 20
	}
	if options.MaxFiles < 1 || options.MaxFileBytes < 1 || options.MaxTotalBytes < 1 || options.MaxPathBytes < 1 || options.MaxTextBytes < 1 {
		return nil, ErrLimit
	}
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	lock, _ := repositoryLocks.LoadOrStore(abs, gate)
	r := &Repository{root: abs, opts: options, mu: lock.(chan struct{})}
	for _, dir := range []string{"objects", "manifests", "branches", "worktrees", "plans", "journals", "tmp"} {
		if err = checkAncestors(filepath.Join(abs, dir)); err != nil {
			return nil, err
		}
		if err = os.MkdirAll(filepath.Join(abs, dir), 0700); err != nil {
			return nil, err
		}
	}
	err = r.locked(context.Background(), func() error {
		if e := r.cleanupTemporary(context.Background()); e != nil {
			return e
		}
		_, e := r.recover(context.Background(), true)
		return e
	})
	return r, err
}

func (r *Repository) locked(ctx context.Context, fn func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-r.mu:
	}
	defer func() { r.mu <- struct{}{} }()
	if err := checkAncestors(filepath.Join(r.root, ".lock")); err != nil {
		return err
	}
	if info, err := os.Lstat(filepath.Join(r.root, ".lock")); err == nil {
		if !info.Mode().IsRegular() {
			return ErrUnsafePath
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(filepath.Join(r.root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		if err != nil {
			return err
		}
		return ErrUnsafePath
	}
	if err = fileLock(ctx, f); err != nil {
		return err
	}
	defer fileUnlock(f)
	if err := ctx.Err(); err != nil {
		return err
	}
	for _, name := range []string{"objects", "manifests", "branches", "worktrees", "plans", "journals", "tmp"} {
		directory := filepath.Join(r.root, name)
		if err := checkAncestors(directory); err != nil {
			return err
		}
		info, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return ErrCorrupt
		}
	}
	return fn()
}

func hashBytes(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func validHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			if c < 'a' || c > 'f' {
				return false
			}
		}
	}
	return true
}

func validatePath(value string) error {
	if value == "" || !utf8.ValidString(value) || len(value) > 4096 || strings.Contains(value, "\\") || strings.Contains(value, ":") || strings.HasPrefix(value, "/") {
		return ErrUnsafePath
	}
	for _, c := range value {
		if unicode.IsControl(c) {
			return ErrUnsafePath
		}
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." || len(component) > 255 {
			return ErrUnsafePath
		}
	}
	return nil
}

func validBranch(id string) bool {
	if id == "" || len(id) > 128 || id == "." || id == ".." {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}

func checkAncestors(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ErrUnsafePath
	}
	current := filepath.VolumeName(abs) + string(filepath.Separator)
	rel := strings.TrimPrefix(strings.TrimPrefix(abs, filepath.VolumeName(abs)), string(filepath.Separator))
	for _, component := range strings.Split(rel, string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		info, e := os.Lstat(current)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrUnsafePath
		}
	}
	return nil
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func atomicJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicBytes(path, data, 0600)
}

func atomicBytes(path string, value []byte, mode fs.FileMode) error {
	return atomicBytesIn(filepath.Dir(path), path, value, mode)
}

func atomicBytesIn(temporaryDir, path string, value []byte, mode fs.FileMode) error {
	if err := checkAncestors(path); err != nil {
		return err
	}
	if err := checkAncestors(temporaryDir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(temporaryDir, ".pending-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(value)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	if err = syncDir(filepath.Dir(path)); err != nil {
		return err
	}
	if temporaryDir != filepath.Dir(path) {
		return syncDir(temporaryDir)
	}
	return nil
}

// Pending files live in private metadata directories. Branch file writes use
// repository/tmp, so a crash cannot add a library temporary file to an artifact.
func (r *Repository) cleanupTemporary(ctx context.Context) error {
	for _, name := range []string{"objects", "manifests", "branches", "plans", "journals", "tmp"} {
		directory := filepath.Join(r.root, name)
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		changed := false
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !strings.HasPrefix(entry.Name(), ".pending-") && !(name == "tmp" && strings.HasPrefix(entry.Name(), "import-")) {
				continue
			}
			if err := os.RemoveAll(filepath.Join(directory, entry.Name())); err != nil {
				return err
			}
			changed = true
		}
		if changed {
			if err := syncDir(directory); err != nil {
				return err
			}
		}
	}
	return nil
}

func loadJSON(path string, target any) error {
	if err := checkAncestors(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 128<<20 {
		return ErrCorrupt
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, info.Size()+1))
	d.DisallowUnknownFields()
	if err = d.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return ErrCorrupt
	}
	return nil
}

func (r *Repository) readObject(hash string, size int64) ([]byte, error) {
	if !validHash(hash) || size < 0 || size > r.opts.MaxFileBytes {
		return nil, ErrCorrupt
	}
	path := filepath.Join(r.root, "objects", hash)
	if err := checkAncestors(path); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return nil, ErrCorrupt
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size || hashBytes(data) != hash {
		return nil, ErrCorrupt
	}
	return data, nil
}

func (r *Repository) putObject(ctx context.Context, data []byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if int64(len(data)) > r.opts.MaxFileBytes {
		return "", ErrLimit
	}
	hash := hashBytes(data)
	path := filepath.Join(r.root, "objects", hash)
	if _, err := os.Lstat(path); err == nil {
		_, err = r.readObject(hash, int64(len(data)))
		return hash, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return hash, atomicBytes(path, data, 0600)
}

func (r *Repository) validateEntries(entries []Entry) (int64, error) {
	if len(entries) > r.opts.MaxFiles {
		return 0, ErrLimit
	}
	seen := make(map[string]bool, len(entries))
	total := int64(0)
	metadataBytes := int64(256)
	for _, e := range entries {
		if validatePath(e.Path) != nil || len(e.Path) > r.opts.MaxPathBytes {
			return 0, ErrUnsafePath
		}
		if seen[e.Path] || !validHash(e.Hash) || e.Size < 0 || e.Size > r.opts.MaxFileBytes || e.Mode > 0777 {
			return 0, ErrCorrupt
		}
		if e.Mode&0400 == 0 {
			// Repository worktrees must remain readable by their owning runner,
			// including after a restart when installed bytes are re-verified.
			return 0, fmt.Errorf("%w: file requires owner read permission", ErrUnsafePath)
		}
		encoded, err := json.Marshal(e)
		if err != nil {
			return 0, err
		}
		metadataBytes += int64(len(encoded)) + 1
		if metadataBytes > 128<<20 {
			return 0, ErrLimit
		}
		seen[e.Path] = true
		if e.Size > r.opts.MaxTotalBytes-total {
			return 0, ErrLimit
		}
		total += e.Size
	}
	for path := range seen {
		for parent := filepath.ToSlash(filepath.Dir(path)); parent != "."; parent = filepath.ToSlash(filepath.Dir(parent)) {
			if seen[parent] {
				return 0, fmt.Errorf("%w: file/directory collision", ErrConflict)
			}
		}
	}
	return total, nil
}

func (r *Repository) validateEntriesContext(ctx context.Context, entries []Entry, verify bool) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	total, err := r.validateEntries(entries)
	if err != nil {
		return 0, err
	}
	if verify {
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			if _, err := r.readObject(entry.Hash, entry.Size); err != nil {
				return 0, err
			}
		}
	}
	return total, ctx.Err()
}

func snapshotHash(entries []Entry, total int64) string {
	raw, _ := json.Marshal(struct {
		Entries    []Entry `json:"entries"`
		TotalBytes int64   `json:"totalBytes"`
	}{entries, total})
	return hashBytes(raw)
}

func (r *Repository) saveSnapshot(ctx context.Context, entries []Entry) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	copyEntries := append([]Entry{}, entries...)
	sort.Slice(copyEntries, func(i, j int) bool { return copyEntries[i].Path < copyEntries[j].Path })
	total, err := r.validateEntriesContext(ctx, copyEntries, true)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot := Snapshot{ID: snapshotHash(copyEntries, total), Entries: copyEntries, TotalBytes: total}
	path := filepath.Join(r.root, "manifests", snapshot.ID+".json")
	if _, err = os.Stat(path); err == nil {
		return r.getSnapshot(ctx, snapshot.ID)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, err
	}
	return snapshot, atomicJSON(path, snapshot)
}

func (r *Repository) getSnapshot(ctx context.Context, id string) (Snapshot, error) {
	return r.readManifest(ctx, id, true)
}

func (r *Repository) readManifest(ctx context.Context, id string, verifyObjects bool) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	if !validHash(id) {
		return Snapshot{}, ErrUnsafePath
	}
	var snapshot Snapshot
	if err := loadJSON(filepath.Join(r.root, "manifests", id+".json"), &snapshot); err != nil {
		return Snapshot{}, err
	}
	total, err := r.validateEntriesContext(ctx, snapshot.Entries, verifyObjects)
	if err != nil {
		return Snapshot{}, err
	}
	for i := 1; i < len(snapshot.Entries); i++ {
		if snapshot.Entries[i-1].Path >= snapshot.Entries[i].Path {
			return Snapshot{}, ErrCorrupt
		}
	}
	if snapshot.ID != id || total != snapshot.TotalBytes || snapshotHash(snapshot.Entries, total) != id {
		return Snapshot{}, ErrCorrupt
	}
	return snapshot, nil
}

func (r *Repository) GetSnapshot(ctx context.Context, id string) (result Snapshot, err error) {
	err = r.locked(ctx, func() error { result, err = r.getSnapshot(ctx, id); return err })
	return
}

// ReadSnapshot returns verified immutable file bytes without materializing the
// tree. No path is interpreted against an arbitrary host directory.
func (r *Repository) ReadSnapshot(ctx context.Context, id, path string) (data []byte, err error) {
	err = r.locked(ctx, func() error {
		if validatePath(path) != nil || len(path) > r.opts.MaxPathBytes {
			return ErrUnsafePath
		}
		snapshot, e := r.readManifest(ctx, id, false)
		if e != nil {
			return e
		}
		index := sort.Search(len(snapshot.Entries), func(i int) bool { return snapshot.Entries[i].Path >= path })
		if index == len(snapshot.Entries) || snapshot.Entries[index].Path != path {
			return ErrNotFound
		}
		entry := snapshot.Entries[index]
		data, e = r.readObject(entry.Hash, entry.Size)
		return e
	})
	return
}

func (r *Repository) capture(ctx context.Context, source string) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	abs, err := filepath.Abs(source)
	if err != nil {
		return Snapshot{}, ErrUnsafePath
	}
	if err = checkAncestors(abs); err != nil {
		return Snapshot{}, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return Snapshot{}, err
	}
	if !info.IsDir() {
		return Snapshot{}, ErrUnsafePath
	}
	if within(abs, r.root) {
		return Snapshot{}, fmt.Errorf("%w: source contains repository", ErrUnsafePath)
	}
	entries := []Entry{}
	total := int64(0)
	err = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return ErrUnsafePath
		}
		if entry.IsDir() {
			return nil
		}
		meta, err := entry.Info()
		if err != nil {
			return err
		}
		if !meta.Mode().IsRegular() {
			return ErrUnsafePath
		}
		if meta.Size() < 0 || meta.Size() > r.opts.MaxFileBytes || meta.Size() > r.opts.MaxTotalBytes-total || len(entries) >= r.opts.MaxFiles {
			return ErrLimit
		}
		rel, err := filepath.Rel(abs, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if validatePath(rel) != nil || len(rel) > r.opts.MaxPathBytes {
			return ErrUnsafePath
		}
		if err = checkAncestors(path); err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		opened, statErr := f.Stat()
		if statErr != nil || !opened.Mode().IsRegular() || !os.SameFile(meta, opened) {
			f.Close()
			return ErrConflict
		}
		data, readErr := io.ReadAll(io.LimitReader(f, r.opts.MaxFileBytes+1))
		after, afterErr := f.Stat()
		f.Close()
		current, currentErr := os.Lstat(path)
		if readErr != nil {
			return readErr
		}
		if afterErr != nil || currentErr != nil || !os.SameFile(meta, current) || !meta.ModTime().Equal(after.ModTime()) || meta.Size() != after.Size() || int64(len(data)) != meta.Size() {
			return ErrConflict
		}
		hash, err := r.putObject(ctx, data)
		if err != nil {
			return err
		}
		total += int64(len(data))
		entries = append(entries, Entry{Path: rel, Hash: hash, Size: int64(len(data)), Mode: uint32(meta.Mode().Perm())})
		return nil
	})
	if err != nil {
		return Snapshot{}, err
	}
	return r.saveSnapshot(ctx, entries)
}

func within(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (r *Repository) Snapshot(ctx context.Context, sourceRoot string) (result Snapshot, err error) {
	err = r.locked(ctx, func() error { result, err = r.capture(ctx, sourceRoot); return err })
	return
}

func (r *Repository) VerifyArtifacts(ctx context.Context, manifest ArtifactManifest) error {
	return r.locked(ctx, func() error {
		snapshot, err := r.getSnapshot(ctx, manifest.SnapshotID)
		if err != nil {
			return err
		}
		byPath := make(map[string]Entry, len(snapshot.Entries))
		for _, e := range snapshot.Entries {
			byPath[e.Path] = e
		}
		seen := map[string]bool{}
		for _, entry := range manifest.Entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if seen[entry.Path] || byPath[entry.Path] != entry {
				return ErrCorrupt
			}
			seen[entry.Path] = true
			if _, err = r.readObject(entry.Hash, entry.Size); err != nil {
				return err
			}
		}
		return nil
	})
}
