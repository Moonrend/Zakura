// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/plan"
)

func Roles(d Definition) []string {
	seen := map[string]bool{}
	for _, task := range d.Tasks {
		seen[task.AgentRole] = true
	}
	roles := []string{}
	for role := range seen {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	return roles
}

func Expand(d Definition, inputs Inputs) (Expansion, error) {
	if err := Validate(d); err != nil {
		return Expansion{}, err
	}
	if strings.TrimSpace(inputs.SpaceID) == "" || len(inputs.SpaceID) > 128 || strings.ContainsAny(inputs.SpaceID, "\x00\r\n") {
		return Expansion{}, invalid("spaceId", "space", "space ID is required and must contain at most 128 bytes")
	}
	roles := Roles(d)
	knownRoles := map[string]bool{}
	for _, role := range roles {
		knownRoles[role] = true
		id := inputs.AgentMapping[role]
		if strings.TrimSpace(id) == "" || len(id) > 128 || strings.ContainsAny(id, "\x00\r\n") {
			return Expansion{}, invalid("agentMapping."+role, "agent_mapping", "each role requires an agent ID")
		}
	}
	for role := range inputs.AgentMapping {
		if !knownRoles[role] {
			return Expansion{}, invalid("agentMapping."+role, "unknown_role", "agent mapping contains an undeclared role")
		}
	}
	parameters, err := resolveParameters(d.Parameters, inputs.Parameters)
	if err != nil {
		return Expansion{}, err
	}
	name, err := render(d.ProjectName, parameters, nil)
	if err != nil {
		return Expansion{}, invalid("projectName", "placeholder", err.Error())
	}
	if inputs.Name != "" {
		name = inputs.Name
	}
	if strings.TrimSpace(name) == "" || len(name) > 500 {
		return Expansion{}, invalid("name", "name", "expanded project name requires 1 to 500 bytes")
	}
	goal, err := render(d.Goal, parameters, nil)
	if err != nil {
		return Expansion{}, invalid("goal", "placeholder", err.Error())
	}
	result := Expansion{Project: mission.Project{SpaceID: inputs.SpaceID, Name: name, Goal: goal, Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{}}, Config: d.Config}, Instances: []Instance{}, Skipped: []Instance{}, Roles: roles}
	expandedBytes := len(name) + len(goal)
	byKey := map[string][]Instance{}
	taskDefinitions := map[string]Task{}
	for _, authored := range d.Tasks {
		taskDefinitions[authored.Key] = authored
		axes, err := expandAxes(authored.Matrix, parameters)
		if err != nil {
			return Expansion{}, invalid("tasks."+authored.Key+".matrix", "matrix", err.Error())
		}
		for _, values := range axes {
			instance := Instance{TaskID: instanceID(authored.Key, values), Key: authored.Key, Axes: values}
			rawInstance, _ := json.Marshal(instance)
			expandedBytes += len(rawInstance)
			if expandedBytes > MaxExpandedBytes {
				return Expansion{}, invalid("tasks", "output_limit", "expanded blueprint exceeds 16 MiB")
			}
			enabled, err := evaluateCondition(authored.When, parameters, values)
			if err != nil {
				return Expansion{}, invalid("tasks."+authored.Key+".when", "condition", err.Error())
			}
			if !enabled {
				result.Skipped = append(result.Skipped, instance)
				continue
			}
			task, err := expandTask(authored, instance, parameters, inputs.AgentMapping[authored.AgentRole])
			if err != nil {
				return Expansion{}, invalid("tasks."+authored.Key, "expansion", err.Error())
			}
			rawTask, _ := json.Marshal(task)
			expandedBytes += len(rawTask)
			if expandedBytes > MaxExpandedBytes {
				return Expansion{}, invalid("tasks", "output_limit", "expanded blueprint exceeds 16 MiB")
			}
			result.Project.Plan.Tasks = append(result.Project.Plan.Tasks, task)
			result.Instances = append(result.Instances, instance)
			byKey[authored.Key] = append(byKey[authored.Key], instance)
		}
	}
	totalEdges := 0
	for i, instance := range result.Instances {
		task := &result.Project.Plan.Tasks[i]
		for _, dep := range taskDefinitions[instance.Key].DependsOn {
			matched := 0
			for _, upstream := range byKey[dep.Task] {
				matches := true
				for _, axis := range dep.MatchAxes {
					if instance.Axes[axis] != upstream.Axes[axis] {
						matches = false
						break
					}
				}
				if matches {
					totalEdges++
					expandedBytes += len(upstream.TaskID) + 3
					if totalEdges > 100000 || expandedBytes > MaxExpandedBytes {
						return Expansion{}, invalid("tasks", "output_limit", "expanded dependency graph exceeds its edge or byte limit")
					}
					task.DependsOn = append(task.DependsOn, upstream.TaskID)
					matched++
				}
			}
			if matched == 0 {
				return Expansion{}, invalid("tasks."+instance.Key+".dependsOn", "empty_dependency", fmt.Sprintf("task %s has no enabled matching instance of dependency %s", instance.TaskID, dep.Task))
			}
		}
		sort.Strings(task.DependsOn)
	}
	analysis, err := plan.Analyze(result.Project.Plan, result.Project.Config)
	if err != nil {
		return Expansion{}, err
	}
	result.Analysis = analysis
	metadata := analysis
	metadata.Nodes = nil
	metadata.Edges = nil
	metadata.Conflicts = nil
	rawMetadata, _ := json.Marshal(metadata)
	expandedBytes += len(rawMetadata)
	for _, node := range analysis.Nodes {
		raw, _ := json.Marshal(node)
		expandedBytes += len(raw) + 1
		if expandedBytes > MaxExpandedBytes {
			return Expansion{}, invalid("blueprint", "output_limit", "expanded blueprint and analysis exceed 16 MiB")
		}
	}
	for _, edge := range analysis.Edges {
		raw, _ := json.Marshal(edge)
		expandedBytes += len(raw) + 1
		if expandedBytes > MaxExpandedBytes {
			return Expansion{}, invalid("blueprint", "output_limit", "expanded blueprint and analysis exceed 16 MiB")
		}
	}
	for _, conflict := range analysis.Conflicts {
		raw, _ := json.Marshal(conflict)
		expandedBytes += len(raw) + 1
		if expandedBytes > MaxExpandedBytes {
			return Expansion{}, invalid("blueprint", "output_limit", "expanded blueprint and analysis exceed 16 MiB")
		}
	}
	rawResult, err := json.Marshal(result)
	if err != nil {
		return Expansion{}, err
	}
	if len(rawResult) > MaxExpandedBytes {
		return Expansion{}, invalid("blueprint", "output_limit", "expanded blueprint and analysis exceed 16 MiB")
	}
	return result, nil
}

