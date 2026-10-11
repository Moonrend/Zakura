// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
)

func fixture() Definition {
	return Definition{Name: "Translate", ProjectName: "{{param.product}} docs", Goal: "Publish {{param.product}} documentation", Parameters: []Parameter{{Name: "product", Title: "Product", Type: "string", Required: true, MaxLength: 100}, {Name: "output", Title: "Output", Type: "path", Default: defaultJSON("docs")}, {Name: "includeJapanese", Title: "Japanese", Type: "bool", Default: defaultJSON(true)}}, Config: recipeConfig(), Tasks: []Task{
		{Key: "write", Title: "Write {{matrix.locale}}", Prompt: "Produce {{param.product}} documentation in {{matrix.locale}}", AgentRole: "writer", Matrix: map[string][]string{"locale": {"en", "ja"}}, When: &Condition{Any: []Condition{{Ref: "matrix.locale", Op: "ne", Value: defaultJSON("ja")}, {Ref: "param.includeJapanese", Op: "eq", Value: defaultJSON(true)}}}, Writes: []string{"{{param.output}}/{{matrix.locale}}.json"}, Checks: []mission.CheckSpec{requiredJSON("doc", "{{param.output}}/{{matrix.locale}}.json")}},
		{Key: "review", Title: "Review {{matrix.locale}}", Prompt: "Review {{param.product}} documentation in {{matrix.locale}}", AgentRole: "reviewer", Matrix: map[string][]string{"locale": {"en", "ja"}}, When: &Condition{Any: []Condition{{Ref: "matrix.locale", Op: "ne", Value: defaultJSON("ja")}, {Ref: "param.includeJapanese", Op: "eq", Value: defaultJSON(true)}}}, DependsOn: []Dependency{{Task: "write", MatchAxes: []string{"locale"}}}, Writes: []string{"{{param.output}}/{{matrix.locale}}.review.json"}, Checks: []mission.CheckSpec{requiredJSON("review", "{{param.output}}/{{matrix.locale}}.review.json")}},
	}}
}

func inputs() Inputs {
	return Inputs{SpaceID: "space", Parameters: map[string]json.RawMessage{"product": defaultJSON("Zakura")}, AgentMapping: map[string]string{"writer": "writer-agent", "reviewer": "reviewer-agent"}}
}

func TestExpansionMapsDependenciesAndIsImmutable(t *testing.T) {
	d := fixture()
	before, _ := json.Marshal(d)
	x, err := Expand(d, inputs())
	if err != nil {
		t.Fatal(err)
	}
	if len(x.Project.Plan.Tasks) != 4 || len(x.Instances) != 4 || len(x.Skipped) != 0 {
		t.Fatalf("expansion: %#v", x)
	}
	byID := map[string]Instance{}
	for _, i := range x.Instances {
		byID[i.TaskID] = i
	}
	for _, task := range x.Project.Plan.Tasks {
		if strings.HasPrefix(task.ID, "review--") {
			if len(task.DependsOn) != 1 {
				t.Fatalf("review got %v", task.DependsOn)
			}
			if byID[task.ID].Axes["locale"] != byID[task.DependsOn[0]].Axes["locale"] {
				t.Fatal("cross-locale dependency")
			}
		}
	}
	x.Project.Plan.Tasks[0].Checks[0].Command = append(x.Project.Plan.Tasks[0].Checks[0].Command, "mutation")
	after, _ := json.Marshal(d)
	if string(before) != string(after) {
		t.Fatal("expansion mutated authored definition")
	}
	again, err := Expand(d, inputs())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(x.Instances, again.Instances) {
		t.Fatal("unstable IDs or ordering")
	}
}

