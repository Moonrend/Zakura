// Package sandbox runs untrusted commands in disposable, restricted containers.
// Filesystem path checks are validation, not an OS isolation boundary.
package sandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const MaxOutputBytes = 256 * 1024
const MaxTimeoutMs = 300000
const MaxStdinBytes = 64 * 1024
const MaxJobs = 128
const MaxConcurrent = 4

var executionSlots = make(chan struct{}, MaxConcurrent)

// Enabled cannot be overridden by request or environment.
func Enabled() bool { return true }

type PolicyInfo struct {
	Enabled           bool   `json:"enabled"`
	Backend           string `json:"backend"`
	ImageConfigured   bool   `json:"imageConfigured"`
	Network           string `json:"network"`
	WorkspaceReadOnly bool   `json:"workspaceReadOnly"`
	MaxTimeoutMs      int    `json:"maxTimeoutMs"`
	MaxOutputBytes    int    `json:"maxOutputBytes"`
	MemoryBytes       int64  `json:"memoryBytes"`
	PidsLimit         int    `json:"pidsLimit"`
}

func Policy() PolicyInfo {
	return PolicyInfo{Enabled(), "docker", os.Getenv("ZAKURA_SANDBOX_IMAGE") != "", "none", true, MaxTimeoutMs, MaxOutputBytes, 512 * 1024 * 1024, 64}
}

type ExecParams struct {
	Command    []string          `json:"command"`
	WorkingDir string            `json:"workingDir"`
	Env        map[string]string `json:"env"`
	TimeoutMs  int               `json:"timeoutMs"`
	Stdin      string            `json:"stdin"`
}
type ExecResult struct {
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Cancelled bool   `json:"cancelled"`
	Truncated bool   `json:"truncated"`
}

type cappedWriter struct {
	mu        sync.Mutex
	b         bytes.Buffer
	truncated bool
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	remaining := MaxOutputBytes - w.b.Len()
	if len(p) > remaining {
		p = p[:remaining]
		w.truncated = true
	}
	_, _ = w.b.Write(p)
	return n, nil
}
func (w *cappedWriter) snapshot() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String(), w.truncated
}

