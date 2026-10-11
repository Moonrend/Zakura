package projectrunner

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/internal/sandbox"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

type Request struct {
	Scope
	ActivityIDs      []string               `json:"activityIds,omitempty"`
	Comment          string                 `json:"comment,omitempty"`
	OperationID      string                 `json:"operationId,omitempty"`
	BranchID         string                 `json:"branchId,omitempty"`
	BranchIDs        []string               `json:"branchIds,omitempty"`
	SnapshotID       string                 `json:"snapshotId,omitempty"`
	BaseSnapshot     string                 `json:"baseSnapshot,omitempty"`
	Snapshots        []string               `json:"snapshots,omitempty"`
	Path             string                 `json:"path,omitempty"`
	OldPath          string                 `json:"oldPath,omitempty"`
	NewPath          string                 `json:"newPath,omitempty"`
	Content          *string                `json:"content,omitempty"`
	Base64           *string                `json:"base64,omitempty"`
	ExpectedRevision string                 `json:"expectedRevision,omitempty"`
	Recursive        bool                   `json:"recursive,omitempty"`
	OldText          string                 `json:"oldText,omitempty"`
	NewText          string                 `json:"newText,omitempty"`
	All              bool                   `json:"all,omitempty"`
	MaxBytes         int64                  `json:"maxBytes,omitempty"`
	PlanID           string                 `json:"planId,omitempty"`
	ExpectedBase     string                 `json:"expectedBase,omitempty"`
	ReviewSnapshot   string                 `json:"reviewSnapshot,omitempty"`
	Resolutions      []workspace.Resolution `json:"resolutions,omitempty"`
	ReviewID         string                 `json:"reviewId,omitempty"`
	Approved         bool                   `json:"approved,omitempty"`
	Checks           []mission.CheckSpec    `json:"checks,omitempty"`
	Command          []string               `json:"command,omitempty"`
	WorkingDir       string                 `json:"workingDir,omitempty"`
	TimeoutMs        int                    `json:"timeoutMs,omitempty"`
	Stdin            string                 `json:"stdin,omitempty"`
}

var methodFields = map[string]string{
	"project.source.activities": "",
	"project.source.confirm":    "operationId activityIds reviewId approved comment",
	"project.base":              "operationId",
	"project.snapshot":          "snapshotId",
	"project.snapshot.read":     "snapshotId path maxBytes",
	"project.compose":           "operationId baseSnapshot snapshots",
	"project.branch.create":     "operationId snapshotId branchId",
	"project.branch.read":       "branchId path maxBytes",
	"project.branch.list":       "branchId path",
	"project.branch.write":      "operationId branchId path content base64 expectedRevision",
	"project.branch.remove":     "operationId branchId path recursive",
	"project.branch.rename":     "operationId branchId oldPath newPath",
	"project.branch.patch":      "operationId branchId path expectedRevision oldText newText all",
	"project.branch.capture":    "operationId branchId",
	"project.branch.diff":       "baseSnapshot snapshotId",
	"project.merge.plan":        "operationId baseSnapshot snapshotId",
	"project.merge.resolve":     "operationId planId resolutions",
	"project.merge.apply":       "operationId planId expectedBase reviewId reviewSnapshot approved",
	"project.verify":            "operationId branchId checks",
	"project.exec":              "operationId branchId command workingDir timeoutMs stdin",
	"project.operation.inspect": "operationId",
	"project.branch.gc":         "operationId branchIds",
	"project.branches":          "",
	"project.policy":            "",
}

func decodeRequest(method string, raw json.RawMessage) (Request, error) {
	fields, ok := methodFields[method]
	if !ok {
		return Request{}, errors.New("unknown project RPC method")
	}
	if len(raw) == 0 || len(raw) > MaxRPCBytes {
		return Request{}, errors.New("project RPC input size exceeds limit")
	}
	// First inspect keys so fields valid for another RPC are still rejected.
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil || keys == nil {
		return Request{}, errors.New("project parameters must be a JSON object")
	}
	allowed := map[string]bool{"spaceId": true, "projectId": true}
	for _, key := range strings.Fields(fields) {
		allowed[key] = true
	}
	for key := range keys {
		if !allowed[key] {
			return Request{}, fmt.Errorf("unsupported project parameter %q", key)
		}
	}
	var req Request
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return Request{}, errors.New("invalid project RPC parameters")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return Request{}, errors.New("project RPC requires exactly one JSON object")
	}
	if err := req.Scope.Validate(); err != nil {
		return Request{}, err
	}
	return req, nil
}
func newID(prefix string) (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(random[:]), nil
}