func TestConditionsSkipMatchingBranchesAndAllDependencyFanIn(t *testing.T) {
	d := fixture()
	d.Tasks = append(d.Tasks, Task{Key: "index", Title: "Index", Prompt: "Index delivered docs", AgentRole: "writer", DependsOn: []Dependency{{Task: "review"}}, Writes: []string{"docs/index.json"}, Checks: []mission.CheckSpec{requiredJSON("index", "docs/index.json")}})
	in := inputs()
	in.Parameters["includeJapanese"] = defaultJSON(false)
	x, err := Expand(d, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(x.Project.Plan.Tasks) != 3 || len(x.Skipped) != 2 {
		t.Fatalf("tasks %d skipped %d", len(x.Project.Plan.Tasks), len(x.Skipped))
	}
	if len(x.Project.Plan.Tasks[2].DependsOn) != 1 {
		t.Fatal("disabled branch entered fan-in")
	}
	d.Tasks[1].When = nil
	if _, err = Expand(d, in); err == nil {
		t.Fatal("accepted dependency on disabled matching branch")
	}
}

func TestTypedParameterValidation(t *testing.T) {
	lo, hi := int64(2), int64(10)
	d := fixture()
	d.Parameters = append(d.Parameters, Parameter{Name: "count", Type: "int", Minimum: &lo, Maximum: &hi, Default: defaultJSON(3)}, Parameter{Name: "mode", Type: "enum", Enum: []string{"small", "large"}, Default: defaultJSON("small")})
	for _, tc := range []struct {
		name  string
		value json.RawMessage
	}{{"count", defaultJSON(1)}, {"count", defaultJSON(11)}, {"count", defaultJSON("3")}, {"count", json.RawMessage("3.5")}, {"count", json.RawMessage("1e100000")}, {"mode", defaultJSON("unknown")}, {"includeJapanese", defaultJSON("true")}, {"product", json.RawMessage("null")}, {"unknown", defaultJSON("x")}, {"output", defaultJSON("../escape")}, {"output", defaultJSON(".git/config")}, {"output", defaultJSON("a/./b")}, {"output", defaultJSON("C:/tmp")}} {
		t.Run(tc.name+string(tc.value), func(t *testing.T) {
			in := inputs()
			in.Parameters[tc.name] = tc.value
			if _, err := Expand(d, in); err == nil {
				t.Fatal("accepted invalid typed input")
			}
		})
	}
	if _, err := Expand(d, inputs()); err != nil {
		t.Fatal(err)
	}
}

func TestStrictPlaceholdersDoNotRescanInputs(t *testing.T) {
	d := fixture()
	in := inputs()
	in.Parameters["product"] = defaultJSON("{{param.untrusted}}")
	x, err := Expand(d, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(x.Project.Plan.Tasks[0].Prompt, "{{param.untrusted}}") {
		t.Fatal("parameter text was reinterpreted")
	}
	for _, value := range []string{"{{param.missing}}", "{{matrix.locale}}", "{{param.product}", "{{{param.product}}", "x }}", "{{ product }}"} {
		copy := d
		copy.ProjectName = value
		if err := Validate(copy); err == nil {
			t.Fatalf("accepted placeholder %q", value)
		}
	}
}

func TestExpansionLimitsAndDuplicateInterpolatedMatrixValues(t *testing.T) {
	d := fixture()
	d.Tasks[0].Matrix = map[string][]string{"locale": {"en", "ja"}, "platform": {"a", "b", "c", "d", "e", "f", "g", "h"}, "version": {"1", "2", "3", "4", "5", "6", "7", "8"}, "variant": {"1", "2", "3", "4", "5", "6", "7", "8"}}
	if err := Validate(d); err == nil {
		t.Fatal("accepted excessive matrix product")
	}
	d = fixture()
	d.Tasks[0].Matrix["locale"] = []string{"{{param.product}}", "Zakura"}
	if _, err := Expand(d, inputs()); err == nil {
		t.Fatal("accepted duplicate rendered matrix values")
	}
}

func TestExpansionRejectsLargeOutputBeforeBuildingWholePlan(t *testing.T) {
	d := fixture()
	d.Tasks = d.Tasks[:1]
	d.Tasks[0].When = nil
	d.Tasks[0].Prompt = "{{param.body}}"
	d.Tasks[0].Matrix = map[string][]string{"locale": {}, "variant": {"a", "b", "c", "d", "e", "f", "g", "h"}}
	for i := 0; i < 64; i++ {
		d.Tasks[0].Matrix["locale"] = append(d.Tasks[0].Matrix["locale"], strings.Repeat("x", i+1))
	}
	d.Parameters = append(d.Parameters, Parameter{Name: "body", Type: "string", Default: defaultJSON(strings.Repeat("x", 65536))})
	in := inputs()
	delete(in.AgentMapping, "reviewer")
	if _, err := Expand(d, in); err == nil {
		t.Fatal("accepted expanded output over 16 MiB")
	}
}

func TestConditionsRejectInvalidShapeTypesAndDepth(t *testing.T) {
	for _, condition := range []*Condition{{Ref: "param.includeJapanese", Op: "eq", Value: defaultJSON("true")}, {Ref: "param.product", Op: "eval", Value: defaultJSON("x")}, {All: []Condition{}}, {Ref: "param.product", Op: "present", Value: defaultJSON("x")}, {Ref: "param.missing", Op: "eq", Value: defaultJSON("x")}, {Ref: "matrix.missing", Op: "eq", Value: defaultJSON("x")}, {Ref: "param.product", Op: "eq", Value: defaultJSON("x"), Not: &Condition{Ref: "param.product", Op: "present"}}} {
		d := fixture()
		d.Tasks[0].When = condition
		if err := Validate(d); err == nil {
			t.Fatalf("accepted condition %#v", condition)
		}
	}
	condition := &Condition{Ref: "param.product", Op: "present"}
	for i := 0; i < 10; i++ {
		condition = &Condition{Not: condition}
	}
	d := fixture()
	d.Tasks[0].When = condition
	if err := Validate(d); err == nil {
		t.Fatal("accepted excessive condition depth")
	}
}

func TestBlueprintImportExportAndStrictJSON(t *testing.T) {
	d := fixture()
	document, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(document)
	got, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, d) {
		t.Fatal("document roundtrip changed definition")
	}
	for _, raw := range []string{`{"schema":"zakura.project-blueprint","schema":"bad","version":1}`, `{"schema":"zakura.project-blueprint","version":2}`, `{"schema":"zakura.project-blueprint","version":1,"unknown":true}`, `{} {}`, `{"a":{"b":1,"b":2}}`} {
		if _, err := Import([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid document %s", raw)
		}
	}
}

func TestRecipesAreValidExpandableAndIndependent(t *testing.T) {
	for _, recipe := range Recipes() {
		t.Run(recipe.ID, func(t *testing.T) {
			if err := Validate(recipe.Definition); err != nil {
				t.Fatal(err)
			}
			in := Inputs{SpaceID: "space", Parameters: map[string]json.RawMessage{}, AgentMapping: map[string]string{}}
			for _, p := range recipe.Definition.Parameters {
				if len(p.Default) == 0 {
					in.Parameters[p.Name] = defaultJSON("Implement an actual feature with concrete acceptance")
				}
			}
			for _, role := range Roles(recipe.Definition) {
				in.AgentMapping[role] = "agent"
			}
			if _, err := Expand(recipe.Definition, in); err != nil {
				t.Fatal(err)
			}
		})
	}
	first := Recipes()
	first[0].Definition.Tasks[0].Prompt = "corrupt"
	if Recipes()[0].Definition.Tasks[0].Prompt == "corrupt" {
		t.Fatal("shared mutable recipes")
	}
}

func FuzzImportNeverPanics(f *testing.F) {
	doc, _ := Export(fixture())
	raw, _ := json.Marshal(doc)
	f.Add(raw)
	f.Add([]byte(`{"schema":"zakura.project-blueprint","version":1}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		definition, err := Import(data)
		if err == nil {
			if err := Validate(definition); err != nil {
				t.Fatalf("accepted invalid definition: %v", err)
			}
		}
	})
}
