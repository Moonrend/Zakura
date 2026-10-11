// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/delivery"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

const deliveryCacheBytes int64 = 2 << 30
const deliveryPackages = 32
const deliveryUploads = 4

type deliveryRequest struct {
	Scope
	OperationID string            `json:"operationId,omitempty"`
	DeliveryID  string            `json:"deliveryId,omitempty"`
	TransferID  string            `json:"transferId,omitempty"`
	Manifest    delivery.Manifest `json:"manifest,omitempty"`
	TotalBytes  int64             `json:"totalBytes,omitempty"`
	SHA256      string            `json:"sha256,omitempty"`
	Offset      int64             `json:"offset,omitempty"`
	MaxBytes    int               `json:"maxBytes,omitempty"`
	Base64      string            `json:"base64,omitempty"`
}

type deliveryTransfer struct {
	ID              string             `json:"id"`
	TotalBytes      int64              `json:"totalBytes"`
	Received        int64              `json:"received"`
	SHA256          string             `json:"sha256"`
	Status          string             `json:"status"`
	SnapshotID      string             `json:"snapshotId,omitempty"`
	Manifest        *delivery.Manifest `json:"manifest,omitempty"`
	UntrustedReview bool               `json:"untrustedReview"`
	UpdatedAt       time.Time          `json:"updatedAt"`
}

var deliveryFields = map[string]string{
	"project.delivery.prepare":       "operationId deliveryId manifest",
	"project.delivery.info":          "deliveryId",
	"project.delivery.read":          "deliveryId offset maxBytes",
	"project.delivery.upload.begin":  "transferId totalBytes sha256",
	"project.delivery.upload.status": "transferId",
	"project.delivery.upload.chunk":  "transferId offset base64",
	"project.delivery.upload.finish": "operationId transferId",
	"project.delivery.upload.abort":  "transferId",
}

// import_ branches are durable GC roots for completed immutable imports, not
// task worktrees. Only deliveryUpload creates them through the repository API.
func protectImportPin(method string, req Request) error {
	isPin := func(id string) bool { return strings.HasPrefix(id, "import_") }
	switch method {
	case "project.branch.create", "project.branch.write", "project.branch.patch", "project.branch.rename", "project.branch.remove", "project.branch.capture", "project.exec":
		if isPin(req.BranchID) {
			return errors.New("import pins are immutable; fork a task branch to edit this snapshot")
		}
	case "project.branch.gc":
		for _, id := range req.BranchIDs {
			if isPin(id) {
				return errors.New("completed import pins cannot be removed by task branch GC")
			}
		}
	}
	return nil
}

func (m *Manager) DeliveryDispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	fields, ok := deliveryFields[method]
	if !ok || len(raw) == 0 || len(raw) > delivery.ChunkBytes*2+delivery.MaxManifestBytes {
		return nil, errors.New("invalid delivery method or request size")
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil || keys == nil {
		return nil, errors.New("delivery parameters must be an object")
	}
	allowed := map[string]bool{"spaceId": true, "projectId": true}
	for _, key := range strings.Fields(fields) {
		allowed[key] = true
	}
	for key := range keys {
		if !allowed[key] {
			return nil, fmt.Errorf("unsupported delivery parameter %q", key)
		}
	}
	var req deliveryRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil {
		return nil, errors.New("invalid delivery parameters")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return nil, errors.New("delivery requires exactly one object")
	}
	if err := req.Scope.Validate(); err != nil {
		return nil, err
	}
	for _, id := range []string{req.DeliveryID, req.TransferID, req.OperationID} {
		if id != "" {
			if err := ValidateID(id); err != nil {
				return nil, err
			}
		}
	}
	p, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	fn := func() (any, error) { return m.deliveryPerform(ctx, p, method, req) }
	if strings.Contains(" "+fields+" ", " operationId ") {
		if err = ValidateID(req.OperationID); err != nil {
			return nil, err
		}
		return runJournal(ctx, p, req.OperationID, method, raw, fn)
	}
	return fn()
}

func deliveryRoot(p *project) (string, error) { return SecureDirectory(p.root, "deliveries") }
func deliveryFolder(p *project, id string) (string, error) {
	return SecureDirectory(p.root, "deliveries", id)
}
func deliveryExistingFolder(p *project, id string) (string, error) {
	root, err := deliveryRoot(p)
	if err != nil {
		return "", err
	}
	path := filepath.Join(root, id)
	st, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("delivery folder is not a safe directory")
	}
	return path, nil
}
func deliveryPinID(transferID string) string {
	hash := sha256.Sum256([]byte(transferID))
	return "import_" + hex.EncodeToString(hash[:16])
}
func deliveryReadJSON(path string, value any) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() > delivery.MaxManifestBytes+65536 {
		return errors.New("invalid delivery metadata file")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, value)
}
func deliveryWriteJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".metadata-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func deliveryOpen(path string, flags int) (*os.File, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > delivery.MaxArchiveBytes {
		return nil, errors.New("invalid delivery archive file")
	}
	return os.OpenFile(path, flags, 0600)
}

