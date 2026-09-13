package host

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

type ExecParams struct {
	Command    []string          `json:"command"`
	WorkingDir string            `json:"workingDir"`
	Env        map[string]string `json:"env"`
	TimeoutMs  int               `json:"timeoutMs"`
	Stdin      string            `json:"stdin"`
}

type ExecResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func Run(root string, p ExecParams) (ExecResult, error) {
	ctx := context.Background()
	if p.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(p.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	cmd, err := buildCmd(ctx, root, p)
	if err != nil {
		return ExecResult{}, err
	}
	var outB, errB bytes.Buffer
	cmd.Stdout = &outB
	cmd.Stderr = &errB
	if p.Stdin != "" {
		cmd.Stdin = bytes.NewBufferString(p.Stdin)
	}
	runErr := cmd.Run()
	code := 0
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			return ExecResult{Stdout: outB.String(), Stderr: errB.String(), ExitCode: 1}, runErr
		}
	}
	return ExecResult{ExitCode: code, Stdout: outB.String(), Stderr: errB.String()}, nil
}

func buildCmd(ctx context.Context, root string, p ExecParams) (*exec.Cmd, error) {
	if len(p.Command) == 0 {
		return nil, os.ErrInvalid
	}
	wd := root
	if p.WorkingDir != "" {
		j, err := Jail(root, p.WorkingDir)
		if err != nil {
			return nil, err
		}
		wd = j
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = windowsCmd(ctx, p.Command)
	} else {
		cmd = exec.CommandContext(ctx, p.Command[0], p.Command[1:]...)
	}
	cmd.Dir = wd
	cmd.Env = os.Environ()
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	return cmd, nil
}

func windowsCmd(ctx context.Context, command []string) *exec.Cmd {
	// 单条命令且看起来像 shell 片段时走 PowerShell；否则直接 exec。
	if len(command) == 1 {
		return exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command[0])
	}
	if command[0] == "cmd" || command[0] == "cmd.exe" {
		return exec.CommandContext(ctx, command[0], command[1:]...)
	}
	if command[0] == "powershell" || command[0] == "powershell.exe" || command[0] == "pwsh" {
		return exec.CommandContext(ctx, command[0], command[1:]...)
	}
	return exec.CommandContext(ctx, command[0], command[1:]...)
}

// Job 后台 exec，供终端轮询。
type Job struct {
	ID       string
	mu       sync.Mutex
	stdout   bytes.Buffer
	stderr   bytes.Buffer
	exitCode *int
	cmd      *exec.Cmd
	cancel   context.CancelFunc
}

type JobSnap struct {
	ID       string `json:"id"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode *int   `json:"exitCode"`
	Running  bool   `json:"running"`
}

type Registry struct {
	mu   sync.Mutex
	jobs map[string]*Job
}

func NewRegistry() *Registry {
	return &Registry{jobs: map[string]*Job{}}
}

func (r *Registry) Start(root string, p ExecParams) (*JobSnap, error) {
	ctx, cancel := context.WithCancel(context.Background())
	if p.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(p.TimeoutMs)*time.Millisecond)
	}
	cmd, err := buildCmd(ctx, root, p)
	if err != nil {
		cancel()
		return nil, err
	}
	j := &Job{ID: newID(), cmd: cmd, cancel: cancel}
	cmd.Stdout = &j.stdout
	cmd.Stderr = &j.stderr
	if p.Stdin != "" {
		cmd.Stdin = bytes.NewBufferString(p.Stdin)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	r.mu.Lock()
	r.jobs[j.ID] = j
	r.mu.Unlock()
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = 1
			}
		}
		j.mu.Lock()
		j.exitCode = &code
		j.mu.Unlock()
		cancel()
	}()
	return j.Snapshot(), nil
}

func (r *Registry) Get(id string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil {
		return nil
	}
	return j.Snapshot()
}

func (r *Registry) Kill(id string) *JobSnap {
	r.mu.Lock()
	j := r.jobs[id]
	r.mu.Unlock()
	if j == nil {
		return nil
	}
	j.cancel()
	if j.cmd.Process != nil {
		_ = j.cmd.Process.Kill()
	}
	return j.Snapshot()
}

func (j *Job) Snapshot() *JobSnap {
	j.mu.Lock()
	defer j.mu.Unlock()
	return &JobSnap{
		ID:       j.ID,
		Stdout:   j.stdout.String(),
		Stderr:   j.stderr.String(),
		ExitCode: j.exitCode,
		Running:  j.exitCode == nil,
	}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
