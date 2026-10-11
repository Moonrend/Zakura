// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"io/fs"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

func hashBytes(raw []byte) string            { hash := sha256.Sum256(raw); return hex.EncodeToString(hash[:]) }
func specHash(spec mission.CheckSpec) string { raw, _ := json.Marshal(spec); return hashBytes(raw) }
func resultHash(result mission.CheckResult) string {
	result.Evidence = nil
	raw, _ := json.Marshal(result)
	return hashBytes(raw)
}
func evidenceHash(e Evidence) string {
	e.ProofHash = ""
	raw, _ := json.Marshal(e)
	return hashBytes(raw)
}
func truncate(value string, limit int64) (string, bool) {
	if int64(len(value)) <= limit {
		return value, false
	}
	if limit <= 0 {
		return "", true
	}
	end := int(limit)
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end], true
}
func normalizeOptions(options Options) (Options, error) {
	if options.MaxFileBytes == 0 {
		options.MaxFileBytes = 4 << 20
	}
	if options.MaxOutputBytes == 0 {
		options.MaxOutputBytes = 64 << 10
	}
	if options.DefaultTimeout == 0 {
		options.DefaultTimeout = time.Minute
	}
	if options.MaxTimeout == 0 {
		options.MaxTimeout = 5 * time.Minute
	}
	if options.MaxChecks == 0 {
		options.MaxChecks = 256
	}
	if options.MaxFileBytes < 1 || options.MaxFileBytes > 64<<20 {
		return options, fmt.Errorf("max file bytes must be between 1 and 64 MiB")
	}
	if options.MaxOutputBytes < 1 || options.MaxOutputBytes > 1<<20 {
		return options, fmt.Errorf("max output bytes must be between 1 and 1 MiB")
	}
	if options.DefaultTimeout < time.Millisecond || options.MaxTimeout < time.Millisecond || options.MaxTimeout > time.Hour || options.DefaultTimeout > options.MaxTimeout {
		return options, fmt.Errorf("invalid acceptance timeout limits")
	}
	if options.MaxChecks < 1 || options.MaxChecks > 1000 {
		return options, fmt.Errorf("max checks must be between 1 and 1000")
	}
	return options, nil
}

