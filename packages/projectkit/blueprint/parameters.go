// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

func identifier(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for i, c := range []byte(value) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' || i > 0 && (c >= '0' && c <= '9' || c == '-') {
			continue
		}
		return false
	}
	return true
}

func decodeScalar(raw json.RawMessage) (any, error) {
	if len(raw) > 512<<10 {
		return nil, fmt.Errorf("encoded scalar exceeds 512 KiB")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, fmt.Errorf("invalid scalar JSON: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("scalar must contain one JSON value")
	}
	switch v := value.(type) {
	case string:
		if !utf8.ValidString(v) || strings.IndexByte(v, 0) >= 0 {
			return nil, fmt.Errorf("string must be valid UTF-8 without NUL")
		}
		return v, nil
	case bool:
		return v, nil
	case json.Number:
		n, err := strconv.ParseInt(string(v), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("number must be a signed 64-bit integer")
		}
		return n, nil
	default:
		return nil, fmt.Errorf("expected a string, integer or boolean")
	}
}

func scalarText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return ""
	}
}

func canonicalPath(value string) bool {
	if value == "" || value == "." || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\:*?[]\x00\r\n") || !utf8.ValidString(value) || len(value) > 4096 || path.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
		for _, c := range part {
			if c < 32 || c == 127 {
				return false
			}
		}
	}
	first := strings.Split(value, "/")[0]
	if first == ".git" || first == ".zakura" {
		return false
	}
	return true
}

func parameterValue(p Parameter, raw json.RawMessage) (any, error) {
	v, err := decodeScalar(raw)
	if err != nil {
		return nil, err
	}
	switch p.Type {
	case "string", "enum", "path":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("expected %s string", p.Type)
		}
		max := p.MaxLength
		if max == 0 {
			max = 65536
		}
		length := utf8.RuneCountInString(s)
		if length < p.MinLength || length > max {
			return nil, fmt.Errorf("string length must be between %d and %d characters", p.MinLength, max)
		}
		if p.Type == "path" && !canonicalPath(s) {
			return nil, fmt.Errorf("path must be a canonical relative workspace path")
		}
		if p.Type == "enum" {
			found := false
			for _, item := range p.Enum {
				found = found || item == s
			}
			if !found {
				return nil, fmt.Errorf("value is not a declared enum choice")
			}
		}
		if p.Pattern != "" {
			r, e := regexp.Compile(p.Pattern)
			if e != nil {
				return nil, e
			}
			if !r.MatchString(s) {
				return nil, fmt.Errorf("string does not match its parameter pattern")
			}
		}
	case "int":
		n, ok := v.(int64)
		if !ok {
			return nil, fmt.Errorf("expected integer")
		}
		if p.Minimum != nil && n < *p.Minimum || p.Maximum != nil && n > *p.Maximum {
			return nil, fmt.Errorf("integer is outside its declared range")
		}
	case "bool":
		if _, ok := v.(bool); !ok {
			return nil, fmt.Errorf("expected boolean")
		}
	default:
		return nil, fmt.Errorf("unsupported parameter type")
	}
	return v, nil
}

func resolveParameters(parameters []Parameter, inputs map[string]json.RawMessage) (map[string]any, error) {
	declared := map[string]bool{}
	for _, p := range parameters {
		declared[p.Name] = true
	}
	for name := range inputs {
		if !declared[name] {
			return nil, invalid("parameters."+name, "unknown_parameter", "input parameter is not declared")
		}
	}
	result := map[string]any{}
	for _, p := range parameters {
		raw, exists := inputs[p.Name]
		if !exists {
			raw = p.Default
		}
		if len(raw) == 0 {
			if p.Required {
				return nil, invalid("parameters."+p.Name, "required", "required parameter has no value")
			}
			continue
		}
		v, err := parameterValue(p, raw)
		if err != nil {
			return nil, invalid("parameters."+p.Name, "parameter_value", err.Error())
		}
		result[p.Name] = v
	}
	return result, nil
}

// interpolate scans only the authored input; inserted values are not scanned.
func interpolate(value string, lookup func(string) (string, error)) (string, error) {
	var out strings.Builder
	for len(value) != 0 {
		start := strings.Index(value, "{{")
		endOnly := strings.Index(value, "}}")
		if start < 0 {
			if endOnly >= 0 {
				return "", fmt.Errorf("unexpected closing placeholder delimiter")
			}
			out.WriteString(value)
			break
		}
		if endOnly >= 0 && endOnly < start {
			return "", fmt.Errorf("unexpected closing placeholder delimiter")
		}
		out.WriteString(value[:start])
		rest := value[start+2:]
		end := strings.Index(rest, "}}")
		if end < 0 {
			return "", fmt.Errorf("unclosed placeholder")
		}
		ref := strings.TrimSpace(rest[:end])
		if strings.Contains(ref, "{{") {
			return "", fmt.Errorf("nested placeholders are unsupported")
		}
		replacement, err := lookup(ref)
		if err != nil {
			return "", err
		}
		if out.Len()+len(replacement) > 1<<20 {
			return "", fmt.Errorf("expanded string exceeds 1 MiB")
		}
		out.WriteString(replacement)
		value = rest[end+2:]
	}
	if out.Len() > 1<<20 {
		return "", fmt.Errorf("expanded string exceeds 1 MiB")
	}
	return out.String(), nil
}

func splitReference(ref string) (string, string, error) {
	parts := strings.Split(ref, ".")
	if len(parts) != 2 || !identifier(parts[1]) || parts[0] != "param" && parts[0] != "matrix" {
		return "", "", fmt.Errorf("reference must be param.NAME or matrix.AXIS")
	}
	return parts[0], parts[1], nil
}

func referenceValue(ref string, parameters map[string]any, axes map[string]string) (any, bool, error) {
	kind, name, err := splitReference(ref)
	if err != nil {
		return nil, false, err
	}
	if kind == "param" {
		v, ok := parameters[name]
		return v, ok, nil
	}
	v, ok := axes[name]
	return v, ok, nil
}

func render(value string, parameters map[string]any, axes map[string]string) (string, error) {
	return interpolate(value, func(ref string) (string, error) {
		v, ok, err := referenceValue(ref, parameters, axes)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("placeholder %s has no value", ref)
		}
		return scalarText(v), nil
	})
}
