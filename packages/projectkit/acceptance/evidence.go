// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"io/fs"
)

func validHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	raw, err := hex.DecodeString(value)
	return err == nil && len(raw) == 32
}
func sameHash(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func verifyCheckEvidence(result mission.CheckResult, snapshot string) (Evidence, error) {
	e, err := DecodeEvidence(result.Evidence)
	if err != nil {
		return e, fmt.Errorf("check %s has malformed evidence: %w", result.ID, err)
	}
	if e.Version != 1 || e.SnapshotID != snapshot || e.CheckID != result.ID || e.Status != result.Status {
		return e, fmt.Errorf("check %s evidence identity or snapshot mismatch", result.ID)
	}
	if !validHash(e.SpecHash) || !validHash(e.ResultHash) || !validHash(e.ProofHash) {
		return e, fmt.Errorf("check %s evidence hashes are missing or malformed", result.ID)
	}
	if !sameHash(resultHash(result), e.ResultHash) || !sameHash(evidenceHash(e), e.ProofHash) {
		return e, fmt.Errorf("check %s evidence integrity mismatch", result.ID)
	}
	if e.ContentHash != "" && !validHash(e.ContentHash) {
		return e, fmt.Errorf("check %s content hash is malformed", result.ID)
	}
	if e.OutputHash != "" && !validHash(e.OutputHash) {
		return e, fmt.Errorf("check %s output hash is malformed", result.ID)
	}
	if result.Status == "passed" {
		if e.TimedOut || e.Cancelled {
			return e, fmt.Errorf("interrupted check %s cannot pass", result.ID)
		}
		if result.Kind == "command" {
			if !e.NetworkDisabled || e.ExitCode == nil || !validHash(e.OutputHash) {
				return e, fmt.Errorf("command check %s lacks isolation or exit evidence", result.ID)
			}
		}
		if result.Kind != "command" && e.Exists == nil {
			return e, fmt.Errorf("file check %s lacks existence evidence", result.ID)
		}
		if result.Kind != "command" && result.Kind != "path_exists" && result.Kind != "path_absent" && (e.Truncated || !validHash(e.ContentHash)) {
			return e, fmt.Errorf("content check %s lacks complete content evidence", result.ID)
		}
	}
	return e, nil
}

// VerifyEvidence verifies integrity and snapshot binding, not runner authenticity.
// Authenticity comes from the authenticated runner channel and frozen snapshot store.
func VerifyEvidence(report Report, snapshotID string) error {
	if snapshotID == "" || report.SnapshotID != snapshotID {
		return fmt.Errorf("report snapshot mismatch")
	}
	seen := map[string]bool{}
	required, passed, failed, errorsCount := 0, 0, 0, 0
	status := "passed"
	for _, check := range report.Checks {
		if seen[check.ID] {
			return fmt.Errorf("duplicate check %s", check.ID)
		}
		seen[check.ID] = true
		if _, err := verifyCheckEvidence(check, snapshotID); err != nil {
			return err
		}
		switch check.Status {
		case "passed":
			passed++
		case "failed":
			failed++
		case "error":
			errorsCount++
		default:
			return fmt.Errorf("check %s has invalid status", check.ID)
		}
		if check.Required {
			required++
			if check.Status != "passed" {
				status = "failed"
			}
		}
	}
	if required == 0 {
		status = "unverified"
	}
	if report.Status != status || report.Required != required || report.Passed != passed || report.Failed != failed || report.Errors != errorsCount {
		return fmt.Errorf("acceptance aggregate disagrees with evidence")
	}
	return nil
}
func ValidateVerification(specs []mission.CheckSpec, v mission.Verification) error {
	if err := ValidateChecks(specs); err != nil {
		return err
	}
	if v.SnapshotID == "" {
		return fmt.Errorf("verification must bind an immutable snapshot")
	}
	expected := map[string]mission.CheckSpec{}
	required := 0
	for _, spec := range specs {
		expected[spec.ID] = spec
		if spec.Required {
			required++
		}
	}
	if len(v.Checks) != len(specs) {
		return fmt.Errorf("verification must contain exactly one result for every acceptance check")
	}
	seen := map[string]bool{}
	status := "passed"
	for _, check := range v.Checks {
		spec, exists := expected[check.ID]
		if !exists {
			return fmt.Errorf("verification contains unknown check %s", check.ID)
		}
		if seen[check.ID] {
			return fmt.Errorf("verification repeats check %s", check.ID)
		}
		seen[check.ID] = true
		if check.Kind != spec.Kind || check.Required != spec.Required {
			return fmt.Errorf("check %s kind or requirement changed", check.ID)
		}
		if check.Status != "passed" && check.Status != "failed" && check.Status != "error" {
			return fmt.Errorf("check %s has invalid status", check.ID)
		}
		evidence, err := verifyCheckEvidence(check, v.SnapshotID)
		if err != nil {
			return err
		}
		if !sameHash(evidence.SpecHash, specHash(spec)) {
			return fmt.Errorf("check %s evidence does not match frozen acceptance rule", check.ID)
		}
		if check.Status == "passed" && spec.Kind == "command" && *evidence.ExitCode != spec.ExpectedExitCode {
			return fmt.Errorf("check %s exit code contradicts rule", check.ID)
		}
		if check.Status == "passed" && spec.Kind == "path_exists" && !*evidence.Exists {
			return fmt.Errorf("check %s existence evidence contradicts rule", check.ID)
		}
		if check.Status == "passed" && spec.Kind == "path_absent" && *evidence.Exists {
			return fmt.Errorf("check %s absence evidence contradicts rule", check.ID)
		}
		if spec.Required && check.Status != "passed" {
			status = "failed"
		}
	}
	if required == 0 {
		status = "unverified"
	}
	if v.Status != status {
		return fmt.Errorf("verification status %q disagrees with required checks (%s)", v.Status, status)
	}
	return nil
}
func VerificationPassed(specs []mission.CheckSpec, v mission.Verification) (bool, error) {
	if err := ValidateVerification(specs, v); err != nil {
		return false, err
	}
	return v.Status == "passed", nil
}

// VerifyReportSources additionally reads the authenticated frozen filesystem and
// checks that successful file-content evidence still matches that snapshot.
func VerifyReportSources(ctx context.Context, report Report, environment Environment, maxFileBytes int64) error {
	if err := VerifyEvidence(report, environment.SnapshotID); err != nil {
		return err
	}
	if maxFileBytes <= 0 || maxFileBytes > 64<<20 {
		return fmt.Errorf("invalid source verification byte limit")
	}
	for _, check := range report.Checks {
		if check.Status != "passed" || check.Kind == "command" {
			continue
		}
		e, _ := DecodeEvidence(check.Evidence)
		if environment.Files == nil {
			return fmt.Errorf("snapshot filesystem is unavailable")
		}
		info, err := environment.Files.Stat(ctx, e.Path)
		if check.Kind == "path_absent" {
			if err == nil {
				return fmt.Errorf("absence evidence no longer matches snapshot")
			}
			if !errors.Is(err, ErrNotFound) && !errors.Is(err, fs.ErrNotExist) {
				return fmt.Errorf("cannot confirm absent path: %w", err)
			}
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir != e.IsDir || info.Size != e.Size {
			return fmt.Errorf("file metadata changed from evidence")
		}
		if e.ContentHash != "" {
			if info.Size > maxFileBytes {
				return fmt.Errorf("file exceeds source verification byte limit")
			}
			raw, err := environment.Files.ReadFile(ctx, e.Path, maxFileBytes+1)
			if err != nil {
				return err
			}
			if int64(len(raw)) > maxFileBytes || !sameHash(hashBytes(raw), e.ContentHash) {
				return fmt.Errorf("content hash differs from snapshot evidence")
			}
		}
	}
	return nil
}
