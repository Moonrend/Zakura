package runtime

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// computerContainerExec routes commands into the pinned computer's own
// container. There is no per-call restricted mode yet: CheckTarget refuses
// restricted requests before this runs, and a sandbox request here is a
// downgrade attempt that must fail closed.
func (h *handler) computerContainerExec(ctx context.Context, exec *resolvedExecution, mode string, executionTimeoutMS int64, command string, args ...string) (map[string]any, error) {
	if mode == "sandbox" {
		return nil, errors.New("restricted execution is unavailable on this computer; refusing downgrade")
	}
	if exec.computer.Provider == computers.E2B {
		return h.e2bComputerExec(ctx, exec, executionTimeoutMS, command, args...)
	}
	if exec.containerID == "" || exec.nodeID == "" {
		return nil, errors.New("computer runtime has no verified container")
	}
	session, err := h.hub.get(exec.nodeID)
	if err != nil {
		return nil, err
	}
	argv := append([]string{command}, args...)
	timeoutMS := executionTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 30_000
	}
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline).Milliseconds(); remaining > 0 {
			if executionTimeoutMS <= 0 || remaining < timeoutMS {
				timeoutMS = remaining
			}
		} else {
			return nil, context.DeadlineExceeded
		}
	}
	if executionTimeoutMS > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
		defer cancel()
	}
	result := map[string]any{}
	// docker.exec is synchronous on the runner and bounded by the RPC context.
	err = session.call(ctx, "docker.exec", map[string]any{
		"id": exec.containerID, "command": argv, "workingDir": "/workspace", "timeoutMs": timeoutMS,
	}, &result)
	if err != nil && result == nil {
		return nil, err
	}
	executionErr := err
	// A dedicated computer container isolates the workspace but does not apply
	// the restricted sandbox policy.
	result["executionMode"] = "workspace-container"
	result["isolated"] = true
	result["restrictedPolicyApplied"] = false
	if executionErr != nil {
		return result, executionErr
	}
	if code, ok := result["exitCode"].(float64); ok && code != 0 {
		return result, fmt.Errorf("command exited %d: %v", int(code), result["stderr"])
	}
	return result, nil
}