func Evaluate(ctx context.Context, checks []mission.CheckSpec, environment Environment, options Options) (Report, error) {
	started := time.Now()
	report := Report{SnapshotID: environment.SnapshotID, Status: "passed", Checks: make([]mission.CheckResult, 0, len(checks))}
	if err := ValidateChecks(checks); err != nil {
		return report, err
	}
	normalized, err := normalizeOptions(options)
	if err != nil {
		return report, err
	}
	options = normalized
	if len(checks) > options.MaxChecks {
		return report, fmt.Errorf("acceptance checks exceed configured limit")
	}
	if strings.TrimSpace(environment.SnapshotID) == "" || len(environment.SnapshotID) > 4096 {
		return report, fmt.Errorf("immutable snapshot ID is required")
	}
	for _, spec := range checks {
		result := evaluateOne(ctx, spec, environment, options)
		report.Checks = append(report.Checks, result)
		if spec.Required {
			report.Required++
		}
		switch result.Status {
		case "passed":
			report.Passed++
		case "failed":
			report.Failed++
		case "error":
			report.Errors++
		}
		if spec.Required && result.Status != "passed" {
			report.Status = "failed"
		}
	}
	if report.Required == 0 {
		report.Status = "unverified"
	}
	report.DurationMS = time.Since(started).Milliseconds()
	return report, ctx.Err()
}
func evaluateOne(ctx context.Context, spec mission.CheckSpec, environment Environment, options Options) mission.CheckResult {
	start := time.Now()
	result := mission.CheckResult{ID: spec.ID, Kind: spec.Kind, Status: "error", Required: spec.Required}
	evidence := Evidence{Version: 1, SnapshotID: environment.SnapshotID, CheckID: spec.ID, SpecHash: specHash(spec)}
	fail := func(summary string) { result.Status = "failed"; result.Summary = summary }
	problem := func(err error) {
		result.Status = "error"
		result.Summary, _ = truncate(err.Error(), 4096)
		evidence.Detail = result.Summary
	}
	finish := func() mission.CheckResult {
		result.DurationMS = time.Since(start).Milliseconds()
		evidence.Status = result.Status
		evidence.ResultHash = resultHash(result)
		evidence.ProofHash = evidenceHash(evidence)
		result.Evidence, _ = json.Marshal(evidence)
		return result
	}
	if err := ctx.Err(); err != nil {
		evidence.Cancelled = true
		problem(err)
		return finish()
	}
	timeout := options.DefaultTimeout
	if spec.TimeoutSeconds > 0 {
		timeout = time.Duration(spec.TimeoutSeconds) * time.Second
	}
	if timeout > options.MaxTimeout {
		timeout = options.MaxTimeout
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if spec.Kind == "command" {
		if environment.Commands == nil {
			problem(fmt.Errorf("runner command executor is unavailable"))
			return finish()
		}
		request := CommandRequest{SnapshotID: environment.SnapshotID, CheckID: spec.ID, Argv: append([]string(nil), spec.Command...), Directory: ".", Timeout: timeout, MaxOutputBytes: options.MaxOutputBytes, NoNetwork: true}
		executed, err := environment.Commands.Execute(checkCtx, request)
		evidence.ExitCode = &executed.ExitCode
		evidence.NetworkDisabled = executed.NetworkDisabled
		evidence.TimedOut = executed.TimedOut || errors.Is(err, context.DeadlineExceeded) || errors.Is(checkCtx.Err(), context.DeadlineExceeded)
		evidence.Cancelled = executed.Cancelled || errors.Is(err, context.Canceled) || errors.Is(checkCtx.Err(), context.Canceled)
		evidence.OutputHash = hashBytes([]byte(executed.Stdout + "\x00" + executed.Stderr))
		output := executed.Stdout
		if executed.Stderr != "" {
			if output != "" {
				output += "\n"
			}
			output += "[stderr]\n" + executed.Stderr
		}
		result.Output, evidence.Truncated = truncate(output, options.MaxOutputBytes)
		evidence.Truncated = evidence.Truncated || executed.Truncated
		if evidence.Truncated {
			result.Output += "\n[output truncated]"
		}
		if err != nil {
			problem(fmt.Errorf("runner command failed: %w", err))
			return finish()
		}
		if checkCtx.Err() != nil {
			problem(checkCtx.Err())
			return finish()
		}
		if evidence.TimedOut || evidence.Cancelled {
			problem(fmt.Errorf("command did not complete"))
			return finish()
		}
		if executed.SnapshotID != environment.SnapshotID {
			problem(fmt.Errorf("runner command snapshot attestation does not match"))
			return finish()
		}
		if !executed.NetworkDisabled {
			problem(fmt.Errorf("runner did not attest network isolation"))
			return finish()
		}
		if executed.ExitCode != spec.ExpectedExitCode {
			fail(fmt.Sprintf("expected exit code %d, received %d", spec.ExpectedExitCode, executed.ExitCode))
			return finish()
		}
		result.Status = "passed"
		result.Summary = fmt.Sprintf("command exited with expected code %d", executed.ExitCode)
		return finish()
	}
	if environment.Files == nil {
		problem(fmt.Errorf("snapshot filesystem is unavailable"))
		return finish()
	}
	filename, _ := NormalizePath(spec.Path)
	evidence.Path = filename
	info, err := environment.Files.Stat(checkCtx, filename)
	missing := errors.Is(err, ErrNotFound) || errors.Is(err, fs.ErrNotExist)
	exists := err == nil
	evidence.Exists = &exists
	if err != nil && !missing {
		problem(fmt.Errorf("stat %s: %w", filename, err))
		return finish()
	}
	if checkCtx.Err() != nil {
		problem(checkCtx.Err())
		return finish()
	}
	if exists {
		evidence.IsDir = info.IsDir
		evidence.Size = info.Size
		if info.Size < 0 {
			problem(fmt.Errorf("snapshot returned a negative file size"))
			return finish()
		}
	}
	switch spec.Kind {
	case "path_exists":
		if !exists {
			fail("required path does not exist")
		} else {
			result.Status = "passed"
			result.Summary = "required path exists"
		}
		return finish()
	case "path_absent":
		if exists {
			fail("forbidden path exists")
		} else {
			result.Status = "passed"
			result.Summary = "forbidden path is absent"
		}
		return finish()
	}
	if !exists {
		fail("file does not exist; content checks require an existing file")
		return finish()
	}
	if info.IsDir {
		fail("content check requires a regular file")
		return finish()
	}
	if info.Size > options.MaxFileBytes {
		evidence.Truncated = true
		problem(fmt.Errorf("file size %d exceeds acceptance limit %d", info.Size, options.MaxFileBytes))
		return finish()
	}
	raw, err := environment.Files.ReadFile(checkCtx, filename, options.MaxFileBytes+1)
	if err != nil {
		problem(fmt.Errorf("read %s: %w", filename, err))
		return finish()
	}
	if checkCtx.Err() != nil {
		problem(checkCtx.Err())
		return finish()
	}
	if int64(len(raw)) > options.MaxFileBytes {
		evidence.Truncated = true
		problem(fmt.Errorf("snapshot read exceeded acceptance byte limit"))
		return finish()
	}
	if int64(len(raw)) != info.Size {
		problem(fmt.Errorf("snapshot file size changed during read"))
		return finish()
	}
	evidence.ContentHash = hashBytes(raw)
	if info.ContentHash != "" && info.ContentHash != evidence.ContentHash {
		problem(fmt.Errorf("snapshot content hash does not match runner metadata"))
		return finish()
	}
	if !utf8.Valid(raw) {
		fail("content is not valid UTF-8")
		return finish()
	}
	content := string(raw)
	switch spec.Kind {
	case "text_contains":
		if !strings.Contains(content, spec.Pattern) {
			fail("required text is missing")
		} else {
			result.Status = "passed"
			result.Summary = "required text found"
		}
	case "text_excludes":
		if strings.Contains(content, spec.Pattern) {
			fail("forbidden text was found")
		} else {
			result.Status = "passed"
			result.Summary = "forbidden text is absent"
		}
	case "regex":
		expression, _ := regexp.Compile(spec.Pattern)
		if !expression.Match(raw) {
			fail("regular expression did not match")
		} else {
			result.Status = "passed"
			result.Summary = "regular expression matched"
		}
	case "json_valid", "json_pointer":
		document, err := parseJSON(raw)
		if err != nil {
			fail("invalid JSON: " + err.Error())
			return finish()
		}
		if spec.Kind == "json_valid" {
			result.Status = "passed"
			result.Summary = "single unambiguous JSON document is valid"
			return finish()
		}
		rule, _ := parsePointerRule(spec.Pattern)
		selected, err := resolvePointer(document, rule.Segments)
		if err != nil {
			fail(err.Error())
			return finish()
		}
		if rule.Compare && !equalJSON(selected, rule.Expected) {
			fail("JSON pointer value differs from expected typed value")
			return finish()
		}
		result.Status = "passed"
		result.Summary = "JSON pointer resolved"
		if rule.Compare {
			result.Summary = "JSON pointer equals expected typed value"
		}
	default:
		problem(fmt.Errorf("unsupported check kind"))
	}
	return finish()
}