// buildArgs deliberately accepts no client-provided mounts, user, network or image.
func buildArgs(root string, p ExecParams, name string) ([]string, error) {
	image := strings.TrimSpace(os.Getenv("ZAKURA_SANDBOX_IMAGE"))
	if image == "" || strings.HasPrefix(image, "-") || strings.ContainsAny(image, "\x00\r\n\t ") {
		return nil, errors.New("sandbox requires an operator-configured ZAKURA_SANDBOX_IMAGE")
	}
	if len(p.Command) == 0 || len(p.Command) > 256 || p.Command[0] == "" {
		return nil, errors.New("sandbox command is required")
	}
	size := 0
	for _, v := range p.Command {
		size += len(v)
		if strings.ContainsRune(v, 0) {
			return nil, errors.New("invalid command")
		}
	}
	if size > 64*1024 || len(p.Stdin) > MaxStdinBytes {
		return nil, errors.New("sandbox input limit exceeded")
	}
	if len(p.Env) > 0 {
		return nil, errors.New("sandbox does not accept client environment variables")
	}
	if p.TimeoutMs < 0 || p.TimeoutMs > MaxTimeoutMs {
		return nil, errors.New("sandbox timeout exceeds policy")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("sandbox workspace: %w", err)
	}
	if canonical != absolute {
		return nil, errors.New("sandbox workspace must not contain symlink ancestors")
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return nil, errors.New("sandbox workspace must be a directory")
	}
	if canonical == filepath.VolumeName(canonical)+string(filepath.Separator) || strings.ContainsAny(canonical, ",\r\n") {
		return nil, errors.New("unsafe sandbox workspace root")
	}
	// Do not expose host IPC or device endpoints through the workspace mount.
	// This check is defense in depth: operators must prevent concurrent host-side
	// mutation of the validated workspace while a sandbox is running.
	entries := 0
	if err := filepath.WalkDir(canonical, func(_ string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		entries++
		if entries > 100000 {
			return errors.New("sandbox workspace entry limit exceeded")
		}
		if d.Type()&(os.ModeSocket|os.ModeDevice|os.ModeNamedPipe) != 0 {
			return errors.New("sandbox workspace contains a special file")
		}
		return nil
	}); err != nil {
		return nil, err
	}
	wd := "/workspace"
	if p.WorkingDir != "" {
		requested := p.WorkingDir
		if requested == "/workspace" {
			requested = canonical
		} else if strings.HasPrefix(requested, "/workspace/") {
			requested = filepath.Join(canonical, filepath.FromSlash(strings.TrimPrefix(requested, "/workspace/")))
		}
		if !filepath.IsAbs(requested) {
			requested = filepath.Join(canonical, requested)
		}
		resolved, err := filepath.EvalSymlinks(requested)
		if err != nil {
			return nil, fmt.Errorf("sandbox working directory: %w", err)
		}
		rel, err := filepath.Rel(canonical, resolved)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, errors.New("working directory is outside workspace")
		}
		stat, err := os.Stat(resolved)
		if err != nil || !stat.IsDir() {
			return nil, errors.New("working directory must be a directory")
		}
		if rel != "." {
			wd += "/" + filepath.ToSlash(rel)
		}
	}
	return append([]string{"create", "--name", name, "--pull=never", "--rm", "--init", "--network=none", "--no-healthcheck", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--ulimit=nofile=256:256", "--ulimit=core=0:0", "--ipc=none", "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777", "--mount", "type=bind,src=" + canonical + ",dst=/workspace,readonly,bind-propagation=rprivate,bind-recursive=disabled", "--workdir", wd, "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--entrypoint", p.Command[0], "-i", image}, p.Command[1:]...), nil
}

// The Docker client receives no inherited credentials, proxy or application secrets.
// Only a local default daemon is supported; remote/context overrides are excluded.
func dockerCommand(ctx context.Context, bin string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "DOCKER_CONFIG=/nonexistent"}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func Run(ctx context.Context, root string, p ExecParams) (ExecResult, error) {
	return run(ctx, root, p, &cappedWriter{}, &cappedWriter{})
}
func run(ctx context.Context, root string, p ExecParams, out, errout *cappedWriter) (result ExecResult, runErr error) {
	select {
	case executionSlots <- struct{}{}:
		defer func() { <-executionSlots }()
	default:
		return result, errors.New("sandbox concurrent execution limit reached")
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return result, err
	}
	name := "zakura-sandbox-" + hex.EncodeToString(id[:])
	args, err := buildArgs(root, p, name)
	if err != nil {
		return result, err
	}
	bin, err := exec.LookPath("docker")
	if err != nil {
		return result, errors.New("sandbox Docker backend unavailable; host execution refused")
	}
	timeout := p.TimeoutMs
	if timeout == 0 {
		timeout = MaxTimeoutMs
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	defer func() {
		result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		result.Cancelled = errors.Is(ctx.Err(), context.Canceled)
	}()

	// Killing the CLI alone does not terminate its container. Always remove the
	// named container with a separate bounded context, including create/start races.
	defer func() {
		cleanCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		clean := dockerCommand(cleanCtx, bin, "rm", "--force", name)
		var diagnostic cappedWriter
		clean.Stdout = &diagnostic
		clean.Stderr = &diagnostic
		if e := clean.Run(); e != nil {
			// --rm already removes successfully finished containers. Confirm absence.
			probe := dockerCommand(cleanCtx, bin, "container", "ls", "--all", "--filter", "name=^/"+name+"$", "--format", "{{.ID}}")
			var check cappedWriter
			probe.Stdout = &check
			probe.Stderr = &cappedWriter{}
			pe := probe.Run()
			remaining, _ := check.snapshot()
			if pe != nil || strings.TrimSpace(remaining) != "" {
				runErr = errors.Join(runErr, errors.New("sandbox cleanup could not be verified; operator attention required"))
			}
		}
	}()
	// Image-declared volumes would allocate writable, unbounded daemon storage
	// despite --read-only. Approved images must not declare any volumes.
	inspect := dockerCommand(ctx, bin, "image", "inspect", "--format", "{{json .Config.Volumes}}", strings.TrimSpace(os.Getenv("ZAKURA_SANDBOX_IMAGE")))
	var imageVolumes cappedWriter
	inspect.Stdout = &imageVolumes
	inspect.Stderr = &cappedWriter{}
	if err := inspect.Run(); err != nil {
		return result, errors.New("sandbox image unavailable or policy inspection failed; host execution refused")
	}
	volumes, tooLarge := imageVolumes.snapshot()
	if tooLarge || (strings.TrimSpace(volumes) != "null" && strings.TrimSpace(volumes) != "{}") {
		return result, errors.New("sandbox image must not declare writable volumes")
	}
	// Creation is separate from start: a cancelled creation can at worst leave
	// a stopped container, never a running untracked command.
	create := dockerCommand(ctx, bin, args...)
	create.Stdout = &cappedWriter{}
	create.Stderr = errout
	if err := create.Run(); err != nil {
		result.ExitCode = -1
		result.Stderr, result.Truncated = errout.snapshot()
		result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		result.Cancelled = errors.Is(ctx.Err(), context.Canceled)
		if ctx.Err() != nil {
			return result, errors.New("sandbox creation interrupted; a stopped container may require operator cleanup: " + name)
		}
		return result, fmt.Errorf("sandbox container creation failed; host execution refused: %w", err)
	}
	cmd := dockerCommand(ctx, bin, "start", "--attach", "--interactive", name)
	cmd.Stdout = out
	cmd.Stderr = errout
	cmd.Stdin = strings.NewReader(p.Stdin)
	e := cmd.Run()
	result.Stdout, result.Truncated = out.snapshot()
	var truncated bool
	result.Stderr, truncated = errout.snapshot()
	result.Truncated = result.Truncated || truncated
	result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
	result.Cancelled = errors.Is(ctx.Err(), context.Canceled)
	if e != nil {
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			result.ExitCode = exit.ExitCode()
			if result.ExitCode == 125 {
				runErr = errors.New("sandbox container failed to start; host execution refused")
			}
		} else {
			result.ExitCode = -1
			runErr = fmt.Errorf("sandbox execution failed: %w", e)
		}
	}
	return result, runErr
}

type JobSnap struct {
	ID        string `json:"id"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  *int   `json:"exitCode"`
	Running   bool   `json:"running"`
	TimedOut  bool   `json:"timedOut"`
	Cancelled bool   `json:"cancelled"`
	Truncated bool   `json:"truncated"`
	Error     string `json:"error,omitempty"`
}
type job struct {
	mu          sync.Mutex
	id          string
	root        string
	out, errout cappedWriter
	cancel      context.CancelFunc
	result      *ExecResult
	err         error
}
type Registry struct {
	mu   sync.Mutex
	jobs map[string]*job
	next uint64
}

func NewRegistry() *Registry { return &Registry{jobs: make(map[string]*job)} }
func (r *Registry) Start(root string, p ExecParams) (*JobSnap, error) {
	if _, err := buildArgs(root, p, "validation"); err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return nil, errors.New("sandbox Docker backend unavailable; host execution refused")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Completed results are evicted before refusing further concurrent jobs.
	if len(r.jobs) >= MaxJobs {
		for id, j := range r.jobs {
			j.mu.Lock()
			done := j.result != nil
			j.mu.Unlock()
			if done {
				delete(r.jobs, id)
			}
		}
	}
	if len(r.jobs) >= MaxJobs {
		return nil, errors.New("sandbox concurrent job limit reached")
	}
	r.next++
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &job{id: hex.EncodeToString(random[:]) + "-" + strconv.FormatUint(r.next, 10), root: root, cancel: cancel}
	r.jobs[j.id] = j
	go func() {
		result, err := run(ctx, root, p, &j.out, &j.errout)
		j.mu.Lock()
		j.result = &result
		j.err = err
		j.mu.Unlock()
		cancel()
	}()
	return j.snapshot(), nil
}
func (j *job) snapshot() *JobSnap {
	j.mu.Lock()
	defer j.mu.Unlock()
	out, a := j.out.snapshot()
	stderr, b := j.errout.snapshot()
	s := &JobSnap{ID: j.id, Stdout: out, Stderr: stderr, Running: j.result == nil, Truncated: a || b}
	if j.result != nil {
		code := j.result.ExitCode
		s.ExitCode = &code
		s.TimedOut = j.result.TimedOut
		s.Cancelled = j.result.Cancelled
	}
	if j.err != nil {
		s.Error = j.err.Error()
	}
	return s
}
func (r *Registry) Get(id string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil {
		return nil
	}
	return j.snapshot()
}
func (r *Registry) Kill(id string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil {
		return nil
	}
	j.cancel()
	return j.snapshot()
}

// Scoped access binds a job to the validated caller workspace.
func (r *Registry) GetScoped(id, root string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil || j.root != root {
		return nil
	}
	return j.snapshot()
}
func (r *Registry) KillScoped(id, root string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil || j.root != root {
		return nil
	}
	j.cancel()
	return j.snapshot()
}
