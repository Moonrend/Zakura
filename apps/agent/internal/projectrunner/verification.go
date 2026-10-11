package projectrunner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/sandbox"
	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

// snapshotFiles is inaccessible to executed checks. Each command receives a
// separate materialization, so build output cannot change file-check evidence.
type snapshotFiles struct {
	root   string
	hashes map[string]string
}

func (f snapshotFiles) Stat(ctx context.Context, rel string) (acceptance.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return acceptance.FileInfo{}, err
	}
	safe, err := relative(rel, true)
	if err != nil {
		return acceptance.FileInfo{}, err
	}
	st, err := safeStat(f.root, safe)
	if errors.Is(err, os.ErrNotExist) {
		return acceptance.FileInfo{}, acceptance.ErrNotFound
	}
	if err != nil {
		return acceptance.FileInfo{}, err
	}
	info := acceptance.FileInfo{Size: st.Size(), IsDir: st.IsDir(), Mode: st.Mode().String()}
	if st.Mode().IsRegular() {
		info.ContentHash = f.hashes[safe]
	}
	return info, nil
}
func (f snapshotFiles) ReadFile(ctx context.Context, rel string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > MaxReadBytes+1 {
		return nil, errors.New("invalid acceptance read limit")
	}
	safe, err := relative(rel, false)
	if err != nil {
		return nil, err
	}
	st, err := safeStat(f.root, safe)
	if errors.Is(err, os.ErrNotExist) {
		return nil, acceptance.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("acceptance path is not a regular file")
	}
	if st.Size() > limit {
		return nil, errors.New("acceptance file exceeds limit")
	}
	file, err := os.Open(filepath.Join(f.root, filepath.FromSlash(safe)))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("acceptance file exceeds limit")
	}
	return data, ctx.Err()
}

func safeStat(root, relative string) (os.FileInfo, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil || canonical != absolute {
		return nil, workspace.ErrUnsafePath
	}
	current := absolute
	if relative != "" {
		for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
			if part == "" || part == "." {
				continue
			}
			if part == ".." {
				return nil, workspace.ErrUnsafePath
			}
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err != nil {
				return nil, err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return nil, workspace.ErrUnsafePath
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				return nil, workspace.ErrUnsafePath
			}
		}
	}
	return os.Lstat(current)
}

type checkExecutor struct {
	runner     Executor
	repository *workspace.Repository
	parent     string
	snapshotID string
}

func (e checkExecutor) Execute(ctx context.Context, req acceptance.CommandRequest) (acceptance.CommandResult, error) {
	result := acceptance.CommandResult{ExitCode: -1, NetworkDisabled: true, SnapshotID: e.snapshotID}
	if !req.NoNetwork || req.SnapshotID != e.snapshotID {
		return result, errors.New("acceptance command isolation or snapshot mismatch")
	}
	if req.Timeout <= 0 || req.Timeout > time.Duration(sandbox.MaxTimeoutMs)*time.Millisecond || req.MaxOutputBytes < 1 || req.MaxOutputBytes > MaxReadBytes {
		return result, errors.New("invalid acceptance command limits")
	}
	root, err := os.MkdirTemp(e.parent, "command-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(root)
	if err := e.repository.Materialize(ctx, e.snapshotID, root); err != nil {
		return result, err
	}
	execution, err := e.runner.Run(ctx, root, sandbox.ProjectExecParams{Command: append([]string(nil), req.Argv...), WorkingDir: req.Directory, TimeoutMs: int(req.Timeout / time.Millisecond)})
	result.TimedOut = execution.TimedOut
	result.Cancelled = execution.Cancelled
	result.ExitCode = execution.ExitCode
	result.Stdout, result.Stderr = execution.Stdout, execution.Stderr
	result.Truncated = execution.Truncated
	if int64(len(result.Stdout)) > req.MaxOutputBytes {
		result.Stdout = result.Stdout[:req.MaxOutputBytes]
		result.Truncated = true
	}
	if int64(len(result.Stderr)) > req.MaxOutputBytes {
		result.Stderr = result.Stderr[:req.MaxOutputBytes]
		result.Truncated = true
	}
	if execution.TimedOut {
		return result, errors.Join(err, errors.New("acceptance command timed out"))
	}
	if execution.Cancelled {
		return result, errors.Join(err, context.Canceled)
	}
	return result, err
}

func (m *Manager) verify(ctx context.Context, p *project, req Request) (any, error) {
	branch, err := p.repository.GetBranch(ctx, req.BranchID)
	if err != nil {
		return nil, err
	}
	snapshot, err := p.repository.CaptureBranch(ctx, req.BranchID, branch.Head)
	if err != nil {
		return nil, err
	}
	// No caller-provided directory participates in materialization or commands.
	parent := filepath.Join(p.root, "verification")
	root, err := os.MkdirTemp(parent, "files-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(root)
	if err := p.repository.Materialize(ctx, snapshot.ID, root); err != nil {
		return nil, err
	}
	hashes := make(map[string]string, len(snapshot.Entries))
	for _, entry := range snapshot.Entries {
		hashes[entry.Path] = entry.Hash
	}
	environment := acceptance.Environment{SnapshotID: snapshot.ID, Files: snapshotFiles{root: root, hashes: hashes}, Commands: checkExecutor{runner: m.executor, repository: p.repository, parent: parent, snapshotID: snapshot.ID}}
	report, err := acceptance.Evaluate(ctx, req.Checks, environment, acceptance.Options{MaxFileBytes: MaxReadBytes, MaxOutputBytes: sandbox.MaxOutputBytes, DefaultTimeout: 60 * time.Second, MaxTimeout: time.Duration(sandbox.MaxTimeoutMs) * time.Millisecond, MaxChecks: 128})
	if err != nil {
		return nil, fmt.Errorf("project acceptance verification failed: %w", err)
	}
	id, err := newID("v_")
	if err != nil {
		return nil, err
	}
	return report.Verification(id, "", req.BranchID, time.Now().UTC()), nil
}
