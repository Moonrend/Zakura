// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Use the runner's scoped job lifecycle so cancelling an agent run also cancels
// its container. Cleanup has a separate deadline and never falls back to host.
func runSandboxCommand(ctx context.Context, runner *runnerSession, params map[string]any) (result map[string]any, err error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	result = map[string]any{}
	startCtx, stopStart := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	err = runner.call(startCtx, "host.exec.start", params, &result)
	stopStart()
	if err != nil {
		return nil, fmt.Errorf("sandbox start could not be confirmed; any started job remains bounded by its timeout: %w", err)
	}
	id, _ := result["id"].(string)
	if id == "" {
		return nil, errors.New("runner did not return a sandbox job identity")
	}
	scoped := map[string]any{"id": id, "spaceId": params["spaceId"], "executionMode": "sandbox"}
	running := true
	defer func() {
		if !running {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if cleanupErr := cancelSandboxJob(cleanup, runner, scoped); cleanupErr != nil {
			result = nil
			err = errors.Join(err, errors.New("sandbox cancellation could not be confirmed; the job remains bounded by its timeout"))
		}
	}()
	for {
		if result["executionMode"] != "sandbox" || result["isolated"] != true {
			return nil, errors.New("runner did not confirm sandbox execution")
		}
		active, ok := result["running"].(bool)
		if !ok {
			return nil, errors.New("runner returned invalid sandbox lifecycle status")
		}
		if !active {
			if failure, _ := result["error"].(string); failure != "" {
				return nil, errors.New("sandbox execution failed; runner configuration or cleanup requires attention")
			}
			if result["exitCode"] == nil {
				return nil, errors.New("sandbox ended without an exit status")
			}
			running = false
			return result, nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("sandbox run interrupted: %w", ctx.Err())
		case <-timer.C:
		}
		result = map[string]any{}
		if err = runner.call(ctx, "host.exec.get", scoped, &result); err != nil {
			return nil, err
		}
	}
}

func cancelSandboxJob(ctx context.Context, runner *runnerSession, scoped map[string]any) error {
	method := "host.exec.kill"
	for {
		var state map[string]any
		if err := runner.call(ctx, method, scoped, &state); err != nil {
			return err
		}
		if state["executionMode"] != "sandbox" || state["isolated"] != true {
			return errors.New("unconfirmed sandbox cancellation")
		}
		running, ok := state["running"].(bool)
		if !ok {
			return errors.New("invalid sandbox cancellation status")
		}
		if !running {
			if failure, _ := state["error"].(string); failure != "" {
				return errors.New("sandbox cleanup was not confirmed")
			}
			return nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		method = "host.exec.get"
	}
}
