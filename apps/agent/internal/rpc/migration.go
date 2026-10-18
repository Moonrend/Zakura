package rpc

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
)

const migrationArchiveLimit = 8 << 20
const migrationExpandedLimit = 64 << 20
const migrationEntriesLimit = 10000

type migrationRequest struct {
	SpaceID       string `json:"spaceId"`
	MigrationID   string `json:"migrationId"`
	Operation     string `json:"operation"`
	ArchiveBase64 string `json:"archiveBase64"`
	ArchiveSHA256 string `json:"archiveSha256"`
}

type migrationResult struct {
	MigrationID   string `json:"migrationId"`
	Phase         string `json:"phase"`
	ArchiveSHA256 string `json:"archiveSha256,omitempty"`
	Verified      bool   `json:"verified"`
	ArchiveBase64 string `json:"archiveBase64,omitempty"`
	Size          int    `json:"size"`
	Entries       int    `json:"entries"`
}

type migrationManifest struct {
	SpaceID       string `json:"spaceId"`
	MigrationID   string `json:"migrationId"`
	Phase         string `json:"phase"`
	ArchiveSHA256 string `json:"archiveSha256"`
	Size          int    `json:"size"`
	Entries       int    `json:"entries"`
}

func (h *Handler) workspaceMigration(ctx context.Context, raw json.RawMessage) (any, error) {
	var p migrationRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return nil, fmt.Errorf("invalid migration parameters")
	}
	if !sandboxSpaceID.MatchString(p.SpaceID) || !sandboxSpaceID.MatchString(p.MigrationID) {
		return nil, fmt.Errorf("valid spaceId and migrationId are required")
	}
	h.migrationMu.Lock()
	defer h.migrationMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	storage, err := os.OpenRoot(h.StorageRoot)
	if err != nil {
		return nil, fmt.Errorf("migration storage is unavailable")
	}
	defer storage.Close()
	create := p.Operation == "prepare"
	space, err := migrationSpaceRoot(storage, p.SpaceID, create)
	if err != nil {
		if p.Operation == "status" && errors.Is(err, fs.ErrNotExist) {
			return migrationResult{MigrationID: p.MigrationID, Phase: "missing"}, nil
		}
		return nil, err
	}
	defer space.Close()
	if p.Operation == "inspect" || p.Operation == "export" {
		source, err := migrationRealRoot(space, "workspace")
		if err != nil {
			return nil, fmt.Errorf("source workspace is unavailable")
		}
		defer source.Close()
		archive, count, err := migrationArchive(ctx, source)
		if err != nil {
			return nil, err
		}
		result := migrationResult{MigrationID: p.MigrationID, Phase: "inspected", ArchiveSHA256: migrationDigest(archive), Size: len(archive), Entries: count}
		if p.Operation == "export" {
			result.Phase = "exported"
			result.ArchiveBase64 = base64.StdEncoding.EncodeToString(archive)
		}
		return result, nil
	}
	switch p.Operation {
	case "prepare", "import", "verify", "commit", "status":
	default:
		return nil, fmt.Errorf("unknown migration operation")
	}
	jobs, err := migrationChildRoot(space, ".workspace-migrations", create)
	if err != nil {
		if p.Operation == "status" && errors.Is(err, fs.ErrNotExist) {
			return migrationResult{MigrationID: p.MigrationID, Phase: "missing"}, nil
		}
		return nil, err
	}
	defer jobs.Close()
	job, err := migrationChildRoot(jobs, p.MigrationID, create)
	if err != nil {
		if p.Operation == "status" && errors.Is(err, fs.ErrNotExist) {
			return migrationResult{MigrationID: p.MigrationID, Phase: "missing"}, nil
		}
		return nil, err
	}
	defer job.Close()
	manifest, err := migrationReadManifest(job)
	if errors.Is(err, fs.ErrNotExist) && p.Operation == "prepare" {
		if p.ArchiveSHA256 != "" && !migrationValidDigest(p.ArchiveSHA256) {
			return nil, fmt.Errorf("archiveSha256 is invalid")
		}
		manifest = migrationManifest{SpaceID: p.SpaceID, MigrationID: p.MigrationID, Phase: "prepared", ArchiveSHA256: p.ArchiveSHA256}
		if err = migrationEmptyCanonical(space); err != nil {
			return nil, err
		}
		err = migrationSaveManifest(job, manifest)
	}
	if err != nil {
		return nil, err
	}
	if manifest.SpaceID != p.SpaceID || manifest.MigrationID != p.MigrationID {
		return nil, fmt.Errorf("migration identity mismatch")
	}
	if manifest.ArchiveSHA256 == "" && p.ArchiveSHA256 != "" && (p.Operation == "prepare" || p.Operation == "import") {
		if !migrationValidDigest(p.ArchiveSHA256) {
			return nil, fmt.Errorf("archiveSha256 is invalid")
		}
		manifest.ArchiveSHA256 = p.ArchiveSHA256
		if err := migrationSaveManifest(job, manifest); err != nil {
			return nil, err
		}
	}
	if p.ArchiveSHA256 != "" && p.ArchiveSHA256 != manifest.ArchiveSHA256 {
		return nil, fmt.Errorf("migration digest mismatch")
	}
	if p.Operation != "status" && p.Operation != "prepare" && !migrationValidDigest(p.ArchiveSHA256) {
		return nil, fmt.Errorf("archiveSha256 is required")
	}
	if manifest.Phase == "promoting" {
		if _, err := job.Lstat("tree"); errors.Is(err, fs.ErrNotExist) {
			canonical, err := migrationRealRoot(space, "workspace")
			if err != nil {
				return nil, fmt.Errorf("migration promotion is not yet confirmed")
			}
			archive, count, err := migrationArchive(ctx, canonical)
			canonical.Close()
			if err != nil || migrationDigest(archive) != manifest.ArchiveSHA256 {
				return nil, fmt.Errorf("migration promotion identity cannot be verified")
			}
			manifest.Phase = "committed"
			manifest.Entries = count
			if err := migrationSaveManifest(job, manifest); err != nil {
				return nil, err
			}
		}
	}
	if p.Operation == "prepare" && manifest.Phase != "committed" {
		if err := migrationEmptyCanonical(space); err != nil {
			return nil, err
		}
	}
	result := func() migrationResult {
		return migrationResult{MigrationID: p.MigrationID, Phase: manifest.Phase, ArchiveSHA256: manifest.ArchiveSHA256, Verified: manifest.Phase == "verified" || manifest.Phase == "committed", Size: manifest.Size, Entries: manifest.Entries}
	}
	if manifest.Phase == "committed" || p.Operation == "status" || p.Operation == "prepare" {
		return result(), nil
	}
	switch p.Operation {
	case "import":
		if len(p.ArchiveBase64) > base64.StdEncoding.EncodedLen(migrationArchiveLimit) {
			return nil, fmt.Errorf("migration archive exceeds 8 MiB limit")
		}
		archive, err := base64.StdEncoding.DecodeString(p.ArchiveBase64)
		if err != nil || migrationDigest(archive) != manifest.ArchiveSHA256 {
			return nil, fmt.Errorf("migration archive digest mismatch")
		}
		if manifest.Phase == "imported" || manifest.Phase == "verified" {
			return result(), nil
		}
		if manifest.Phase != "prepared" && manifest.Phase != "importing" {
			return nil, fmt.Errorf("migration phase does not permit import")
		}
		// A partial tree belongs only to this job and is never canonical. The durable
		// importing phase makes a retry safe after a crash partway through extraction.
		manifest.Phase = "importing"
		if err := migrationSaveManifest(job, manifest); err != nil {
			return nil, err
		}
		if err := job.RemoveAll("tree"); err != nil {
			return nil, err
		}
		if err := job.Mkdir("tree", 0700); err != nil {
			return nil, err
		}
		tree, err := migrationRealRoot(job, "tree")
		if err != nil {
			return nil, err
		}
		count, err := migrationExtract(ctx, tree, archive)
		tree.Close()
		if err != nil {
			return nil, err
		}
		manifest.Phase = "imported"
		manifest.Size = len(archive)
		manifest.Entries = count
		if err := migrationSaveManifest(job, manifest); err != nil {
			return nil, err
		}
	case "verify", "commit":
		if manifest.Phase != "imported" && manifest.Phase != "verified" && manifest.Phase != "promoting" {
			return nil, fmt.Errorf("migration must be imported before verification")
		}
		tree, err := migrationRealRoot(job, "tree")
		if err != nil {
			return nil, err
		}
		archive, count, err := migrationArchive(ctx, tree)
		tree.Close()
		if err != nil {
			return nil, err
		}
		if migrationDigest(archive) != manifest.ArchiveSHA256 {
			return nil, fmt.Errorf("migration verification failed: content, modes, links or entry tree differ")
		}
		manifest.Phase = "verified"
		manifest.Entries = count
		if err := migrationSaveManifest(job, manifest); err != nil {
			return nil, err
		}
		if p.Operation == "commit" {
			if err := migrationEmptyCanonical(space); err != nil {
				return nil, err
			}
			manifest.Phase = "promoting"
			if err := migrationSaveManifest(job, manifest); err != nil {
				return nil, err
			}
			// Renaming the completed tree never merges into an existing destination.
			// Removing an empty directory cannot delete any user file even if it races.
			if err := space.Remove("workspace"); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return nil, fmt.Errorf("target workspace is no longer empty")
			}
			if err := migrationPromote(job, space); err != nil {
				return nil, err
			}
			migrationSyncDirectory(space)
			manifest.Phase = "committed"
			if err := migrationSaveManifest(job, manifest); err != nil {
				return nil, err
			}
		}
	}
	return result(), nil
}

