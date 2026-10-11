// SPDX-License-Identifier: AGPL-3.0-or-later
package acceptance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"strconv"
	"strings"
)

// parseJSON rejects duplicate keys, trailing documents and excessively nested data.
func parseJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	var value func(int) (any, error)
	value = func(depth int) (any, error) {
		if depth > 256 {
			return nil, fmt.Errorf("JSON nesting exceeds 256 levels")
		}
		nodes++
		if nodes > 500000 {
			return nil, fmt.Errorf("JSON value count exceeds 500000")
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		delim, compound := token.(json.Delim)
		if !compound {
			return token, nil
		}
		switch delim {
		case '{':
			object := map[string]any{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("invalid object key")
				}
				if _, exists := object[key]; exists {
					return nil, fmt.Errorf("duplicate JSON key %q", key)
				}
				child, err := value(depth + 1)
				if err != nil {
					return nil, err
				}
				object[key] = child
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return nil, fmt.Errorf("unterminated JSON object")
			}
			return object, nil
		case '[':
			array := []any{}
			for decoder.More() {
				child, err := value(depth + 1)
				if err != nil {
					return nil, err
				}
				array = append(array, child)
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return nil, fmt.Errorf("unterminated JSON array")
			}
			return array, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter")
		}
	}
	result, err := value(0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("trailing JSON document")
		}
		return nil, err
	}
	return result, nil
}

type pointerRule struct {
	Pointer  string
	Expected any
	Compare  bool
	Segments []string
}

// Object form {"pointer":"/...","equals":value} is unambiguous for keys containing '='.
// Compact form '/...=JSON' is retained for simple rules; '/...' tests existence.
func parsePointerRule(pattern string) (pointerRule, error) {
	rule := pointerRule{}
	if strings.HasPrefix(strings.TrimSpace(pattern), "{") {
		parsed, err := parseJSON([]byte(pattern))
		if err != nil {
			return rule, err
		}
		object, ok := parsed.(map[string]any)
		if !ok {
			return rule, fmt.Errorf("pointer rule must be an object")
		}
		rule.Pointer, ok = object["pointer"].(string)
		if !ok {
			return rule, fmt.Errorf("pointer rule requires a string pointer")
		}
		if len(object) > 2 {
			return rule, fmt.Errorf("pointer rule accepts only pointer and equals")
		}
		for key := range object {
			if key != "pointer" && key != "equals" {
				return rule, fmt.Errorf("unknown pointer rule key %q", key)
			}
		}
		rule.Expected, rule.Compare = object["equals"]
	} else {
		rule.Pointer = pattern
		if index := strings.Index(pattern, "="); index >= 0 {
			rule.Pointer = pattern[:index]
			expected, err := parseJSON([]byte(pattern[index+1:]))
			if err != nil {
				return rule, fmt.Errorf("invalid expected JSON: %w", err)
			}
			rule.Expected = expected
			rule.Compare = true
		}
	}
	if rule.Pointer == "" {
		return rule, nil
	}
	if !strings.HasPrefix(rule.Pointer, "/") {
		return rule, fmt.Errorf("JSON pointer must be empty or start with /")
	}
	for _, segment := range strings.Split(rule.Pointer[1:], "/") {
		var decoded strings.Builder
		for index := 0; index < len(segment); index++ {
			if segment[index] != '~' {
				decoded.WriteByte(segment[index])
				continue
			}
			index++
			if index == len(segment) || (segment[index] != '0' && segment[index] != '1') {
				return rule, fmt.Errorf("invalid RFC 6901 escape")
			}
			if segment[index] == '0' {
				decoded.WriteByte('~')
			} else {
				decoded.WriteByte('/')
			}
		}
		rule.Segments = append(rule.Segments, decoded.String())
	}
	return rule, nil
}
func resolvePointer(document any, segments []string) (any, error) {
	current := document
	for depth, segment := range segments {
		switch value := current.(type) {
		case map[string]any:
			next, exists := value[segment]
			if !exists {
				return nil, fmt.Errorf("pointer segment %d key %q does not exist", depth, segment)
			}
			current = next
		case []any:
			if segment == "" || segment == "-" || (len(segment) > 1 && segment[0] == '0') {
				return nil, fmt.Errorf("pointer segment %d is not a canonical array index", depth)
			}
			for _, r := range segment {
				if r < '0' || r > '9' {
					return nil, fmt.Errorf("pointer segment %d is not an array index", depth)
				}
			}
			index, err := strconv.ParseUint(segment, 10, 63)
			if err != nil || index >= uint64(len(value)) {
				return nil, fmt.Errorf("pointer segment %d array index is outside the document", depth)
			}
			current = value[int(index)]
		default:
			return nil, fmt.Errorf("pointer segment %d traverses a scalar", depth)
		}
	}
	return current, nil
}
func equalJSON(left, right any) bool {
	switch a := left.(type) {
	case nil:
		return right == nil
	case bool:
		b, ok := right.(bool)
		return ok && a == b
	case string:
		b, ok := right.(string)
		return ok && a == b
	case json.Number:
		b, ok := right.(json.Number)
		if !ok {
			return false
		}
		return equalJSONNumbers(a.String(), b.String())
	case []any:
		b, ok := right.([]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for i := range a {
			if !equalJSON(a[i], b[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		b, ok := right.(map[string]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for key, value := range a {
			other, exists := b[key]
			if !exists || !equalJSON(value, other) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// JSON numbers are finite decimal values. Compare their normalized significant
// digits and decimal exponents rather than expanding powers of ten: even a
// short, valid input such as 1e1000000000 must have bounded processing cost.
func equalJSONNumbers(left, right string) bool {
	type decimal struct {
		negative bool
		digits   string
		exponent *big.Int
	}
	normalize := func(raw string) (decimal, bool) {
		value := decimal{exponent: new(big.Int)}
		if strings.HasPrefix(raw, "-") {
			value.negative = true
			raw = raw[1:]
		}
		if index := strings.IndexAny(raw, "eE"); index >= 0 {
			if _, ok := value.exponent.SetString(raw[index+1:], 10); !ok {
				return value, false
			}
			raw = raw[:index]
		}
		fractionDigits := 0
		if index := strings.IndexByte(raw, '.'); index >= 0 {
			fractionDigits = len(raw) - index - 1
			raw = raw[:index] + raw[index+1:]
		}
		if len(raw) == 0 {
			return value, false
		}
		for _, digit := range raw {
			if digit < '0' || digit > '9' {
				return value, false
			}
		}
		digits := strings.TrimLeft(raw, "0")
		if digits == "" {
			value.negative = false
			value.digits = "0"
			value.exponent.SetInt64(0)
			return value, true
		}
		value.digits = strings.TrimRight(digits, "0")
		shift := int64(len(digits) - len(value.digits) - fractionDigits)
		value.exponent.Add(value.exponent, big.NewInt(shift))
		return value, true
	}
	a, validA := normalize(left)
	b, validB := normalize(right)
	return validA && validB && a.negative == b.negative && a.digits == b.digits && a.exponent.Cmp(b.exponent) == 0
}
