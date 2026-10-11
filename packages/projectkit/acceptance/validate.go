// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"fmt"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

func NormalizePath(value string) (string, error) {
	if value == "" {
		return "", fmt.Errorf("path is required")
	}
	if !utf8.ValidString(value) || len(value) > 4096 {
		return "", fmt.Errorf("path must be valid UTF-8 and at most 4096 bytes")
	}
	if strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return "", fmt.Errorf("path must be relative and use forward slashes")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("path contains a control character")
		}
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return "", fmt.Errorf("parent traversal is forbidden")
		}
	}
	clean := path.Clean(value)
	first := strings.Split(clean, "/")[0]
	if strings.Contains(first, ":") {
		return "", fmt.Errorf("path cannot contain a drive or URI prefix")
	}
	if first == ".git" || first == ".zakura" {
		return "", fmt.Errorf("internal workspace metadata is outside the project scope")
	}
	return clean, nil
}

func ValidateChecks(checks []mission.CheckSpec) error {
	var issues []Issue
	add := func(id, field, code, message string) {
		issues = append(issues, Issue{CheckID: id, Field: field, Code: code, Message: message})
	}
	if len(checks) > 1000 {
		add("", "checks", "limit", "at most 1000 acceptance checks are allowed")
	}
	seen := map[string]bool{}
	for _, spec := range checks {
		id := spec.ID
		if strings.TrimSpace(id) == "" || len(id) > 128 || !utf8.ValidString(id) {
			add(id, "id", "invalid_id", "check ID must contain 1 to 128 UTF-8 bytes")
		}
		if seen[id] {
			add(id, "id", "duplicate_id", "check IDs must be unique")
		}
		seen[id] = true
		if len(spec.Title) > 500 {
			add(id, "title", "limit", "check title is too long")
		}
		if spec.TimeoutSeconds < 0 || spec.TimeoutSeconds > 3600 {
			add(id, "timeoutSeconds", "range", "timeout must be between 0 and 3600 seconds")
		}
		if spec.ExpectedExitCode < 0 || spec.ExpectedExitCode > 255 {
			add(id, "expectedExitCode", "range", "expected exit code must be between 0 and 255")
		}
		command := spec.Kind == "command"
		switch spec.Kind {
		case "path_exists", "path_absent", "text_contains", "text_excludes", "regex", "json_valid", "json_pointer", "command":
		default:
			add(id, "kind", "unsupported_kind", "unsupported acceptance kind "+spec.Kind)
		}
		if command {
			if spec.Path != "" || spec.Pattern != "" {
				add(id, "command", "extraneous_field", "command checks cannot have path or pattern")
			}
			if len(spec.Command) == 0 || len(spec.Command) > 256 {
				add(id, "command", "invalid_command", "command requires 1 to 256 argv elements")
			}
			total := 0
			for index, arg := range spec.Command {
				total += len(arg)
				if strings.ContainsRune(arg, 0) || !utf8.ValidString(arg) {
					add(id, fmt.Sprintf("command[%d]", index), "invalid_argument", "command arguments must be UTF-8 without NUL")
				}
			}
			if len(spec.Command) > 0 && strings.TrimSpace(spec.Command[0]) == "" {
				add(id, "command[0]", "empty_program", "command program cannot be empty")
			}
			if total > 128<<10 {
				add(id, "command", "limit", "command arguments exceed 128 KiB")
			}
			continue
		}
		if _, err := NormalizePath(spec.Path); err != nil {
			add(id, "path", "invalid_path", err.Error())
		}
		if len(spec.Command) > 0 || spec.ExpectedExitCode != 0 {
			add(id, "command", "extraneous_field", "non-command checks cannot specify argv or expected exit code")
		}
		if len(spec.Pattern) > 64<<10 || !utf8.ValidString(spec.Pattern) {
			add(id, "pattern", "limit", "pattern must be valid UTF-8 and at most 64 KiB")
		}
		switch spec.Kind {
		case "text_contains", "text_excludes":
			if spec.Pattern == "" {
				add(id, "pattern", "empty_pattern", "text matching requires a nonempty pattern")
			}
		case "regex":
			if spec.Pattern == "" {
				add(id, "pattern", "empty_pattern", "regular expression cannot be empty")
			} else if _, err := regexp.Compile(spec.Pattern); err != nil {
				add(id, "pattern", "invalid_regex", err.Error())
			}
		case "json_pointer":
			if _, err := parsePointerRule(spec.Pattern); err != nil {
				add(id, "pattern", "invalid_pointer", err.Error())
			}
		case "path_exists", "path_absent", "json_valid":
			if spec.Pattern != "" {
				add(id, "pattern", "extraneous_field", "this check kind does not accept a pattern")
			}
		}
	}
	if len(issues) > 0 {
		return &ValidationError{Issues: issues}
	}
	return nil
}