func migrationSpaceRoot(storage *os.Root, spaceID string, create bool) (*os.Root, error) {
	spaces, err := migrationChildRoot(storage, "spaces", create)
	if err != nil {
		return nil, err
	}
	defer spaces.Close()
	return migrationChildRoot(spaces, spaceID, create)
}

func migrationChildRoot(parent *os.Root, name string, create bool) (*os.Root, error) {
	if create {
		if err := parent.Mkdir(name, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
	}
	return migrationRealRoot(parent, name)
}

func migrationRealRoot(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("migration directory must not be a symlink")
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
	after, err := file.Stat()
	file.Close()
	if err != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, fmt.Errorf("migration directory changed during access")
	}
	return root, nil
}

func migrationValidDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}
func migrationDigest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func migrationReadManifest(root *os.Root) (migrationManifest, error) {
	var manifest migrationManifest
	info, err := root.Lstat("manifest.json")
	if err != nil {
		return manifest, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return manifest, fmt.Errorf("invalid migration manifest")
	}
	file, err := root.Open("manifest.json")
	if err != nil {
		return manifest, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) {
		return manifest, fmt.Errorf("migration manifest changed")
	}
	err = json.NewDecoder(io.LimitReader(file, 4097)).Decode(&manifest)
	return manifest, err
}