// Dispatch serializes mutation, file access, and command execution per project.
// The authenticated server supplies scope; model tools can never pick host roots.
func (m *Manager) Dispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	if strings.HasPrefix(method, "project.context.") {
		return m.ContextDispatch(ctx, method, raw)
	}
	if strings.HasPrefix(method, "project.refactor.") {
		return m.RefactorDispatch(ctx, method, raw)
	}
	if strings.HasPrefix(method, "project.semantic.") {
		return m.SemanticDispatch(ctx, method, raw)
	}
	if strings.HasPrefix(method, "project.delivery.") {
		return m.DeliveryDispatch(ctx, method, raw)
	}
	if method == "project.snapshot.copy" {
		return m.SnapshotCopyDispatch(ctx, raw)
	}
	req, err := decodeRequest(method, raw)
	if err != nil {
		return nil, err
	}
	if err := protectImportPin(method, req); err != nil {
		return nil, err
	}
	if method == "project.operation.inspect" {
		return m.Inspect(req.Scope, req.OperationID)
	}
	p, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	fn := func() (any, error) { return m.perform(ctx, p, method, req) }
	if strings.Contains(" "+methodFields[method]+" ", " operationId ") {
		if err := ValidateID(req.OperationID); err != nil {
			return nil, errors.New("a valid operationId is required")
		}
		return runJournal(ctx, p, req.OperationID, method, raw, fn)
	}
	return fn()
}

