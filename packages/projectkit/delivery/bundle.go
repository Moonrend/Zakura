// SPDX-License-Identifier: AGPL-3.0-or-later
// Package delivery carries immutable workspace snapshots with their review provenance.
// Integrity hashes are not signatures: imported review statements are untrusted metadata.
package delivery

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

const Schema = "zakura.project-delivery"
const MaxManifestBytes = 4 << 20
const MaxArchiveBytes int64 = 768 << 20
const ChunkBytes = 128 << 10

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Review struct {
	ID              string          `json:"id"`
	Author          string          `json:"author"`
	Comment         string          `json:"comment"`
	PreviewID       string          `json:"previewId"`
	PreviewRevision int64           `json:"previewRevision"`
	Evidence        json.RawMessage `json:"evidence,omitempty"`
}

type Manifest struct {
	Schema        string                 `json:"schema"`
	Version       int                    `json:"version"`
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	Release       string                 `json:"release"`
	ProjectID     string                 `json:"projectId"`
	RunID         string                 `json:"runId"`
	SnapshotID    string                 `json:"snapshotId"`
	Goal          string                 `json:"goal"`
	Plan          mission.Plan           `json:"plan"`
	Checks        []mission.Verification `json:"checks"`
	Review        Review                 `json:"review"`
	CreatedAt     time.Time              `json:"createdAt"`
	PayloadSHA256 string                 `json:"payloadSha256"`
	PayloadBytes  int64                  `json:"payloadBytes"`
}

type ArchiveInfo struct {
	ID           string   `json:"id"`
	SnapshotID   string   `json:"snapshotId"`
	ManifestHash string   `json:"manifestHash"`
	SHA256       string   `json:"sha256"`
	Bytes        int64    `json:"bytes"`
	ChunkBytes   int      `json:"chunkBytes"`
	Manifest     Manifest `json:"manifest"`
}

func Validate(m Manifest, payloadRequired bool) error {
	if m.Schema != Schema || m.Version != 1 {
		return errors.New("unsupported delivery schema or version")
	}
	for _, id := range []string{m.ID, m.ProjectID, m.RunID, m.Review.ID, m.Review.PreviewID} {
		if !identifier.MatchString(id) {
			return errors.New("delivery identifiers are invalid")
		}
	}
	if !digest.MatchString(m.SnapshotID) {
		return errors.New("delivery snapshot digest is invalid")
	}
	if strings.TrimSpace(m.Name) == "" || len(m.Name) > 256 || strings.TrimSpace(m.Release) == "" || len(m.Release) > 128 || len(m.Goal) > 65536 || len(m.Review.Comment) > 4096 || len(m.Review.Author) > 256 || m.Review.PreviewRevision < 1 || m.CreatedAt.IsZero() {
		return errors.New("delivery metadata exceeds limits or lacks review provenance")
	}
	if len(m.Plan.Tasks) > 4096 || len(m.Checks) > 8192 {
		return errors.New("delivery plan or checks exceed limits")
	}
	if payloadRequired && (!digest.MatchString(m.PayloadSHA256) || m.PayloadBytes < 1024 || m.PayloadBytes > MaxArchiveBytes-(MaxManifestBytes+4096)) {
		return errors.New("delivery payload metadata is invalid")
	}
	raw, err := json.Marshal(m)
	if err != nil || len(raw) > MaxManifestBytes {
		return errors.New("delivery manifest exceeds limit")
	}
	return nil
}

func ManifestHash(m Manifest) (string, error) {
	if err := Validate(m, true); err != nil {
		return "", err
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), nil
}

type checkedReader struct {
	ctx context.Context
	r   io.Reader
}

