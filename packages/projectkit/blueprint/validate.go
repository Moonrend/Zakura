// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Moonrend/Zakura/packages/projectkit/acceptance"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

func Validate(d Definition) error {
	encoded, err := json.Marshal(Document{Schema: Schema, Version: Version, Blueprint: d})
	if err != nil {
		return invalid("blueprint", "json", err.Error())
	}
	if len(encoded) > MaxDocumentBytes {
		return invalid("blueprint", "document_limit", "blueprint exceeds 2 MiB")
	}
	issues := []Issue{}
	add := func(field, code, message string) {
		if len(issues) < 100 {
			issues = append(issues, Issue{Field: field, Code: code, Message: message})
		}
	}
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 200 || !utf8.ValidString(d.Name) {
		add("name", "name", "blueprint name requires 1 to 200 UTF-8 bytes")
	}
	if len(d.Description) > 16000 || !utf8.ValidString(d.Description) {
		add("description", "description", "description exceeds 16000 UTF-8 bytes")
	}
	if strings.TrimSpace(d.ProjectName) == "" || len(d.ProjectName) > 500 {
		add("projectName", "name", "project name template requires 1 to 500 bytes")
	}
	if strings.TrimSpace(d.Goal) == "" || len(d.Goal) > 1<<20 {
		add("goal", "goal", "goal template requires 1 to 1 MiB")
	}
	if len(d.Parameters) > 100 {
		add("parameters", "parameter_limit", "at most 100 parameters are supported")
	}
	if len(d.Tasks) == 0 || len(d.Tasks) > 200 {
		add("tasks", "task_limit", "blueprint requires 1 to 200 task definitions")
	}
	parameters := map[string]Parameter{}
	for i, p := range d.Parameters {
		field := fmt.Sprintf("parameters[%d]", i)
		if !identifier(p.Name) {
			add(field+".name", "identifier", "parameter name is not an ASCII identifier")
		}
		if _, ok := parameters[p.Name]; ok {
			add(field+".name", "duplicate_parameter", "parameter name is repeated")
		}
		parameters[p.Name] = p
		if len(p.Title) > 200 || len(p.Description) > 4000 {
			add(field, "metadata_limit", "parameter title or description is too long")
		}
		if p.MinLength < 0 || p.MaxLength < 0 || p.MinLength > 65536 || p.MaxLength > 65536 || p.MaxLength != 0 && p.MinLength > p.MaxLength {
			add(field, "length_range", "parameter length limits are inconsistent or exceed 65536")
		}
		if p.Minimum != nil && p.Maximum != nil && *p.Minimum > *p.Maximum {
			add(field, "integer_range", "minimum exceeds maximum")
		}
		if len(p.Pattern) > 4096 {
			add(field+".pattern", "pattern_limit", "parameter pattern exceeds 4096 bytes")
		} else if p.Pattern != "" {
			if _, err := regexp.Compile(p.Pattern); err != nil {
				add(field+".pattern", "pattern", err.Error())
			}
		}
		switch p.Type {
		case "enum":
			if len(p.Enum) == 0 || len(p.Enum) > 100 {
				add(field+".enum", "enum_limit", "enum requires 1 to 100 choices")
			}
			seen := map[string]bool{}
			for _, item := range p.Enum {
				if seen[item] || len(item) > 4000 || !utf8.ValidString(item) {
					add(field+".enum", "enum_value", "enum choices must be unique UTF-8 strings of at most 4000 bytes")
				}
				seen[item] = true
			}
		case "string", "path", "int", "bool":
			if len(p.Enum) != 0 {
				add(field+".enum", "constraint_type", "enum choices are only supported for enum parameters")
			}
		default:
			add(field+".type", "parameter_type", "type must be string, int, bool, enum or path")
		}
		if p.Type != "int" && (p.Minimum != nil || p.Maximum != nil) {
			add(field, "constraint_type", "integer bounds require an int parameter")
		}
		if (p.Type == "int" || p.Type == "bool") && (p.Pattern != "" || p.MinLength != 0 || p.MaxLength != 0) {
			add(field, "constraint_type", "string constraints require a string, enum or path parameter")
		}
		if len(p.Default) != 0 {
			if _, err := parameterValue(p, p.Default); err != nil {
				add(field+".default", "default_value", err.Error())
			}
		}
	}
	validateText := func(field, value string, axes map[string][]string) {
		if !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 {
			add(field, "text", "template text must be valid UTF-8 without NUL")
			return
		}
		_, err := interpolate(value, func(ref string) (string, error) {
			kind, name, err := splitReference(ref)
			if err != nil {
				return "", err
			}
			if kind == "param" {
				if _, ok := parameters[name]; !ok {
					return "", fmt.Errorf("unknown parameter %s", name)
				}
			} else if _, ok := axes[name]; !ok {
				return "", fmt.Errorf("unknown or unavailable matrix axis %s", name)
			}
			return "value", nil
		})
		if err != nil {
			add(field, "placeholder", err.Error())
		}
	}
	validateText("projectName", d.ProjectName, nil)
	validateText("goal", d.Goal, nil)
	keys := map[string]Task{}
	productTotal := 0
	graphTasks := []mission.TaskSpec{}
	for i, t := range d.Tasks {
		field := fmt.Sprintf("tasks[%d]", i)
		if !identifier(t.Key) {
			add(field+".key", "identifier", "task key is not an ASCII identifier")
		}
		if _, ok := keys[t.Key]; ok {
			add(field+".key", "duplicate_task", "task key is repeated")
		}
		keys[t.Key] = t
		if !identifier(t.AgentRole) {
			add(field+".agentRole", "identifier", "agent role is not an ASCII identifier")
		}
		if len(t.Matrix) > 8 {
			add(field+".matrix", "axis_limit", "at most 8 matrix axes are supported")
		}
		product := 1
		for axis, values := range t.Matrix {
			if !identifier(axis) {
				add(field+".matrix", "identifier", "matrix axis is not an ASCII identifier")
			}
			if len(values) == 0 || len(values) > 64 {
				add(field+".matrix."+axis, "value_limit", "matrix axis requires 1 to 64 values")
			}
			if len(values) != 0 && product > MaxExpandedTasks/len(values) {
				product = MaxExpandedTasks + 1
			} else {
				product *= len(values)
			}
			seen := map[string]bool{}
			for _, value := range values {
				if len(value) > 4000 || seen[value] {
					add(field+".matrix."+axis, "matrix_value", "authored matrix values must be unique and at most 4000 bytes")
				}
				seen[value] = true
				validateText(field+".matrix."+axis, value, nil)
			}
		}
		productTotal += product
		if productTotal > MaxExpandedTasks {
			add(field+".matrix", "expansion_limit", "total matrix product exceeds 1000 tasks, including skipped candidates")
		}
		if strings.TrimSpace(t.Title) == "" || len(t.Title) > 500 {
			add(field+".title", "title", "task title requires 1 to 500 authored bytes")
		}
		if strings.TrimSpace(t.Prompt) == "" || len(t.Prompt) > 1<<20 {
			add(field+".prompt", "prompt", "task prompt requires 1 to 1 MiB")
		}
		validateText(field+".title", t.Title, t.Matrix)
		validateText(field+".prompt", t.Prompt, t.Matrix)
		validateText(field+".model", t.Model, t.Matrix)
		if len(t.Writes) > 1000 || len(t.Checks) > 100 || len(t.DependsOn) > 200 {
			add(field, "metadata_limit", "task writes, checks or dependencies exceed their limits")
		}
		for j, value := range t.Writes {
			validateText(fmt.Sprintf("%s.writes[%d]", field, j), value, t.Matrix)
		}
		required := false
		checks := append([]mission.CheckSpec(nil), t.Checks...)
		for j := range checks {
			c := &checks[j]
			required = required || c.Required
			for name, v := range map[string]*string{"id": &c.ID, "title": &c.Title, "path": &c.Path, "pattern": &c.Pattern} {
				checkField := fmt.Sprintf("%s.checks[%d].%s", field, j, name)
				validateText(checkField, *v, t.Matrix)
				*v = dummyText(*v)
			}
			c.Command = append([]string(nil), c.Command...)
			for k := range c.Command {
				validateText(fmt.Sprintf("%s.checks[%d].command[%d]", field, j, k), c.Command[k], t.Matrix)
				c.Command[k] = dummyText(c.Command[k])
			}
		}
		if !required {
			add(field+".checks", "required_check", "each task requires a required acceptance check")
		}
		if err := acceptance.ValidateChecks(checks); err != nil {
			add(field+".checks", "checks", err.Error())
		}
		if t.When != nil {
			nodes := 0
			if err := validateCondition(*t.When, parameters, t.Matrix, 0, &nodes); err != nil {
				add(field+".when", "condition", err.Error())
			}
		}
		deps := []string{}
		for _, dep := range t.DependsOn {
			deps = append(deps, dep.Task)
		}
		graphTasks = append(graphTasks, mission.TaskSpec{ID: t.Key, Title: "task", Prompt: "task", Priority: t.Priority, MaxAttempts: t.MaxAttempts, DependsOn: deps, Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Path: "artifact", Required: true}}})
	}
	for i, t := range d.Tasks {
		for j, dep := range t.DependsOn {
			field := fmt.Sprintf("tasks[%d].dependsOn[%d]", i, j)
			upstream, ok := keys[dep.Task]
			if !ok {
				add(field, "missing_dependency", "dependency task key does not exist")
				continue
			}
			seen := map[string]bool{}
			for _, axis := range dep.MatchAxes {
				_, left := t.Matrix[axis]
				_, right := upstream.Matrix[axis]
				if seen[axis] || !left || !right {
					add(field+".matchAxes", "axis_mapping", "matched axes must be unique and declared on both tasks")
				}
				seen[axis] = true
			}
		}
	}
	if err := plan.ValidatePlan(mission.Plan{Version: 1, Tasks: graphTasks}, d.Config); err != nil {
		add("tasks", "plan", err.Error())
	}
	if len(issues) != 0 {
		return &ValidationError{Issues: issues}
	}
	return nil
}

func dummyText(value string) string {
	result, err := interpolate(value, func(string) (string, error) { return "value", nil })
	if err != nil {
		return value
	}
	return result
}