func (m *Manager) perform(ctx context.Context, p *project, method string, req Request) (any, error) {
	repo := p.repository
	switch method {
	case "project.source.activities":
		activities, err := m.SourceActivities(req.SpaceID)
		return map[string]any{"activities": activities}, err
	case "project.source.confirm":
		return m.confirmSourceActivities(req)
	case "project.policy":
		return sandbox.ProjectPolicy(), nil
	case "project.base":
		unlock, err := m.LockPublication(req.SpaceID)
		if err != nil {
			return nil, err
		}
		defer unlock()
		if _, err := repo.Recover(ctx); err != nil {
			return nil, err
		}
		root, err := m.Source(req.Scope)
		if err != nil {
			return nil, err
		}
		snapshot, err := repo.Snapshot(ctx, root)
		if err != nil {
			return nil, err
		}
		return map[string]string{"snapshotId": snapshot.ID}, nil
	case "project.snapshot":
		return repo.GetSnapshot(ctx, req.SnapshotID)
	case "project.snapshot.read":
		rel, err := relative(req.Path, false)
		if err != nil {
			return nil, err
		}
		limit := req.MaxBytes
		if limit == 0 {
			limit = MaxReadBytes
		}
		if limit < 1 || limit > MaxReadBytes {
			return nil, errors.New("invalid project read limit")
		}
		content, err := repo.ReadSnapshot(ctx, req.SnapshotID, rel)
		if err != nil {
			return nil, err
		}
		if int64(len(content)) > limit {
			return nil, errors.New("snapshot file exceeds read limit")
		}
		return map[string]any{"snapshotId": req.SnapshotID, "path": rel, "content": string(content), "base64": base64.StdEncoding.EncodeToString(content), "size": len(content), "revision": revision(content)}, nil
	case "project.compose":
		if len(req.Snapshots) > 256 {
			return nil, errors.New("composition snapshot limit exceeded")
		}
		composition, err := repo.Compose(ctx, req.BaseSnapshot, req.Snapshots)
		if err != nil {
			return nil, err
		}
		if len(composition.Conflicts) > 0 {
			return map[string]any{"conflicts": composition.Conflicts, "plans": composition.Plans}, workspace.ErrUnresolved
		}
		return map[string]string{"snapshotId": composition.Snapshot.ID}, nil
	case "project.branch.create":
		id := req.BranchID
		if id == "" {
			var err error
			id, err = newID("b_")
			if err != nil {
				return nil, err
			}
		}
		if err := ValidateID(id); err != nil {
			return nil, errors.New("invalid branchId")
		}
		branch, err := repo.CreateBranch(ctx, id, req.SnapshotID)
		if err != nil {
			return nil, err
		}
		return map[string]string{"branchId": branch.ID, "snapshotId": branch.Head}, nil
	case "project.branches":
		branches, err := repo.ListBranches(ctx)
		return map[string]any{"branches": branches}, err
	case "project.branch.read":
		if _, err := repo.GetBranch(ctx, req.BranchID); err != nil {
			return nil, err
		}
		rel, err := relative(req.Path, false)
		if err != nil {
			return nil, err
		}
		limit := req.MaxBytes
		if limit == 0 {
			limit = MaxReadBytes
		}
		if limit < 1 || limit > MaxReadBytes {
			return nil, errors.New("invalid project read limit")
		}
		content, err := repo.Read(ctx, req.BranchID, rel)
		if err != nil {
			return nil, err
		}
		if int64(len(content)) > limit {
			return nil, errors.New("project file exceeds read limit")
		}
		return map[string]any{"path": rel, "content": string(content), "base64": base64.StdEncoding.EncodeToString(content), "size": len(content), "revision": revision(content)}, nil
	case "project.branch.list":
		rel, err := relative(req.Path, true)
		if err != nil {
			return nil, err
		}
		entries, err := repo.List(ctx, req.BranchID, rel)
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": rel, "entries": directoryEntries(rel, entries)}, nil
	case "project.branch.write":
		rel, err := relative(req.Path, false)
		if err != nil {
			return nil, err
		}
		content, err := decodeContent(req)
		if err != nil {
			return nil, err
		}
		if err := checkRevision(ctx, repo, req.BranchID, rel, req.ExpectedRevision); err != nil {
			return nil, err
		}
		if err := repo.Write(ctx, req.BranchID, rel, content, existingMode(ctx, repo, req.BranchID, rel)); err != nil {
			return nil, err
		}
		return map[string]string{"path": rel, "revision": revision(content)}, nil
	case "project.branch.remove":
		rel, err := relative(req.Path, false)
		if err != nil {
			return nil, err
		}
		if !req.Recursive {
			root, err := repo.BranchRoot(ctx, req.BranchID)
			if err != nil {
				return nil, err
			}
			info, err := safeStat(root, rel)
			if err != nil {
				return nil, err
			}
			if info.IsDir() {
				return nil, errors.New("directory removal requires recursive:true")
			}
		}
		err = repo.Remove(ctx, req.BranchID, rel)
		return map[string]bool{"ok": err == nil}, err
	case "project.branch.rename":
		old, err := relative(req.OldPath, false)
		if err != nil {
			return nil, err
		}
		next, err := relative(req.NewPath, false)
		if err != nil {
			return nil, err
		}
		err = repo.Rename(ctx, req.BranchID, old, next)
		return map[string]bool{"ok": err == nil}, err
	case "project.branch.patch":
		rel, err := relative(req.Path, false)
		if err != nil {
			return nil, err
		}
		if req.ExpectedRevision == "" {
			return nil, errors.New("patch requires expectedRevision")
		}
		if req.OldText == "" {
			return nil, errors.New("patch oldText must not be empty")
		}
		content, err := repo.Read(ctx, req.BranchID, rel)
		if err != nil {
			return nil, err
		}
		if revision(content) != req.ExpectedRevision {
			return nil, workspace.ErrConflict
		}
		count := bytes.Count(content, []byte(req.OldText))
		if count == 0 || (!req.All && count != 1) {
			return nil, errors.New("patch match must be unique unless all:true")
		}
		n := 1
		if req.All {
			n = -1
		}
		content = bytes.Replace(content, []byte(req.OldText), []byte(req.NewText), n)
		if len(content) > MaxReadBytes {
			return nil, errors.New("patched file exceeds limit")
		}
		if err := repo.Write(ctx, req.BranchID, rel, content, existingMode(ctx, repo, req.BranchID, rel)); err != nil {
			return nil, err
		}
		return map[string]string{"path": rel, "revision": revision(content)}, nil
	case "project.branch.capture":
		branch, err := repo.GetBranch(ctx, req.BranchID)
		if err != nil {
			return nil, err
		}
		snapshot, err := repo.CaptureBranch(ctx, req.BranchID, branch.Head)
		if err != nil {
			return nil, err
		}
		return map[string]string{"snapshotId": snapshot.ID}, nil
	case "project.branch.diff":
		return repo.Diff(ctx, req.BaseSnapshot, req.SnapshotID)
	case "project.merge.plan":
		unlock, err := m.LockPublication(req.SpaceID)
		if err != nil {
			return nil, err
		}
		defer unlock()
		if _, err := repo.Recover(ctx); err != nil {
			return nil, err
		}
		root, err := m.Source(req.Scope)
		if err != nil {
			return nil, err
		}
		current, err := repo.Snapshot(ctx, root)
		if err != nil {
			return nil, err
		}
		plan, err := repo.PlanMerge(ctx, req.BaseSnapshot, current.ID, req.SnapshotID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"planId": plan.ID, "expectedBase": current.ID, "plan": plan}, nil
	case "project.merge.resolve":
		plan, err := repo.GetMergePlan(ctx, req.PlanID)
		if err != nil {
			return nil, err
		}
		if len(req.Resolutions) > 10000 {
			return nil, errors.New("merge resolution limit exceeded")
		}
		id, err := newID("merge_")
		if err != nil {
			return nil, err
		}
		if _, err := repo.CreateBranch(ctx, id, plan.Ours); err != nil {
			return nil, err
		}
		resolved, err := repo.ApplyMerge(ctx, plan, req.Resolutions, id, plan.Ours)
		if err != nil {
			return nil, err
		}
		// The reviewed target is stored in a new immutable plan. Apply accepts no
		// resolutions or code bytes after the human has approved this target.
		next, err := repo.PlanMerge(ctx, plan.Ours, plan.Ours, resolved.Snapshot.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"planId": next.ID, "expectedBase": next.Ours, "plan": next, "originalPlanId": plan.ID}, nil
	case "project.merge.apply":
		if !req.Approved || ValidateID(req.ReviewID) != nil {
			return nil, noEffect(errors.New("merge requires an approved review supplied by the authenticated control plane"))
		}
		plan, err := repo.GetMergePlan(ctx, req.PlanID)
		if err != nil {
			return nil, err
		}
		if req.ExpectedBase == "" || req.ExpectedBase != plan.Ours || req.ReviewSnapshot != plan.Result.ID {
			return nil, noEffect(workspace.ErrConflict)
		}
		if len(plan.Conflicts) > 0 {
			return nil, noEffect(workspace.ErrUnresolved)
		}
		unlock, err := m.LockPublication(req.SpaceID)
		if err != nil {
			return nil, noEffect(err)
		}
		defer unlock()
		if _, err := repo.Recover(ctx); err != nil {
			return nil, err
		}
		root, err := m.Source(req.Scope)
		if err != nil {
			return nil, err
		}
		current, err := repo.Snapshot(ctx, root)
		if err != nil {
			return nil, noEffect(err)
		}
		if current.ID != req.ExpectedBase {
			return nil, noEffect(workspace.ErrConflict)
		}
		result, err := repo.ApplyToDirectory(ctx, req.ExpectedBase, plan.Result.ID, root)
		if err != nil {
			return nil, err
		}
		return map[string]any{"result": result, "reviewId": req.ReviewID, "snapshotId": result.Snapshot.ID}, nil
	case "project.verify":
		return m.verify(ctx, p, req)
	case "project.exec":
		root, err := repo.BranchRoot(ctx, req.BranchID)
		if err != nil {
			return nil, err
		}
		return m.executor.Run(ctx, root, sandbox.ProjectExecParams{Command: append([]string(nil), req.Command...), WorkingDir: req.WorkingDir, TimeoutMs: req.TimeoutMs, Stdin: req.Stdin})
	case "project.branch.gc":
		if len(req.BranchIDs) > 256 {
			return nil, errors.New("branch GC request limit exceeded")
		}
		removed := []string{}
		for _, id := range req.BranchIDs {
			branch, err := repo.GetBranch(ctx, id)
			if errors.Is(err, workspace.ErrNotFound) {
				continue
			}
			if err != nil {
				return map[string]any{"removed": removed}, err
			}
			if err := repo.DeleteBranch(ctx, id, branch.Head); err != nil {
				return map[string]any{"removed": removed}, err
			}
			removed = append(removed, id)
		}
		return map[string]any{"removed": removed}, nil
	}
	return nil, errors.New("unknown project method")
}

