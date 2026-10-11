// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import "fmt"

func validateCondition(c Condition, parameters map[string]Parameter, axes map[string][]string, depth int, nodes *int) error {
	*nodes++
	if depth > 8 || *nodes > 128 {
		return fmt.Errorf("condition exceeds depth 8 or 128 nodes")
	}
	variants := 0
	if c.Ref != "" || c.Op != "" || len(c.Value) != 0 || len(c.Values) != 0 {
		variants++
	}
	if c.All != nil {
		variants++
	}
	if c.Any != nil {
		variants++
	}
	if c.Not != nil {
		variants++
	}
	if variants != 1 {
		return fmt.Errorf("condition must contain exactly one predicate, all, any or not")
	}
	if c.Not != nil {
		return validateCondition(*c.Not, parameters, axes, depth+1, nodes)
	}
	children := c.All
	if c.Any != nil {
		children = c.Any
	}
	if children != nil {
		if len(children) == 0 || len(children) > 64 {
			return fmt.Errorf("all/any requires 1 to 64 conditions")
		}
		for _, child := range children {
			if err := validateCondition(child, parameters, axes, depth+1, nodes); err != nil {
				return err
			}
		}
		return nil
	}
	kind, name, err := splitReference(c.Ref)
	if err != nil {
		return err
	}
	if kind == "param" {
		if _, ok := parameters[name]; !ok {
			return fmt.Errorf("condition references undeclared parameter %s", name)
		}
	} else if _, ok := axes[name]; !ok {
		return fmt.Errorf("condition references undeclared matrix axis %s", name)
	}
	var values = c.Values
	switch c.Op {
	case "present":
		if len(c.Value) != 0 || c.Values != nil {
			return fmt.Errorf("present accepts no comparison value")
		}
	case "eq", "ne":
		if len(c.Value) == 0 || c.Values != nil {
			return fmt.Errorf("eq/ne requires value and forbids values")
		}
		values = append(values, c.Value)
	case "in":
		if len(c.Value) != 0 || len(c.Values) == 0 || len(c.Values) > 64 {
			return fmt.Errorf("in requires 1 to 64 values and forbids value")
		}
	default:
		return fmt.Errorf("unsupported condition operator")
	}
	for _, raw := range values {
		value, e := decodeScalar(raw)
		if e != nil {
			return e
		}
		if kind == "matrix" {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("matrix comparison values must be strings")
			}
		} else {
			p := parameters[name]
			if _, e := parameterValue(Parameter{Type: p.Type, Enum: p.Enum}, raw); e != nil {
				return fmt.Errorf("condition value type does not match parameter %s: %w", name, e)
			}
		}
	}
	return nil
}

func evaluateCondition(c *Condition, parameters map[string]any, axes map[string]string) (bool, error) {
	if c == nil {
		return true, nil
	}
	if c.Not != nil {
		v, err := evaluateCondition(c.Not, parameters, axes)
		return !v, err
	}
	if c.All != nil {
		for i := range c.All {
			v, err := evaluateCondition(&c.All[i], parameters, axes)
			if err != nil || !v {
				return false, err
			}
		}
		return true, nil
	}
	if c.Any != nil {
		for i := range c.Any {
			v, err := evaluateCondition(&c.Any[i], parameters, axes)
			if err != nil {
				return false, err
			}
			if v {
				return true, nil
			}
		}
		return false, nil
	}
	value, exists, err := referenceValue(c.Ref, parameters, axes)
	if err != nil {
		return false, err
	}
	if c.Op == "present" {
		return exists, nil
	}
	if !exists {
		return false, fmt.Errorf("condition reference %s has no value; use present to guard optional parameters", c.Ref)
	}
	if c.Op == "in" {
		for _, raw := range c.Values {
			other, e := decodeScalar(raw)
			if e != nil {
				return false, e
			}
			if value == other {
				return true, nil
			}
		}
		return false, nil
	}
	other, err := decodeScalar(c.Value)
	if err != nil {
		return false, err
	}
	if c.Op == "eq" {
		return value == other, nil
	}
	if c.Op == "ne" {
		return value != other, nil
	}
	return false, fmt.Errorf("unsupported condition operator")
}