func (r checkedReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Write emits only regular files with fixed names; it never stores host paths.
func Write(ctx context.Context, out io.Writer, m Manifest, payload io.Reader) error {
	if err := Validate(m, true); err != nil {
		return err
	}
	raw, _ := json.Marshal(m)
	tw := tar.NewWriter(out)
	if err := tw.WriteHeader(&tar.Header{Name: "delivery.json", Mode: 0600, Size: int64(len(raw)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(raw); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "workspace.tar", Mode: 0600, Size: m.PayloadBytes, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.CopyN(io.MultiWriter(tw, h), checkedReader{ctx, payload}, m.PayloadBytes)
	if err != nil || n != m.PayloadBytes {
		return errors.Join(errors.New("delivery payload is incomplete"), err)
	}
	var extra [1]byte
	if n, err := payload.Read(extra[:]); n != 0 || err != io.EOF {
		return errors.New("delivery payload exceeds declared length")
	}
	if hex.EncodeToString(h.Sum(nil)) != m.PayloadSHA256 {
		return errors.New("delivery payload digest mismatch")
	}
	return tw.Close()
}

type countedReader struct {
	r io.Reader
	n int64
}

func (r *countedReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.n += int64(n)
	return n, err
}

// Import validates the complete envelope and payload digest before invoking the
// content-addressed workspace importer. It never extracts archive filenames.
func Import(ctx context.Context, input io.ReaderAt, size int64, importSnapshot func(io.Reader) (workspace.Snapshot, error)) (Manifest, workspace.Snapshot, error) {
	var m Manifest
	var zero workspace.Snapshot
	if size < 2048 || size > MaxArchiveBytes {
		return m, zero, errors.New("delivery archive size exceeds limit")
	}
	cr := &countedReader{r: checkedReader{ctx, io.NewSectionReader(input, 0, size)}}
	tr := tar.NewReader(cr)
	header, err := tr.Next()
	if err != nil || header.Name != "delivery.json" || header.Typeflag != tar.TypeReg || header.Size < 2 || header.Size > MaxManifestBytes {
		return m, zero, errors.New("delivery manifest must be the first regular entry")
	}
	raw, err := io.ReadAll(io.LimitReader(tr, MaxManifestBytes+1))
	if err != nil {
		return m, zero, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&m); err != nil {
		return m, zero, errors.New("invalid delivery manifest")
	}
	var tail any
	if dec.Decode(&tail) != io.EOF {
		return m, zero, errors.New("delivery manifest has trailing JSON")
	}
	if err = Validate(m, true); err != nil {
		return m, zero, err
	}
	header, err = tr.Next()
	if err != nil || header.Name != "workspace.tar" || header.Typeflag != tar.TypeReg || header.Size != m.PayloadBytes {
		return m, zero, errors.New("delivery requires one bounded workspace payload")
	}
	offset := cr.n
	h := sha256.New()
	if err = validateWorkspaceEnvelope(ctx, input, offset, m.PayloadBytes, io.TeeReader(tr, h)); err != nil {
		return m, zero, err
	}
	if hex.EncodeToString(h.Sum(nil)) != m.PayloadSHA256 {
		return m, zero, errors.New("delivery payload digest mismatch")
	}
	// tar.Reader also accepts physical EOF immediately after the last payload.
	// A delivery envelope is complete only when both zero end blocks exist.
	endOffset := offset + ((m.PayloadBytes + 511) / 512 * 512)
	if endOffset > size-1024 {
		return m, zero, errors.New("delivery archive is missing its end markers")
	}
	var markers [1024]byte
	if _, err := input.ReadAt(markers[:], endOffset); err != nil {
		return m, zero, errors.New("delivery archive has incomplete end markers")
	}
	for _, b := range markers {
		if b != 0 {
			return m, zero, errors.New("delivery archive contains unexpected entries")
		}
	}
	if _, err = tr.Next(); err != io.EOF {
		return m, zero, errors.New("delivery archive contains unexpected entries")
	}
	// tar.Reader stops at the end marker; reject nonzero bytes after it too.
	buf := make([]byte, 32768)
	for {
		n, e := cr.Read(buf)
		for _, b := range buf[:n] {
			if b != 0 {
				return m, zero, errors.New("delivery archive has trailing data")
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return m, zero, e
		}
	}
	if importSnapshot == nil {
		return m, zero, errors.New("workspace importer is required")
	}
	snapshot, err := importSnapshot(checkedReader{ctx, io.NewSectionReader(input, offset, m.PayloadBytes)})
	if err != nil {
		return m, zero, fmt.Errorf("delivery workspace: %w", err)
	}
	if snapshot.ID != m.SnapshotID {
		return m, zero, errors.New("delivery snapshot does not match manifest")
	}
	return m, snapshot, nil
}

// The workspace importer validates content-addressed entries. This scan also
// certifies its complete tar envelope, since archive/tar otherwise ignores a
// nonzero trailer after the first pair of end blocks.
func validateWorkspaceEnvelope(ctx context.Context, input io.ReaderAt, offset, size int64, payload io.Reader) error {
	if size < 1024 || size%512 != 0 {
		return errors.New("workspace payload is not a complete block-aligned tar")
	}
	counted := &countedReader{r: checkedReader{ctx: ctx, r: payload}}
	reader := tar.NewReader(counted)
	lastEnd := int64(0)
	entries := 0
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("workspace payload has an invalid tar envelope")
		}
		entries++
		if entries > 100001 || header.Typeflag != tar.TypeReg {
			return errors.New("workspace payload contains an unsupported entry")
		}
		if entries == 1 {
			if header.Name != "manifest.json" {
				return errors.New("workspace payload must begin with its manifest")
			}
		} else if !strings.HasPrefix(header.Name, "objects/") || !digest.MatchString(strings.TrimPrefix(header.Name, "objects/")) {
			return errors.New("workspace payload contains an unexpected entry path")
		}
		if _, err := io.Copy(io.Discard, reader); err != nil {
			return err
		}
		lastEnd = counted.n
	}
	endOffset := (lastEnd + 511) / 512 * 512
	if entries == 0 || endOffset > size-1024 {
		return errors.New("workspace payload is missing its end markers")
	}
	var markers [1024]byte
	if _, err := input.ReadAt(markers[:], offset+endOffset); err != nil {
		return errors.New("workspace payload end markers are incomplete")
	}
	for _, b := range markers {
		if b != 0 {
			return errors.New("workspace payload has invalid end markers")
		}
	}
	buffer := make([]byte, 32768)
	for {
		n, err := counted.Read(buffer)
		for _, b := range buffer[:n] {
			if b != 0 {
				return errors.New("workspace payload has trailing nonzero data")
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