// Reserved unreceived bytes count toward the cache quota, so concurrent transfers
// cannot each claim the same free space. All callers hold the project mutex.
func deliveryQuota(root string) (used int64, packages, uploads int, err error) {
	live := map[string]bool{}
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("delivery cache contains a symlink")
		}
		if d.IsDir() {
			return nil
		}
		st, e := d.Info()
		if e != nil {
			return e
		}
		if !st.Mode().IsRegular() {
			return errors.New("delivery cache contains a special file")
		}
		used += st.Size()
		if d.Name() == "archive.json" {
			var archive delivery.ArchiveInfo
			if e = deliveryReadJSON(path, &archive); e != nil {
				return e
			}
			live[filepath.Dir(path)] = true
		}
		if d.Name() == "upload.json" {
			var s deliveryTransfer
			if e = deliveryReadJSON(path, &s); e != nil {
				return e
			}
			if s.Status == "uploading" {
				if s.Received < 0 || s.Received > s.TotalBytes || s.TotalBytes > delivery.MaxArchiveBytes {
					return errors.New("invalid upload quota metadata")
				}
				used += s.TotalBytes - s.Received
				uploads++
			}
			if s.Status != "aborted" {
				live[filepath.Dir(path)] = true
			}
		}
		if used > deliveryCacheBytes {
			return errors.New("delivery cache quota reached")
		}
		return nil
	})
	packages = len(live)
	return
}