func relative(input string, allowRoot bool) (string, error) {
	rel := strings.ReplaceAll(input, "\\", "/")
	if rel == "/workspace" || rel == "/workspace/" {
		rel = ""
	} else if strings.HasPrefix(rel, "/workspace/") {
		rel = strings.TrimPrefix(rel, "/workspace/")
	}
	if len(rel) > 4096 || strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") || strings.ContainsRune(rel, 0) {
		return "", workspace.ErrUnsafePath
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", workspace.ErrUnsafePath
		}
	}
	clean := path.Clean(rel)
	if clean == "." {
		if allowRoot {
			return "", nil
		}
		return "", workspace.ErrUnsafePath
	}
	return clean, nil
}
func revision(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}
func decodeContent(req Request) ([]byte, error) {
	if req.Content != nil && req.Base64 != nil {
		return nil, errors.New("content and base64 are mutually exclusive")
	}
	if req.Content == nil && req.Base64 == nil {
		return nil, errors.New("content or base64 is required")
	}
	var content []byte
	if req.Base64 != nil {
		if len(*req.Base64) > ((MaxReadBytes+2)/3)*4 {
			return nil, errors.New("project content exceeds limit")
		}
		var err error
		content, err = base64.StdEncoding.Strict().DecodeString(*req.Base64)
		if err != nil {
			return nil, errors.New("invalid project content base64")
		}
	} else {
		content = []byte(*req.Content)
	}
	if len(content) > MaxReadBytes {
		return nil, errors.New("project content exceeds limit")
	}
	return content, nil
}
func checkRevision(ctx context.Context, repo *workspace.Repository, branch, rel, expected string) error {
	if expected == "" {
		return nil
	}
	content, err := repo.Read(ctx, branch, rel)
	if errors.Is(err, workspace.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		if expected == "missing" {
			return nil
		}
		return workspace.ErrConflict
	}
	if err != nil {
		return err
	}
	if revision(content) != expected {
		return workspace.ErrConflict
	}
	return nil
}

type DirectoryEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	Mode     uint32 `json:"mode,omitempty"`
	Revision string `json:"revision,omitempty"`
}

func directoryEntries(directory string, files []workspace.Entry) []DirectoryEntry {
	entries := map[string]DirectoryEntry{}
	prefix := ""
	if directory != "" {
		prefix = directory + "/"
	}
	for _, file := range files {
		if !strings.HasPrefix(file.Path, prefix) {
			continue
		}
		suffix := strings.TrimPrefix(file.Path, prefix)
		if suffix == "" {
			continue
		}
		name, rest, dir := strings.Cut(suffix, "/")
		_ = rest
		entry := DirectoryEntry{Name: name, Path: prefix + name, IsDir: dir}
		if !dir {
			entry.Size = file.Size
			entry.Mode = file.Mode
			entry.Revision = file.Hash
		}
		if prior, exists := entries[name]; exists && prior.IsDir {
			continue
		}
		entries[name] = entry
	}
	result := make([]DirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func existingMode(ctx context.Context, repo *workspace.Repository, branch, relative string) uint32 {
	root, err := repo.BranchRoot(ctx, branch)
	if err != nil {
		return 0644
	}
	info, err := safeStat(root, relative)
	if err != nil || !info.Mode().IsRegular() {
		return 0644
	}
	return uint32(info.Mode().Perm())
}