func migrationSaveManifest(root *os.Root, manifest migrationManifest) error {
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	_ = root.Remove("manifest.tmp")
	file, err := root.OpenFile("manifest.tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := root.Rename("manifest.tmp", "manifest.json"); err != nil {
		return err
	}
	migrationSyncDirectory(root)
	return nil
}

func migrationSyncDirectory(root *os.Root) {
	if file, err := root.Open("."); err == nil {
		_ = file.Sync()
		file.Close()
	}
}

func migrationEmptyCanonical(space *os.Root) error {
	root, err := migrationRealRoot(space, "workspace")
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	names, err := file.Readdirnames(1)
	if err != nil && err != io.EOF {
		return err
	}
	if len(names) > 0 {
		return fmt.Errorf("target workspace is not empty; user files will not be overwritten")
	}
	return nil
}

// Stable tar/gzip metadata makes a re-export an exact full-tree verification.
// Hashes cover path, type, permissions, link target and bytes, not host timestamps.
func migrationArchive(ctx context.Context, root *os.Root) ([]byte, int, error) {
	var compressed bytes.Buffer
	gzipWriter := gzip.NewWriter(&compressed)
	writer := tar.NewWriter(gzipWriter)
	count := 0
	var expanded int64
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !migrationSafeName(name) {
			return fmt.Errorf("migration refuses unsafe path at %s", name)
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
			return fmt.Errorf("migration refuses special permissions at %s", name)
		}
		mode := info.Mode()
		if !mode.IsRegular() && !mode.IsDir() && mode&os.ModeSymlink == 0 {
			return fmt.Errorf("migration refuses unsupported file type at %s", name)
		}
		count++
		if count > migrationEntriesLimit {
			return fmt.Errorf("migration exceeds 10000 entries limit")
		}
		header := &tar.Header{Name: name, Mode: int64(mode.Perm()), Format: tar.FormatPAX}
		switch {
		case mode.IsDir():
			header.Typeflag = tar.TypeDir
		case mode&os.ModeSymlink != 0:
			target, err := root.Readlink(name)
			if err != nil {
				return err
			}
			if err := migrationSafeLink(name, target); err != nil {
				return err
			}
			if _, err := root.Stat(name); err != nil {
				return fmt.Errorf("migration link must resolve within workspace: %s", name)
			}
			header.Typeflag = tar.TypeSymlink
			header.Linkname = target
		default:
			header.Typeflag = tar.TypeReg
			header.Size = info.Size()
			expanded += info.Size()
			if expanded > migrationExpandedLimit {
				return fmt.Errorf("migration exceeds 64 MiB expanded limit")
			}
		}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if mode.IsRegular() {
			file, err := root.Open(name)
			if err != nil {
				return err
			}
			after, err := file.Stat()
			if err != nil || !os.SameFile(info, after) || !after.Mode().IsRegular() {
				file.Close()
				return fmt.Errorf("migration source changed at %s", name)
			}
			_, err = io.CopyN(writer, file, info.Size())
			file.Close()
			if err != nil {
				return err
			}
		}
		if compressed.Len() > migrationArchiveLimit {
			return fmt.Errorf("migration archive exceeds 8 MiB limit")
		}
		return nil
	})
	if err != nil {
		writer.Close()
		gzipWriter.Close()
		return nil, 0, err
	}
	if err := writer.Close(); err != nil {
		return nil, 0, err
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, 0, err
	}
	if compressed.Len() > migrationArchiveLimit {
		return nil, 0, fmt.Errorf("migration archive exceeds 8 MiB limit")
	}
	return compressed.Bytes(), count, nil
}