func expandAxes(matrix map[string][]string, parameters map[string]any) ([]map[string]string, error) {
	names := []string{}
	for name := range matrix {
		names = append(names, name)
	}
	sort.Strings(names)
	instances := []map[string]string{{}}
	for _, name := range names {
		values := []string{}
		seen := map[string]bool{}
		for _, raw := range matrix[name] {
			value, err := render(raw, parameters, nil)
			if err != nil {
				return nil, err
			}
			if len(value) > 4000 {
				return nil, fmt.Errorf("expanded matrix value exceeds 4000 bytes")
			}
			if seen[value] {
				return nil, fmt.Errorf("axis %s has duplicate values after interpolation", name)
			}
			seen[value] = true
			values = append(values, value)
		}
		if len(values) == 0 || len(instances) > MaxExpandedTasks/len(values) {
			return nil, fmt.Errorf("matrix exceeds expansion limit")
		}
		next := []map[string]string{}
		for _, instance := range instances {
			for _, value := range values {
				item := map[string]string{}
				for axis, v := range instance {
					item[axis] = v
				}
				item[name] = value
				next = append(next, item)
			}
		}
		instances = next
	}
	return instances, nil
}

func instanceID(key string, axes map[string]string) string {
	if len(axes) == 0 {
		return key
	}
	raw, _ := json.Marshal(axes)
	hash := sha256.Sum256(append([]byte(key+"\x00"), raw...))
	return key + "--" + hex.EncodeToString(hash[:8])
}

func expandTask(authored Task, instance Instance, parameters map[string]any, agentID string) (mission.TaskSpec, error) {
	task := mission.TaskSpec{ID: instance.TaskID, AgentID: agentID, Priority: authored.Priority, MaxAttempts: authored.MaxAttempts, DependsOn: []string{}, Writes: []string{}, Checks: append([]mission.CheckSpec(nil), authored.Checks...)}
	totalText := 0
	renderField := func(value string, limit int) (string, error) {
		expanded, err := render(value, parameters, instance.Axes)
		if err != nil {
			return "", err
		}
		totalText += len(expanded)
		if len(expanded) > limit || totalText > 2<<20 {
			return "", fmt.Errorf("expanded field or task exceeds its byte limit")
		}
		return expanded, nil
	}
	for name, pair := range map[string]struct {
		value  string
		target *string
	}{"title": {authored.Title, &task.Title}, "prompt": {authored.Prompt, &task.Prompt}, "model": {authored.Model, &task.Model}} {
		limit := 1 << 20
		if name == "title" {
			limit = 500
		} else if name == "model" {
			limit = 256
		}
		value, err := renderField(pair.value, limit)
		if err != nil {
			return mission.TaskSpec{}, fmt.Errorf("%s: %w", name, err)
		}
		*pair.target = value
	}
	for _, write := range authored.Writes {
		value, err := renderField(write, 4096)
		if err != nil {
			return mission.TaskSpec{}, fmt.Errorf("write claim: %w", err)
		}
		task.Writes = append(task.Writes, value)
	}
	for i := range task.Checks {
		check := &task.Checks[i]
		for name, value := range map[string]*string{"id": &check.ID, "title": &check.Title, "path": &check.Path, "pattern": &check.Pattern} {
			limit := 64 << 10
			if name == "id" {
				limit = 128
			} else if name == "title" {
				limit = 500
			} else if name == "path" {
				limit = 4096
			}
			expanded, err := renderField(*value, limit)
			if err != nil {
				return mission.TaskSpec{}, fmt.Errorf("check %d %s: %w", i, name, err)
			}
			*value = expanded
		}
		check.Command = append([]string(nil), check.Command...)
		commandBytes := 0
		for j := range check.Command {
			expanded, err := renderField(check.Command[j], 128<<10)
			if err != nil {
				return mission.TaskSpec{}, fmt.Errorf("check %d command %d: %w", i, j, err)
			}
			check.Command[j] = expanded
			commandBytes += len(expanded)
			if commandBytes > 128<<10 {
				return mission.TaskSpec{}, fmt.Errorf("expanded command exceeds 128 KiB")
			}
		}
	}
	return task, nil
}
