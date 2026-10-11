package contextpack

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

func safePath(p string) bool {
	return p != "" && p != "." && len(p) <= 4096 && utf8.ValidString(p) && !strings.ContainsAny(p, "\\\x00") && !path.IsAbs(p) && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../")
}
func validHash(s string) bool {
	if len(s) != 64 || strings.ToLower(s) != s {
		return false
	}
	_, e := hex.DecodeString(s)
	return e == nil
}
func validClaim(p string) bool {
	if p == "." || p == "**" || p == "./**" {
		return true
	}
	p = strings.TrimSuffix(p, "/**")
	return safePath(p) && !strings.ContainsAny(p, "*?[]{}")
}

// Claims use the same exact-path or directory/** form as project plans.
// A directory seed includes descendants, never its similarly named sibling.
func claimMatches(claim, file string) bool {
	if claim == "." || claim == "**" || claim == "./**" {
		return true
	}
	claim = strings.TrimSuffix(claim, "/**")
	return file == claim || strings.HasPrefix(file, claim+"/")
}
func Validate(req Request) error {
	if !validHash(req.SnapshotID) || len(req.Query) > 1024 || len(req.Prompt) > 8192 || !utf8.ValidString(req.Query) || !utf8.ValidString(req.Prompt) || len(req.Writes) > 64 || len(req.CheckPaths) > 128 {
		return ErrInvalid
	}
	if req.MaxBytes != 0 && (req.MaxBytes < MinOutputBytes || req.MaxBytes > MaxOutputBytes) {
		return ErrInvalid
	}
	seedBytes := 0
	for _, p := range req.Writes {
		if !validClaim(p) {
			return fmt.Errorf("%w: invalid write claim", ErrInvalid)
		}
		seedBytes += len(p)
	}
	for _, p := range req.CheckPaths {
		if !safePath(p) {
			return fmt.Errorf("%w: invalid check path", ErrInvalid)
		}
		seedBytes += len(p)
	}
	if seedBytes > 16384 {
		return fmt.Errorf("%w: seed paths exceed limit", ErrInvalid)
	}
	return nil
}

type memorySource struct {
	files    []semantic.InputFile
	contents map[string][]byte
}

func (s memorySource) Files(ctx context.Context, _ string) ([]semantic.InputFile, error) {
	return s.files, ctx.Err()
}
func (s memorySource) Read(ctx context.Context, _ string, p string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, ok := s.contents[p]
	if !ok {
		return nil, semantic.ErrNotFound
	}
	return data, nil
}

type document struct {
	entry   semantic.InputFile
	data    []byte
	terms   map[string]int
	hits    []hit
	length  int
	score   float64
	reasons []Reason
	meta    *semantic.File
}

func seedReasons(req Request, p string) []Reason {
	reasons := []Reason{}
	for _, claim := range req.Writes {
		if claimMatches(claim, p) {
			reasons = append(reasons, Reason{Kind: "seed_claim", Via: claim, Confidence: "exact_path"})
			break
		}
	}
	for _, check := range req.CheckPaths {
		if claimMatches(check, p) {
			reasons = append(reasons, Reason{Kind: "check_path", Via: check, Confidence: "exact_path"})
			break
		}
	}
	return reasons
}
func load(ctx context.Context, source semantic.Source, req Request, report *Pack) (memorySource, []*document, error) {
	entries, err := source.Files(ctx, req.SnapshotID)
	if err != nil {
		return memorySource{}, nil, err
	}
	// Workspace inventories are immutable manifests. Defend the reusable planner
	// against malicious alternate Source implementations as well.
	if len(entries) > 20000 {
		return memorySource{}, nil, fmt.Errorf("%w: inventory exceeds 20000 entries", ErrInvalid)
	}
	seen := map[string]bool{}
	ranks := map[string]int{}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return memorySource{}, nil, err
		}
		if !safePath(e.Path) || !validHash(e.Hash) || e.Size < 0 || seen[e.Path] {
			return memorySource{}, nil, fmt.Errorf("%w: invalid source inventory", ErrInvalid)
		}
		seen[e.Path] = true
		ranks[e.Path] = len(seedReasons(req, e.Path))
	}
	sort.Slice(entries, func(i, j int) bool {
		pi, pj := ranks[entries[i].Path], ranks[entries[j].Path]
		if pi != pj {
			return pi > pj
		}
		return entries[i].Path < entries[j].Path
	})
	for _, seed := range append(append([]string{}, req.Writes...), req.CheckPaths...) {
		if err := ctx.Err(); err != nil {
			return memorySource{}, nil, err
		}
		found := false
		for _, e := range entries {
			if claimMatches(seed, e.Path) {
				found = true
				break
			}
		}
		if !found {
			report.Missing = append(report.Missing, Missing{Path: seed, Reason: "absent_in_snapshot"})
			report.Partial = true
		}
	}
	mem := memorySource{files: []semantic.InputFile{}, contents: map[string][]byte{}}
	docs := []*document{}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return mem, nil, err
		}
		if report.ScannedFiles >= MaxFiles || e.Size > MaxFileBytes || report.ScannedBytes+e.Size > MaxInputBytes {
			report.Partial = true
			report.Truncated = true
			report.OmittedPaths = append(report.OmittedPaths, e.Path)
			continue
		}
		data, err := source.Read(ctx, req.SnapshotID, e.Path)
		if err != nil {
			return mem, nil, err
		}
		// Account actual bytes before trusting the manifest size, and verify CAS.
		report.ScannedFiles++
		report.ScannedBytes += int64(len(data))
		sum := sha256.Sum256(data)
		if int64(len(data)) != e.Size || hex.EncodeToString(sum[:]) != e.Hash {
			return mem, nil, fmt.Errorf("%w: immutable content digest mismatch", ErrInvalid)
		}
		if bytes.Contains(data, []byte{0}) || !utf8.Valid(data) {
			report.Partial = true
			report.Boundaries = append(report.Boundaries, Boundary{Path: e.Path, Kind: "non_text"})
			report.OmittedPaths = append(report.OmittedPaths, e.Path)
			continue
		}
		mem.files = append(mem.files, e)
		mem.contents[e.Path] = data
		docs = append(docs, &document{entry: e, data: data, reasons: seedReasons(req, e.Path)})
	}
	sort.Slice(mem.files, func(i, j int) bool { return mem.files[i].Path < mem.files[j].Path })
	return mem, docs, nil
}
