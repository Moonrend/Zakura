package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const ProjectMaxWorkspaceBytes int64 = 512 << 20
const ProjectMaxWorkspaceFiles = 100000
const ProjectDiskCheckInterval = 100 * time.Millisecond

// ProjectExecParams contains only command inputs, never execution policy or mounts.
type ProjectExecParams struct {
	Command    []string `json:"command"`
	WorkingDir string   `json:"workingDir,omitempty"`
	TimeoutMs  int      `json:"timeoutMs,omitempty"`
	Stdin      string   `json:"stdin,omitempty"`
}

type ProjectPolicyInfo struct {
	MaxWorkspaceBytes      int64  `json:"maxWorkspaceBytes"`
	MaxWorkspaceFiles      int    `json:"maxWorkspaceFiles"`
	DiskEnforcement        string `json:"diskEnforcement"`
	Backend                string `json:"backend"`
	ImageConfigured        bool   `json:"imageConfigured"`
	Network                string `json:"network"`
	WorkspaceReadOnly      bool   `json:"workspaceReadOnly"`
	SourceWorkspaceMounted bool   `json:"sourceWorkspaceMounted"`
	ContainerRootReadOnly  bool   `json:"containerRootReadOnly"`
	MaxTimeoutMs           int    `json:"maxTimeoutMs"`
	MaxOutputBytes         int    `json:"maxOutputBytes"`
	MaxStdinBytes          int    `json:"maxStdinBytes"`
	MemoryBytes            int64  `json:"memoryBytes"`
	PidsLimit              int    `json:"pidsLimit"`
	ConcurrentLimit        int    `json:"concurrentLimit"`
}

func ProjectPolicy() ProjectPolicyInfo {
	return ProjectPolicyInfo{Backend: "docker", ImageConfigured: strings.TrimSpace(os.Getenv("ZAKURA_PROJECT_IMAGE")) != "", Network: "none", WorkspaceReadOnly: false, SourceWorkspaceMounted: false, ContainerRootReadOnly: true, MaxTimeoutMs: MaxTimeoutMs, MaxOutputBytes: MaxOutputBytes, MaxStdinBytes: MaxStdinBytes, MemoryBytes: 512 << 20, PidsLimit: 64, ConcurrentLimit: MaxConcurrent, MaxWorkspaceBytes: ProjectMaxWorkspaceBytes, MaxWorkspaceFiles: ProjectMaxWorkspaceFiles, DiskEnforcement: "preflight, 100ms watchdog and postflight; filesystem quotas required for strict allocation limits"}
}