func migrationSafeName(name string) bool {
	return name != "" && !strings.ContainsAny(name, "\\:\x00") && !path.IsAbs(name) && path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../")
}
func migrationSafeLink(name, target string) error {
	if target == "" || strings.ContainsAny(target, "\\:\x00") || path.IsAbs(target) {
		return fmt.Errorf("migration refuses unsafe link at %s", name)
	}
	resolved := path.Clean(path.Join(path.Dir(name), target))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("migration refuses escaping link at %s", name)
	}
	return nil
}

type migrationEntry struct {
	name   string
	mode   fs.FileMode
	target string
	kind   byte
}

func migrationExtract(ctx context.Context, root *os.Root, archive []byte) (int, error) {
	if len(archive) > migrationArchiveLimit {
		return 0, fmt.Errorf("migration archive exceeds 8 MiB limit")
	}
	zipped, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return 0, err
	}
	defer zipped.Close()
	reader := tar.NewReader(io.LimitReader(zipped, migrationExpandedLimit+(migrationEntriesLimit*2048)))
	entries := []migrationEntry{}
	seen := map[string]byte{}
	var expanded int64
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		name := header.Name
		if !migrationSafeName(name) || seen[name] != 0 {
			return 0, fmt.Errorf("migration archive contains unsafe or duplicate path")
		}
		if header.Mode < 0 || header.Mode&^int64(0777) != 0 {
			return 0, fmt.Errorf("migration refuses special permissions")
		}
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeSymlink {
			return 0, fmt.Errorf("migration refuses unsupported archive entry")
		}
		if name == "." && header.Typeflag != tar.TypeDir {
			return 0, fmt.Errorf("invalid migration root")
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if seen[parent] != tar.TypeDir {
				return 0, fmt.Errorf("migration archive parent must be a real directory")
			}
		}
		if name != "." && seen["."] != tar.TypeDir {
			return 0, fmt.Errorf("migration archive root entry is required")
		}
		seen[name] = header.Typeflag
		entries = append(entries, migrationEntry{name, fs.FileMode(header.Mode), header.Linkname, header.Typeflag})
		if len(entries) > migrationEntriesLimit {
			return 0, fmt.Errorf("migration exceeds 10000 entries limit")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if name != "." {
				if err := root.Mkdir(name, 0700); err != nil {
					return 0, err
				}
			}
		case tar.TypeSymlink:
			if err := migrationSafeLink(name, header.Linkname); err != nil {
				return 0, err
			}
		case tar.TypeReg:
			expanded += header.Size
			if header.Size < 0 || expanded > migrationExpandedLimit {
				return 0, fmt.Errorf("migration exceeds 64 MiB expanded limit")
			}
			file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return 0, err
			}
			_, err = io.CopyN(file, reader, header.Size)
			if err == nil {
				err = file.Chmod(fs.FileMode(header.Mode))
			}
			if err == nil {
				err = file.Sync()
			}
			closeErr := file.Close()
			if err != nil {
				return 0, err
			}
			if closeErr != nil {
				return 0, closeErr
			}
		}
	}
	if seen["."] != tar.TypeDir {
		return 0, fmt.Errorf("migration archive root entry is required")
	}
	// Links are created only after regular files, so no extraction write can
	// traverse a link supplied by an archive. Root handles confine all access.
	for _, entry := range entries {
		if entry.kind == tar.TypeSymlink {
			if err := root.Symlink(entry.target, entry.name); err != nil {
				return 0, err
			}
		}
	}
	for _, entry := range entries {
		if entry.kind == tar.TypeSymlink {
			if _, err := root.Stat(entry.name); err != nil {
				return 0, fmt.Errorf("migration link must resolve within workspace: %s", entry.name)
			}
		}
	}
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.kind == tar.TypeDir {
			file, err := root.Open(entry.name)
			if err != nil {
				return 0, err
			}
			err = file.Chmod(entry.mode)
			if err == nil {
				_ = file.Sync()
			}
			file.Close()
			if err != nil {
				return 0, err
			}
		}
	}
	migrationSyncDirectory(root)
	return len(entries), nil
}
