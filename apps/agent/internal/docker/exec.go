package docker

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

type ExecOptions struct {
	Stdin          string
	MaxOutputBytes int
}

type execOutputBudget struct {
	mu        sync.Mutex
	remaining int
	limited   bool
}

type execOutput struct {
	budget *execOutputBudget
	buffer bytes.Buffer
}

func (w *execOutput) Write(p []byte) (int, error) {
	w.budget.mu.Lock()
	defer w.budget.mu.Unlock()
	n := len(p)
	if w.budget.limited {
		n = min(n, w.budget.remaining)
		w.budget.remaining -= n
	}
	_, _ = w.buffer.Write(p[:n])
	return len(p), nil
}

func ExecWithOptions(ctx context.Context, id string, command []string, workdir string, env map[string]string, options ExecOptions) (stdout, stderr string, code int, err error) {
	if id == "" || len(command) == 0 || options.MaxOutputBytes < 0 || options.MaxOutputBytes > 16<<20 || len(options.Stdin) > 1<<20 {
		return "", "", 1, fmt.Errorf("invalid container execution options")
	}
	if err := Require(); err != nil {
		return "", "", 1, err
	}
	args := []string{"exec"}
	if options.Stdin != "" {
		args = append(args, "-i")
	}
	if workdir != "" {
		args = append(args, "-w", workdir)
	}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, id)
	args = append(args, command...)
	cmd := exec.CommandContext(ctx, dockerBin(), args...)
	budget := &execOutputBudget{remaining: options.MaxOutputBytes, limited: options.MaxOutputBytes > 0}
	out, errOut := &execOutput{budget: budget}, &execOutput{budget: budget}
	cmd.Stdout, cmd.Stderr = out, errOut
	if options.Stdin != "" {
		cmd.Stdin = strings.NewReader(options.Stdin)
	}
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return out.buffer.String(), errOut.buffer.String(), 1, ctx.Err()
	}
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			return out.buffer.String(), errOut.buffer.String(), 1, runErr
		}
	}
	return out.buffer.String(), errOut.buffer.String(), code, nil
}