func (m *Manager) deliveryPerform(ctx context.Context, p *project, method string, req deliveryRequest) (any, error) {
	if strings.HasPrefix(method, "project.delivery.upload.") {
		return m.deliveryUpload(ctx, p, method, req)
	}
	if err := ValidateID(req.DeliveryID); err != nil {
		return nil, err
	}
	if method == "project.delivery.prepare" {
		return m.deliveryPrepare(ctx, p, req)
	}
	dir, err := deliveryExistingFolder(p, req.DeliveryID)
	if err != nil {
		return nil, err
	}
	var info delivery.ArchiveInfo
	if err = deliveryReadJSON(filepath.Join(dir, "archive.json"), &info); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		info, err = recoverDeliveryArchive(ctx, p, dir, req.DeliveryID)
		if err != nil {
			return nil, err
		}
	}
	if info.ID != req.DeliveryID {
		return nil, errors.New("delivery cache identity mismatch")
	}
	if method == "project.delivery.info" {
		return info, nil
	}
	if req.Offset < 0 || req.Offset > info.Bytes {
		return nil, errors.New("delivery offset is outside archive")
	}
	max := req.MaxBytes
	if max <= 0 {
		max = delivery.ChunkBytes
	}
	if max > delivery.ChunkBytes {
		return nil, errors.New("delivery read exceeds chunk limit")
	}
	f, err := deliveryOpen(filepath.Join(dir, "archive.tar"), os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() != info.Bytes {
		return nil, errors.New("delivery archive size mismatch")
	}
	b := make([]byte, min(int64(max), info.Bytes-req.Offset))
	n, err := f.ReadAt(b, req.Offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	b = b[:n]
	return map[string]any{"base64": base64.StdEncoding.EncodeToString(b), "offset": req.Offset, "nextOffset": req.Offset + int64(n), "eof": req.Offset+int64(n) == info.Bytes, "sha256": info.SHA256}, nil
}

// archive.tar is atomically installed after fsync, before archive.json. Its
// complete bounded envelope proves that crash window without trusting a
// partial temporary file or re-executing an effect against the source tree.
func recoverDeliveryArchive(ctx context.Context, p *project, dir, id string) (delivery.ArchiveInfo, error) {
	f, err := deliveryOpen(filepath.Join(dir, "archive.tar"), os.O_RDONLY)
	if err != nil {
		return delivery.ArchiveInfo{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return delivery.ArchiveInfo{}, err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, checkedDeliveryReader{ctx: ctx, reader: f}); err != nil {
		return delivery.ArchiveInfo{}, err
	}
	manifest, snapshot, err := delivery.Import(ctx, f, st.Size(), func(input io.Reader) (workspace.Snapshot, error) {
		// Importing verified immutable CAS content is idempotent and never
		// materializes a source or task worktree.
		return p.repository.Import(ctx, input)
	})
	if err != nil {
		return delivery.ArchiveInfo{}, err
	}
	if manifest.ID != id || manifest.ProjectID != p.scope.ProjectID {
		return delivery.ArchiveInfo{}, errors.New("recovered delivery archive belongs to another scope")
	}
	manifestHash, err := delivery.ManifestHash(manifest)
	if err != nil {
		return delivery.ArchiveInfo{}, err
	}
	info := delivery.ArchiveInfo{ID: id, SnapshotID: snapshot.ID, ManifestHash: manifestHash, SHA256: hex.EncodeToString(hash.Sum(nil)), Bytes: st.Size(), ChunkBytes: delivery.ChunkBytes, Manifest: manifest}
	if err := deliveryWriteJSON(filepath.Join(dir, "archive.json"), info); err != nil {
		return delivery.ArchiveInfo{}, err
	}
	return info, nil
}

type deliveryBoundWriter struct {
	w         io.Writer
	remaining int64
}

func (w *deliveryBoundWriter) Write(b []byte) (int, error) {
	if int64(len(b)) > w.remaining {
		return 0, errors.New("delivery archive quota exceeded")
	}
	n, e := w.w.Write(b)
	w.remaining -= int64(n)
	return n, e
}

func (m *Manager) deliveryPrepare(ctx context.Context, p *project, req deliveryRequest) (any, error) {
	if err := delivery.Validate(req.Manifest, false); err != nil {
		return nil, err
	}
	if req.Manifest.ID != req.DeliveryID || req.Manifest.ProjectID != p.scope.ProjectID {
		return nil, errors.New("delivery manifest scope mismatch")
	}
	root, err := deliveryRoot(p)
	if err != nil {
		return nil, err
	}
	used, count, _, err := deliveryQuota(root)
	if err != nil {
		return nil, err
	}
	dir, err := deliveryFolder(p, req.DeliveryID)
	if err != nil {
		return nil, err
	}
	var old delivery.ArchiveInfo
	if err = deliveryReadJSON(filepath.Join(dir, "archive.json"), &old); err == nil {
		a := req.Manifest
		a.PayloadBytes = old.Manifest.PayloadBytes
		a.PayloadSHA256 = old.Manifest.PayloadSHA256
		ah, _ := delivery.ManifestHash(a)
		if ah != old.ManifestHash {
			return nil, errors.New("delivery id already used for another manifest")
		}
		return old, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if count >= deliveryPackages {
		return nil, errors.New("delivery package capacity reached")
	}
	snapshot, err := p.repository.GetSnapshot(ctx, req.Manifest.SnapshotID)
	if err != nil {
		return nil, err
	}
	// Two simultaneous copies are needed while building a streaming tar envelope.
	estimate := snapshot.TotalBytes + int64(len(snapshot.Entries))*1536 + delivery.MaxManifestBytes + 8192
	if estimate > delivery.MaxArchiveBytes || used+estimate*2 > deliveryCacheBytes {
		return nil, errors.New("delivery export exceeds available cache quota")
	}
	payload, err := os.CreateTemp(dir, ".payload-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(payload.Name())
	defer payload.Close()
	ph := sha256.New()
	pw := &deliveryBoundWriter{w: io.MultiWriter(payload, ph), remaining: estimate}
	if err = p.repository.Export(ctx, snapshot.ID, pw); err != nil {
		return nil, err
	}
	st, err := payload.Stat()
	if err != nil {
		return nil, err
	}
	manifest := req.Manifest
	manifest.PayloadBytes = st.Size()
	manifest.PayloadSHA256 = hex.EncodeToString(ph.Sum(nil))
	if _, err = payload.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	out, err := os.CreateTemp(dir, ".archive-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	if err = out.Chmod(0600); err != nil {
		return nil, err
	}
	h := sha256.New()
	bw := &deliveryBoundWriter{w: io.MultiWriter(out, h), remaining: delivery.MaxArchiveBytes}
	if err = delivery.Write(ctx, bw, manifest, payload); err != nil {
		return nil, err
	}
	if err = out.Sync(); err != nil {
		return nil, err
	}
	st, err = out.Stat()
	if err != nil {
		return nil, err
	}
	if err = out.Close(); err != nil {
		return nil, err
	}
	if err = os.Rename(out.Name(), filepath.Join(dir, "archive.tar")); err != nil {
		return nil, err
	}
	mh, err := delivery.ManifestHash(manifest)
	if err != nil {
		return nil, err
	}
	info := delivery.ArchiveInfo{ID: req.DeliveryID, SnapshotID: snapshot.ID, ManifestHash: mh, SHA256: hex.EncodeToString(h.Sum(nil)), Bytes: st.Size(), ChunkBytes: delivery.ChunkBytes, Manifest: manifest}
	if err = deliveryWriteJSON(filepath.Join(dir, "archive.json"), info); err != nil {
		return nil, err
	}
	return info, nil
}

func (m *Manager) deliveryUpload(ctx context.Context, p *project, method string, req deliveryRequest) (any, error) {
	if err := ValidateID(req.TransferID); err != nil {
		return nil, err
	}
	root, err := deliveryRoot(p)
	if err != nil {
		return nil, err
	}
	if method == "project.delivery.upload.begin" {
		if req.TotalBytes < 2048 || req.TotalBytes > delivery.MaxArchiveBytes || len(req.SHA256) != 64 {
			return nil, errors.New("delivery import requires bounded size and SHA-256")
		}
		if b, e := hex.DecodeString(req.SHA256); e != nil || len(b) != 32 || strings.ToLower(req.SHA256) != req.SHA256 {
			return nil, errors.New("invalid import digest")
		}
		dir, e := deliveryFolder(p, req.TransferID)
		if e != nil {
			return nil, e
		}
		var existing deliveryTransfer
		if e := deliveryReadJSON(filepath.Join(dir, "upload.json"), &existing); e == nil {
			if existing.TotalBytes != req.TotalBytes || existing.SHA256 != req.SHA256 {
				return nil, errors.New("transfer id already used for another archive")
			}
			return existing, nil
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
		used, count, active, e := deliveryQuota(root)
		if e != nil {
			return nil, e
		}
		if count >= deliveryPackages || active >= deliveryUploads || used+req.TotalBytes+65536 > deliveryCacheBytes {
			return nil, errors.New("delivery transfer quota reached")
		}
		f, e := os.OpenFile(filepath.Join(dir, "upload.tar"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if errors.Is(e, os.ErrExist) {
			// Beginning has no external effect. An empty safe regular file with
			// no committed metadata is the exact recoverable pre-admission state.
			st, statErr := os.Lstat(filepath.Join(dir, "upload.tar"))
			if statErr != nil || !st.Mode().IsRegular() || st.Size() != 0 {
				return nil, errors.New("interrupted upload admission has uncommitted data; inspect the cache")
			}
			f, e = deliveryOpen(filepath.Join(dir, "upload.tar"), os.O_WRONLY)
		}
		if e != nil {
			return nil, e
		}
		e = f.Close()
		if e != nil {
			return nil, e
		}
		s := deliveryTransfer{ID: req.TransferID, TotalBytes: req.TotalBytes, SHA256: req.SHA256, Status: "uploading", UntrustedReview: true, UpdatedAt: time.Now().UTC()}
		if e = deliveryWriteJSON(filepath.Join(dir, "upload.json"), s); e != nil {
			return nil, e
		}
		return s, nil
	}
	dir, err := deliveryExistingFolder(p, req.TransferID)
	if err != nil {
		return nil, err
	}
	var s deliveryTransfer
	if err = deliveryReadJSON(filepath.Join(dir, "upload.json"), &s); err != nil {
		return nil, err
	}
	if s.ID != req.TransferID || s.Received < 0 || s.Received > s.TotalBytes {
		return nil, errors.New("invalid transfer metadata")
	}
	if s.Status == "uploading" && s.Received == s.TotalBytes &&
		(method == "project.delivery.upload.status" || method == "project.delivery.upload.finish") {
		recovered, found, err := recoverDeliveryCompletion(ctx, p, dir, s)
		if err != nil {
			return nil, err
		}
		if found {
			s = recovered
		}
	}
	if method == "project.delivery.upload.status" {
		return s, nil
	}
	if method == "project.delivery.upload.abort" {
		if s.Status == "completed" {
			return nil, errors.New("completed imports cannot be aborted")
		}
		if err = os.Remove(filepath.Join(dir, "upload.tar")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		s.Status = "aborted"
		s.UpdatedAt = time.Now().UTC()
		if err = deliveryWriteJSON(filepath.Join(dir, "upload.json"), s); err != nil {
			return nil, err
		}
		return s, nil
	}
	if s.Status == "completed" && method == "project.delivery.upload.finish" {
		return s, nil
	}
	if s.Status != "uploading" {
		return nil, errors.New("delivery transfer is not accepting data")
	}
	f, err := deliveryOpen(filepath.Join(dir, "upload.tar"), os.O_RDWR)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < s.Received {
		return nil, errors.New("committed delivery bytes were lost")
	}
	// A crash after fsync but before the metadata swap leaves an uncommitted tail.
	if st.Size() > s.Received {
		if err = f.Truncate(s.Received); err != nil {
			return nil, err
		}
	}
	if method == "project.delivery.upload.chunk" {
		if len(req.Base64) > base64.StdEncoding.EncodedLen(delivery.ChunkBytes) {
			return nil, errors.New("delivery chunk exceeds limit")
		}
		data, e := base64.StdEncoding.Strict().DecodeString(req.Base64)
		if e != nil || len(data) == 0 || len(data) > delivery.ChunkBytes {
			return nil, errors.New("invalid delivery chunk")
		}
		if req.Offset < 0 || req.Offset > s.Received || int64(len(data)) > s.TotalBytes-req.Offset {
			return nil, errors.New("delivery chunk is out of sequence")
		}
		if req.Offset < s.Received {
			if req.Offset+int64(len(data)) > s.Received {
				return nil, errors.New("delivery chunk overlaps committed boundary")
			}
			old := make([]byte, len(data))
			if _, e = f.ReadAt(old, req.Offset); e != nil {
				return nil, e
			}
			if !bytes.Equal(old, data) {
				return nil, errors.New("delivery retry bytes do not match committed chunk")
			}
			return s, nil
		}
		if _, e = f.WriteAt(data, req.Offset); e != nil {
			return nil, e
		}
		if e = f.Sync(); e != nil {
			return nil, e
		}
		s.Received += int64(len(data))
		s.UpdatedAt = time.Now().UTC()
		if e = deliveryWriteJSON(filepath.Join(dir, "upload.json"), s); e != nil {
			return nil, e
		}
		return s, nil
	}
	if s.Received != s.TotalBytes {
		return nil, errors.New("delivery upload is incomplete")
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return nil, err
	}
	if hex.EncodeToString(h.Sum(nil)) != s.SHA256 {
		return nil, errors.New("delivery archive digest mismatch")
	}
	manifest, snapshot, err := delivery.Import(ctx, f, s.TotalBytes, func(r io.Reader) (workspace.Snapshot, error) { return p.repository.Import(ctx, r) })
	if err != nil {
		return nil, err
	}
	// A retained private branch pins the import for repository GC. No source tree
	// is materialized and imported approvals never enter the execution database.
	if _, err = p.repository.CreateBranch(ctx, deliveryPinID(req.TransferID), snapshot.ID); err != nil {
		return nil, err
	}
	s.Status = "completed"
	s.SnapshotID = snapshot.ID
	s.Manifest = &manifest
	s.UpdatedAt = time.Now().UTC()
	if err = deliveryWriteJSON(filepath.Join(dir, "upload.json"), s); err != nil {
		return nil, err
	}
	return s, nil
}

// The private immutable pin is created only after the entire archive, workspace
// and digest have passed validation. It proves a crash between pin installation
// and transfer metadata publication can be reconciled without re-executing work.
func recoverDeliveryCompletion(ctx context.Context, p *project, dir string, s deliveryTransfer) (deliveryTransfer, bool, error) {
	pin, err := p.repository.GetBranch(ctx, deliveryPinID(s.ID))
	if errors.Is(err, workspace.ErrNotFound) {
		return s, false, nil
	}
	if err != nil {
		return s, false, err
	}
	if pin.Base != pin.Head {
		return s, false, errors.New("import recovery pin is not immutable")
	}
	f, err := deliveryOpen(filepath.Join(dir, "upload.tar"), os.O_RDONLY)
	if err != nil {
		return s, false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() != s.TotalBytes {
		return s, false, errors.New("import recovery archive is incomplete")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, checkedDeliveryReader{ctx: ctx, reader: f}); err != nil {
		return s, false, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != s.SHA256 {
		return s, false, errors.New("import recovery archive digest mismatch")
	}
	manifest, snapshot, err := delivery.Import(ctx, f, s.TotalBytes, func(io.Reader) (workspace.Snapshot, error) {
		return p.repository.GetSnapshot(ctx, pin.Base)
	})
	if err != nil {
		return s, false, err
	}
	s.Status, s.SnapshotID, s.Manifest = "completed", snapshot.ID, &manifest
	s.UntrustedReview = true
	s.UpdatedAt = time.Now().UTC()
	if err := deliveryWriteJSON(filepath.Join(dir, "upload.json"), s); err != nil {
		return s, false, err
	}
	return s, true, nil
}

type checkedDeliveryReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r checkedDeliveryReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(b)
}
