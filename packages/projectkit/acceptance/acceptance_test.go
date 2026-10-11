// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"io/fs"
	"strings"
	"testing"
	"time"
)

type memoryFS struct {
	files     map[string][]byte
	dirs      map[string]bool
	statErr   error
	readExtra bool
}

func (m memoryFS) Stat(ctx context.Context, name string) (FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return FileInfo{}, err
	}
	if m.statErr != nil {
		return FileInfo{}, m.statErr
	}
	if m.dirs[name] {
		return FileInfo{IsDir: true}, nil
	}
	raw, exists := m.files[name]
	if !exists {
		return FileInfo{}, fmt.Errorf("%s: %w", name, fs.ErrNotExist)
	}
	return FileInfo{Size: int64(len(raw))}, nil
}
func (m memoryFS) ReadFile(ctx context.Context, name string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	raw, exists := m.files[name]
	if !exists {
		return nil, ErrNotFound
	}
	copy := append([]byte(nil), raw...)
	if m.readExtra {
		copy = append(copy, 'x')
	}
	return copy, nil
}

type commandFunc func(context.Context, CommandRequest) (CommandResult, error)

func (f commandFunc) Execute(ctx context.Context, request CommandRequest) (CommandResult, error) {
	return f(ctx, request)
}
func env(files map[string]string) Environment {
	raw := map[string][]byte{}
	for name, value := range files {
		raw[name] = []byte(value)
	}
	return Environment{SnapshotID: "snapshot-fixed", Files: memoryFS{files: raw, dirs: map[string]bool{"dir": true}}}
}
func required(id, kind, path, pattern string) mission.CheckSpec {
	return mission.CheckSpec{ID: id, Kind: kind, Path: path, Pattern: pattern, Required: true}
}
func TestAllFileChecksAndFrozenEvidence(t *testing.T) {
	checks := []mission.CheckSpec{required("exists", "path_exists", "dir", ""), required("absent", "path_absent", "missing", ""), required("contains", "text_contains", "text", "hello"), required("excludes", "text_excludes", "text", "forbidden"), required("regex", "regex", "text", "hello.*世界"), required("json", "json_valid", "data.json", ""), required("pointer", "json_pointer", "data.json", "/a~1b/0/name=\"猫\"")}
	environment := env(map[string]string{"text": "hello 世界", "data.json": "{\"a/b\":[{\"name\":\"猫\"}]}"})
	report, err := Evaluate(context.Background(), checks, environment, Options{})
	if err != nil || report.Status != "passed" || report.Passed != 7 {
		t.Fatalf("evaluation %+v %v", report, err)
	}
	if err = VerifyEvidence(report, environment.SnapshotID); err != nil {
		t.Fatal(err)
	}
	verification := report.Verification("verification", "task", "branch", time.Now())
	if err = ValidateVerification(checks, verification); err != nil {
		t.Fatal(err)
	}
	if err = VerifyReportSources(context.Background(), report, environment, 4<<20); err != nil {
		t.Fatal(err)
	}
	altered := verification
	altered.Checks = append([]mission.CheckResult(nil), verification.Checks...)
	altered.Checks[0].Status = "failed"
	if ValidateVerification(checks, altered) == nil {
		t.Fatal("tampered result accepted")
	}
	altered = verification
	altered.SnapshotID = "different"
	if ValidateVerification(checks, altered) == nil {
		t.Fatal("cross-snapshot evidence accepted")
	}
	checks[2].Pattern = "other"
	if ValidateVerification(checks, verification) == nil {
		t.Fatal("changed frozen check accepted")
	}
}
func TestContentAbsenceAndTruncationCannotPass(t *testing.T) {
	environment := env(map[string]string{"big": strings.Repeat("x", 50) + "forbidden"})
	specs := []mission.CheckSpec{required("missing", "text_excludes", "missing", "forbidden"), required("big", "text_excludes", "big", "forbidden"), required("directory", "text_contains", "dir", "x")}
	report, err := Evaluate(context.Background(), specs, environment, Options{MaxFileBytes: 10})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "failed" || report.Checks[0].Status != "failed" || report.Checks[1].Status != "error" || report.Checks[2].Status != "failed" {
		t.Fatalf("false passes %+v", report)
	}
	denied := environment
	denied.Files = memoryFS{statErr: fs.ErrPermission}
	report, err = Evaluate(context.Background(), []mission.CheckSpec{required("absent", "path_absent", "secret", "")}, denied, Options{})
	if err != nil || report.Checks[0].Status != "error" {
		t.Fatalf("permission denied confused with missing: %+v %v", report, err)
	}
	unstable := environment
	unstable.Files = memoryFS{files: map[string][]byte{"text": []byte("x")}, readExtra: true}
	report, err = Evaluate(context.Background(), []mission.CheckSpec{required("text", "text_contains", "text", "x")}, unstable, Options{})
	if err != nil || report.Checks[0].Status != "error" {
		t.Fatalf("unstable snapshot accepted %+v %v", report, err)
	}
}
func TestJSONPointerStrictnessAndTypedEquality(t *testing.T) {
	cases := []struct {
		JSON, Pattern string
		Passed        bool
	}{
		{`{"n":1.0}`, `/n=1`, true}, {`{"n":"1"}`, `/n=1`, false}, {`{"a/b":{"~":null}}`, `/a~1b/~0=null`, true},
		{`[1]`, `/00`, false}, {`[1]`, `/-`, false}, {`[1]`, `/1`, false}, {`{"x":null}`, `/x`, true}, {`{"x":false}`, `/x/child`, false},
		{`{"x":1,"x":2}`, `/x=2`, false}, {`{} {}`, ``, false}, {`{"a=b":3}`, `{"pointer":"/a=b","equals":3}`, true},
		{`{"n":1e3}`, `/n=1000`, true}, {`{"arr":[1,{"x":false}]}`, `/arr=[1.0,{"x":false}]`, true},
	}
	for index, sample := range cases {
		spec := required(fmt.Sprint(index), "json_pointer", "data", sample.Pattern)
		report, err := Evaluate(context.Background(), []mission.CheckSpec{spec}, env(map[string]string{"data": sample.JSON}), Options{})
		if err != nil {
			t.Fatalf("case %d: %v", index, err)
		}
		if (report.Status == "passed") != sample.Passed {
			t.Fatalf("case %d: %+v", index, report)
		}
	}
	for _, bad := range []string{"x", "/x~2", "/x~", "/x=", "{\"pointer\":1}", "{\"pointer\":\"\",\"script\":\"eval\"}"} {
		if ValidateChecks([]mission.CheckSpec{required("bad", "json_pointer", "data", bad)}) == nil {
			t.Fatalf("invalid pointer %q accepted", bad)
		}
	}
}
func TestJSONNumberEqualityDoesNotExpandUnboundedExponents(t *testing.T) {
	for _, sample := range []struct {
		left, right string
		equal       bool
	}{
		{"1e1000000000", "10e999999999", true},
		{"1e-1000000000", "0.1e-999999999", true},
		{"1e1000000000", "1e999999999", false},
		{"-0e1000000000", "0.00000e-1000000000", true},
		{"1.23400e+005", "123400", true},
		{"-0.000001", "-1e-6", true},
		{"9007199254740993", "9007199254740992", false},
		{"1e1000000000000000000000", "10e999999999999999999999", true},
	} {
		left, err := parseJSON([]byte(sample.left))
		if err != nil {
			t.Fatal(err)
		}
		right, err := parseJSON([]byte(sample.right))
		if err != nil {
			t.Fatal(err)
		}
		if actual := equalJSON(left, right); actual != sample.equal {
			t.Fatalf("%s equals %s: got %v", sample.left, sample.right, actual)
		}
	}
}
func TestCommandIsolationExpectedExitAndTruncatedLogs(t *testing.T) {
	spec := mission.CheckSpec{ID: "command", Kind: "command", Command: []string{"test-program", "argument with spaces"}, ExpectedExitCode: 7, Required: true}
	environment := env(nil)
	called := false
	environment.Commands = commandFunc(func(ctx context.Context, request CommandRequest) (CommandResult, error) {
		called = true
		if !request.NoNetwork || request.SnapshotID != environment.SnapshotID || request.Argv[1] != "argument with spaces" || request.Directory != "." {
			t.Fatalf("unsafe command request %+v", request)
		}
		return CommandResult{ExitCode: 7, Stdout: strings.Repeat("猫", 100), NetworkDisabled: true, SnapshotID: request.SnapshotID}, nil
	})
	report, err := Evaluate(context.Background(), []mission.CheckSpec{spec}, environment, Options{MaxOutputBytes: 20})
	if err != nil || !called || report.Status != "passed" || !strings.Contains(report.Checks[0].Output, "truncated") {
		t.Fatalf("command result %+v %v", report, err)
	}
	if err = ValidateVerification([]mission.CheckSpec{spec}, report.Verification("v", "task", "branch", time.Now())); err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []CommandResult{{ExitCode: 7, SnapshotID: environment.SnapshotID}, {ExitCode: 7, NetworkDisabled: true, SnapshotID: "other"}, {ExitCode: 0, NetworkDisabled: true, SnapshotID: environment.SnapshotID}, {ExitCode: 7, NetworkDisabled: true, SnapshotID: environment.SnapshotID, TimedOut: true}} {
		environment.Commands = commandFunc(func(context.Context, CommandRequest) (CommandResult, error) { return outcome, nil })
		report, err = Evaluate(context.Background(), []mission.CheckSpec{spec}, environment, Options{})
		if err != nil || report.Status == "passed" {
			t.Fatalf("unsafe outcome accepted %+v %v", outcome, err)
		}
	}
}
func TestCancellationAndTimeoutPreserveCommandEvidence(t *testing.T) {
	spec := mission.CheckSpec{ID: "command", Kind: "command", Command: []string{"test"}, Required: true}
	environment := env(nil)
	environment.Commands = commandFunc(func(ctx context.Context, request CommandRequest) (CommandResult, error) {
		<-ctx.Done()
		return CommandResult{ExitCode: 137, Stdout: "partial", SnapshotID: request.SnapshotID, NetworkDisabled: true}, ctx.Err()
	})
	report, err := Evaluate(context.Background(), []mission.CheckSpec{spec}, environment, Options{DefaultTimeout: time.Millisecond, MaxTimeout: time.Second})
	if err != nil || report.Status != "failed" || report.Checks[0].Output != "partial" {
		t.Fatalf("timeout report %+v %v", report, err)
	}
	e, _ := DecodeEvidence(report.Checks[0].Evidence)
	if !e.TimedOut || e.ExitCode == nil || *e.ExitCode != 137 {
		t.Fatalf("lost timeout evidence %+v", e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err = Evaluate(ctx, []mission.CheckSpec{spec, required("later", "path_exists", "something", "")}, environment, Options{})
	if !errors.Is(err, context.Canceled) || len(report.Checks) != 2 || report.Status != "failed" {
		t.Fatalf("cancellation %+v %v", report, err)
	}
}
func TestMissingAndDuplicateVerificationCannotPass(t *testing.T) {
	checks := []mission.CheckSpec{required("a", "path_exists", "a", ""), required("b", "path_exists", "b", "")}
	report, err := Evaluate(context.Background(), checks, env(map[string]string{"a": "a", "b": "b"}), Options{})
	if err != nil {
		t.Fatal(err)
	}
	v := report.Verification("v", "task", "branch", time.Now())
	v.Checks = v.Checks[:1]
	if ValidateVerification(checks, v) == nil {
		t.Fatal("missing required check accepted")
	}
	v = report.Verification("v", "task", "branch", time.Now())
	v.Checks[1] = v.Checks[0]
	if ValidateVerification(checks, v) == nil {
		t.Fatal("duplicate accepted")
	}
	optional := required("optional", "path_exists", "missing", "")
	optional.Required = false
	checks = append(checks, optional)
	report, err = Evaluate(context.Background(), checks, env(map[string]string{"a": "", "b": ""}), Options{})
	if err != nil || report.Status != "passed" || report.Failed != 1 {
		t.Fatalf("optional check lost %+v %v", report, err)
	}
	report, err = Evaluate(context.Background(), []mission.CheckSpec{optional}, env(nil), Options{})
	if err != nil || report.Status != "unverified" {
		t.Fatalf("no required checks passed %+v %v", report, err)
	}
}
func TestEvidenceIntegrityAndSourceRevalidation(t *testing.T) {
	spec := required("a", "text_contains", "a", "good")
	environment := env(map[string]string{"a": "good"})
	report, err := Evaluate(context.Background(), []mission.CheckSpec{spec}, environment, Options{})
	if err != nil {
		t.Fatal(err)
	}
	changed := env(map[string]string{"a": "evil"})
	if VerifyReportSources(context.Background(), report, changed, 100) == nil {
		t.Fatal("content mutation did not invalidate evidence")
	}
	e, _ := DecodeEvidence(report.Checks[0].Evidence)
	e.ContentHash = strings.Repeat("a", 64)
	report.Checks[0].Evidence, _ = json.Marshal(e)
	if VerifyEvidence(report, environment.SnapshotID) == nil {
		t.Fatal("hash tampering accepted")
	}
}
func TestInvalidSpecificationsNeverInvokeExecutor(t *testing.T) {
	called := false
	environment := env(nil)
	environment.Commands = commandFunc(func(context.Context, CommandRequest) (CommandResult, error) {
		called = true
		return CommandResult{}, nil
	})
	invalid := []mission.CheckSpec{{ID: "id", Kind: "command", Command: []string{"test"}, Path: "evil", Required: true}}
	if _, err := Evaluate(context.Background(), invalid, environment, Options{}); err == nil || called {
		t.Fatalf("invalid rule invoked command: %v %v", called, err)
	}
	for _, path := range []string{"/etc/passwd", "../x", "a/../x", "a\\b", "file://x", ".git/config", "a\nx"} {
		if _, err := NormalizePath(path); err == nil {
			t.Fatalf("accepted invalid path %q", path)
		}
	}
}