// BuildProjectArgs never receives a caller-controlled root. The runner resolves
// an opaque branch ID to this local path while holding its project lock.
func BuildProjectArgs(root string, p ProjectExecParams, name string) ([]string, error) {
	image := strings.TrimSpace(os.Getenv("ZAKURA_PROJECT_IMAGE"))
	if image == "" || strings.HasPrefix(image, "-") || strings.ContainsAny(image, "\x00\r\n\t ") {
		return nil, errors.New("project execution requires an operator-configured ZAKURA_PROJECT_IMAGE")
	}
	if len(p.Command) == 0 || len(p.Command) > 256 || p.Command[0] == "" {
		return nil, errors.New("project command is required")
	}
	input := 0
	for _, arg := range p.Command {
		input += len(arg)
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("invalid project command")
		}
	}
	if input > 64<<10 || len(p.Stdin) > MaxStdinBytes {
		return nil, errors.New("project execution input limit exceeded")
	}
	if p.TimeoutMs < 0 || p.TimeoutMs > MaxTimeoutMs {
		return nil, errors.New("project execution timeout exceeds policy")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, errors.New("project branch unavailable")
	}
	if canonical != absolute || canonical == filepath.VolumeName(canonical)+string(filepath.Separator) || strings.ContainsAny(canonical, ",\r\n") {
		return nil, errors.New("unsafe project branch root")
	}
	count := 0
	err = filepath.WalkDir(canonical, func(_ string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		count++
		if count > 100000 {
			return errors.New("project branch entry limit exceeded")
		}
		if d.Type()&(os.ModeSymlink|os.ModeSocket|os.ModeDevice|os.ModeNamedPipe) != 0 {
			return errors.New("project branch contains a symlink or special file")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := checkProjectResources(canonical); err != nil {
		return nil, err
	}
	if st, e := os.Stat(canonical); e != nil || !st.IsDir() {
		return nil, errors.New("project branch is not a directory")
	}
	wd := strings.ReplaceAll(p.WorkingDir, "\\", "/")
	if wd == "" || wd == "." || wd == "/workspace" {
		wd = ""
	} else if strings.HasPrefix(wd, "/workspace/") {
		wd = strings.TrimPrefix(wd, "/workspace/")
	}
	if strings.HasPrefix(wd, "/") || strings.Contains(wd, ":") || strings.ContainsAny(wd, "\x00\r\n") {
		return nil, errors.New("project working directory must be relative")
	}
	for _, part := range strings.Split(wd, "/") {
		if part == ".." {
			return nil, errors.New("project working directory escapes branch")
		}
	}
	hostWD := filepath.Join(canonical, filepath.FromSlash(wd))
	resolved, e := filepath.EvalSymlinks(hostWD)
	if e != nil || resolved != hostWD {
		return nil, errors.New("project working directory is unavailable or contains symlinks")
	}
	st, e := os.Stat(hostWD)
	if e != nil || !st.IsDir() {
		return nil, errors.New("project working directory is not a directory")
	}
	if os.Getuid() < 0 || os.Getgid() < 0 {
		return nil, errors.New("project Docker execution requires POSIX UID/GID support")
	}
	user := strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid())
	args := []string{"create", "--name", name, "--pull=never", "--init", "--network=none", "--no-healthcheck", "--read-only", "--user=" + user, "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--ulimit=nofile=256:256", "--ulimit=core=0:0", "--ulimit=fsize=8388608:8388608", "--ipc=none", "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777", "--mount", "type=bind,src=" + canonical + ",dst=/workspace,bind-propagation=rprivate,bind-recursive=disabled", "--workdir", "/workspace"}
	if wd != "" {
		args[len(args)-1] = "/workspace/" + wd
	}
	args = append(args, "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--entrypoint", p.Command[0], "-i", image)
	return append(args, p.Command[1:]...), nil
}

// RunProject executes in a disposable restricted container. It never falls back
// to host.Run and it never mounts the source workspace or project repository.
func RunProject(parent context.Context, root string, p ProjectExecParams) (result ExecResult, runErr error) {
	result.ExitCode = -1
	select {
	case executionSlots <- struct{}{}:
		defer func() { <-executionSlots }()
	case <-parent.Done():
		return result, parent.Err()
	default:
		return result, errors.New("project concurrent execution limit reached")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return result, err
	}
	name := "zakura-project-" + hex.EncodeToString(random[:])
	args, err := BuildProjectArgs(root, p, name)
	if err != nil {
		return result, err
	}
	bin, err := exec.LookPath("docker")
	if err != nil {
		return result, errors.New("project Docker backend unavailable; host execution refused")
	}
	timeout := p.TimeoutMs
	if timeout == 0 {
		timeout = MaxTimeoutMs
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	quotaErrors := make(chan error, 1)
	watchCtx, stopWatch := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(ProjectDiskCheckInterval)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				if err := checkProjectResources(root); err != nil {
					quotaErrors <- err
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		stopWatch()
		<-watchDone
		select {
		case quotaErr := <-quotaErrors:
			runErr = errors.Join(runErr, quotaErr)
		default:
		}
	}()
	// Cleanup has an independent deadline: a canceled CLI must not strand work.
	defer func() {
		cleanCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		clean := dockerCommand(cleanCtx, bin, "rm", "--force", name)
		clean.Stdout = &cappedWriter{}
		clean.Stderr = &cappedWriter{}
		if e := clean.Run(); e != nil {
			probe := dockerCommand(cleanCtx, bin, "container", "ls", "--all", "--filter", "name=^/"+name+"$", "--format", "{{.ID}}")
			var output cappedWriter
			probe.Stdout = &output
			probe.Stderr = &cappedWriter{}
			pe := probe.Run()
			remaining, truncated := output.snapshot()
			if pe != nil || truncated || strings.TrimSpace(remaining) != "" {
				runErr = errors.Join(runErr, errors.New("project container cleanup could not be verified; operation outcome is uncertain"))
			}
		}
	}()
	// Capture execution cancellation before independent cleanup can consume time.
	defer func() {
		result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		result.Cancelled = errors.Is(ctx.Err(), context.Canceled)
	}()
	inspect := dockerCommand(ctx, bin, "image", "inspect", "--format", "{{.Id}}\n{{json .Config.Volumes}}", strings.TrimSpace(os.Getenv("ZAKURA_PROJECT_IMAGE")))
	var volumes cappedWriter
	inspect.Stdout = &volumes
	inspect.Stderr = &cappedWriter{}
	if e := inspect.Run(); e != nil {
		return result, errors.New("project image unavailable or isolation inspection failed; host execution refused")
	}
	inspected, truncated := volumes.snapshot()
	imageID, declared, ok := strings.Cut(strings.TrimSpace(inspected), "\n")
	if !ok || !strings.HasPrefix(imageID, "sha256:") || len(imageID) != 71 {
		return result, errors.New("project image inspection returned an invalid immutable image ID")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(imageID, "sha256:")); err != nil {
		return result, errors.New("invalid project image ID")
	}
	args[len(args)-len(p.Command)] = imageID
	if truncated || (strings.TrimSpace(declared) != "null" && strings.TrimSpace(declared) != "{}") {
		return result, errors.New("project image must not declare writable volumes")
	}
	var out, errout cappedWriter
	create := dockerCommand(ctx, bin, args...)
	create.Stdout = &cappedWriter{}
	create.Stderr = &errout
	if e := create.Run(); e != nil {
		result.Stderr, result.Truncated = errout.snapshot()
		return result, fmt.Errorf("project container creation failed: %w", e)
	}
	cmd := dockerCommand(ctx, bin, "start", "--attach", "--interactive", name)
	cmd.Stdout = &out
	cmd.Stderr = &errout
	cmd.Stdin = strings.NewReader(p.Stdin)
	e := cmd.Run()
	result.Stdout, result.Truncated = out.snapshot()
	var limited bool
	result.Stderr, limited = errout.snapshot()
	result.Truncated = result.Truncated || limited
	if quotaErr := checkProjectResources(root); quotaErr != nil {
		return result, quotaErr
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	// The CLI's status is not the workload's exit status. Inspect the stopped
	// container before independent cleanup, including legitimate exit code 125.
	stateCmd := dockerCommand(ctx, bin, "inspect", "--format", "{{json .State}}", name)
	var stateOutput cappedWriter
	stateCmd.Stdout = &stateOutput
	stateCmd.Stderr = &cappedWriter{}
	if err := stateCmd.Run(); err != nil {
		return result, errors.New("project workload exit status could not be inspected")
	}
	encoded, limited := stateOutput.snapshot()
	var state struct {
		Running   bool   `json:"Running"`
		Status    string `json:"Status"`
		ExitCode  int    `json:"ExitCode"`
		Error     string `json:"Error"`
		OOMKilled bool   `json:"OOMKilled"`
	}
	if limited || json.Unmarshal([]byte(encoded), &state) != nil || state.Running || state.Status != "exited" {
		return result, errors.New("project workload did not reach a confirmed exit state")
	}
	result.ExitCode = state.ExitCode
	if state.Error != "" {
		return result, errors.New("project container runtime reported a workload startup error")
	}
	if state.OOMKilled {
		result.Stderr += "\n[project workload exceeded its memory limit]"
	}
	if e != nil {
		var exit *exec.ExitError
		if !errors.As(e, &exit) {
			runErr = fmt.Errorf("project container attachment failed: %w", e)
		}
	}

	return result, runErr
}

func checkProjectResources(root string) error {
	files := 0
	var bytes int64
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return errors.New("project branch resource inspection failed")
		}
		files++
		if files > ProjectMaxWorkspaceFiles {
			return errors.New("project branch file limit exceeded")
		}
		if entry.Type()&(os.ModeSymlink|os.ModeSocket|os.ModeDevice|os.ModeNamedPipe) != 0 {
			return errors.New("project branch contains a symlink or special file")
		}
		if entry.IsDir() {
			return nil
		}
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("project branch resource inspection failed")
		}
		if info.Size() < 0 || info.Size() > 8<<20 {
			return errors.New("project branch single-file limit exceeded")
		}
		if info.Size() > ProjectMaxWorkspaceBytes-bytes {
			return errors.New("project branch disk limit exceeded")
		}
		bytes += info.Size()
		return nil
	})
}
