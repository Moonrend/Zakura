// SPDX-License-Identifier: AGPL-3.0-or-later
package projectexec

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

// dependencyComposer computes the causal baseline of a set of task outputs.
// Using the run's original baseline for every merge creates false conflicts in
// diamonds: an output that merely retains an ancestor's edit appears to oppose
// another output's later edit. The common ancestor set supplies the correct
// three-way base, including graphs with more than one maximal shared ancestor.
type dependencyComposer struct {
	provider  mission.WorkspaceProvider
	scope     mission.Scope
	root      string
	tasks     map[string]mission.Task
	ancestors map[string]map[string]bool
	visiting  map[string]bool
	composed  map[string]string
}

func (e *Engine) ComposeTaskOutputs(ctx context.Context, tenant, projectID, runID string, taskIDs []string) (string, error) {
	if e.store == nil || e.workspaces == nil {
		return "", errors.New("project execution dependencies are unavailable")
	}
	run, err := e.store.GetRun(ctx, tenant, projectID, runID)
	if err != nil {
		return "", err
	}
	project, err := e.store.GetRunProject(ctx, tenant, projectID, runID)
	if err != nil {
		return "", err
	}
	tasks, err := e.store.ListTasks(ctx, tenant, projectID, runID)
	if err != nil {
		return "", err
	}
	return ComposeTaskOutputs(ctx, e.workspaces, scopeOf(project), run.BaseSnapshot, tasks, taskIDs)
}

// ComposeTaskOutputs combines selected, accepted execution task IDs using the
// same causal baseline as the scheduler. Callers supply tasks read from the
// authorized run. Plan IDs are never accepted as execution identities here.
func ComposeTaskOutputs(ctx context.Context, provider mission.WorkspaceProvider, scope mission.Scope, root string, tasks []mission.Task, taskIDs []string) (string, error) {
	if len(taskIDs) == 0 {
		return "", errors.New("select at least one completed task output")
	}
	byID := make(map[string]mission.Task, len(tasks))
	for _, task := range tasks {
		byID[task.ID] = task
	}
	planIDs := make([]string, 0, len(taskIDs))
	seen := map[string]bool{}
	for _, id := range taskIDs {
		if seen[id] {
			return "", fmt.Errorf("task output %s was selected twice", id)
		}
		seen[id] = true
		task, ok := byID[id]
		if !ok {
			return "", fmt.Errorf("selected task output %s is outside this run", id)
		}
		if task.Status != "completed" || task.SnapshotID == "" {
			return "", fmt.Errorf("task output %s has not passed acceptance and review", id)
		}
		planIDs = append(planIDs, task.Spec.ID)
	}
	return composeDependencies(ctx, provider, scope, root, tasks, planIDs)
}

func composeDependencies(ctx context.Context, provider mission.WorkspaceProvider, scope mission.Scope, root string, tasks []mission.Task, ids []string) (string, error) {
	if root == "" {
		return "", errors.New("dependency composition requires an immutable run baseline")
	}
	c := &dependencyComposer{provider: provider, scope: scope, root: root, tasks: make(map[string]mission.Task, len(tasks)), ancestors: make(map[string]map[string]bool, len(tasks)), visiting: map[string]bool{}, composed: map[string]string{}}
	for _, task := range tasks {
		if task.Spec.ID == "" {
			return "", errors.New("task has no plan identity")
		}
		if _, exists := c.tasks[task.Spec.ID]; exists {
			return "", errors.New("duplicate plan task identity in run")
		}
		c.tasks[task.Spec.ID] = task
	}
	return c.compose(ctx, ids)
}

func (c *dependencyComposer) ancestry(id string) (map[string]bool, error) {
	if value, ok := c.ancestors[id]; ok {
		return value, nil
	}
	if c.visiting[id] {
		return nil, errors.New("persisted dependency graph contains a cycle")
	}
	task, ok := c.tasks[id]
	if !ok {
		return nil, fmt.Errorf("dependency %s is absent from frozen run", id)
	}
	c.visiting[id] = true
	ancestors := map[string]bool{}
	for _, parent := range task.Spec.DependsOn {
		ancestors[parent] = true
		inherited, err := c.ancestry(parent)
		if err != nil {
			return nil, err
		}
		for ancestor := range inherited {
			ancestors[ancestor] = true
		}
	}
	c.visiting[id] = false
	c.ancestors[id] = ancestors
	return ancestors, nil
}

func (c *dependencyComposer) maximal(ids []string) ([]string, error) {
	unique := map[string]bool{}
	for _, id := range ids {
		if _, err := c.ancestry(id); err != nil {
			return nil, err
		}
		unique[id] = true
	}
	for id := range unique {
		for ancestor := range c.ancestors[id] {
			delete(unique, ancestor)
		}
	}
	result := make([]string, 0, len(unique))
	for id := range unique {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

func (c *dependencyComposer) compose(ctx context.Context, ids []string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	heads, err := c.maximal(ids)
	if err != nil {
		return "", err
	}
	if len(heads) == 0 {
		return c.root, nil
	}
	key := strings.Join(heads, "\x00")
	if snapshot, ok := c.composed[key]; ok {
		return snapshot, nil
	}
	snapshots := make([]string, 0, len(heads))
	for _, id := range heads {
		task := c.tasks[id]
		if task.Status != "completed" || task.SnapshotID == "" {
			return "", fmt.Errorf("dependency %s has no completed immutable output", id)
		}
		snapshots = append(snapshots, task.SnapshotID)
	}
	if len(heads) == 1 {
		c.composed[key] = snapshots[0]
		return snapshots[0], nil
	}
	shared := make(map[string]bool, len(c.ancestors[heads[0]]))
	for id := range c.ancestors[heads[0]] {
		shared[id] = true
	}
	for _, head := range heads[1:] {
		for id := range shared {
			if !c.ancestors[head][id] {
				delete(shared, id)
			}
		}
	}
	common := make([]string, 0, len(shared))
	for id := range shared {
		common = append(common, id)
	}
	base, err := c.compose(ctx, common)
	if err != nil {
		return "", fmt.Errorf("compose shared dependency ancestors: %w", err)
	}
	sort.Strings(snapshots)
	result, err := c.provider.Compose(ctx, c.scope, base, snapshots)
	if err != nil {
		return "", fmt.Errorf("compose causal dependency outputs: %w", err)
	}
	if result == "" {
		return "", errors.New("workspace provider returned an empty dependency snapshot")
	}
	c.composed[key] = result
	return result, nil
}
