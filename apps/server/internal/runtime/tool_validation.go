// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const toolSchemaMaxBytes = 1 << 20
const toolArgumentsMaxBytes = 4 << 20

type toolSchemaLoader struct{}

func (toolSchemaLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("external tool schema reference is disabled: %s", url)
}

var toolSchemas = struct {
	sync.Mutex
	entries map[[32]byte]*jsonschema.Schema
}{entries: make(map[[32]byte]*jsonschema.Schema)}

// validateToolArguments never changes arguments or loads external resources.
// Callers pass the catalog snapshot they already used to resolve the tool.
func validateToolArguments(tool agentTool, args json.RawMessage) error {
	if len(args) > toolArgumentsMaxBytes {
		return errors.New("tool arguments exceed 4 MiB")
	}
	if !json.Valid(args) {
		return errors.New("invalid tool arguments: expected JSON")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(args))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if _, ok := value.(map[string]any); !ok {
		return errors.New("tool arguments must be a JSON object")
	}
	schema := tool.InputSchema
	if schema == nil {
		return nil
	}
	raw, err := json.Marshal(schema)
	if err != nil || len(raw) > toolSchemaMaxBytes {
		return fmt.Errorf("invalid schema for tool %s: schema must fit in 1 MiB", tool.Name)
	}
	key := sha256.Sum256(raw)
	toolSchemas.Lock()
	compiled := toolSchemas.entries[key]
	toolSchemas.Unlock()
	if compiled == nil {
		var doc any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&doc); err != nil {
			return err
		}
		compiler := jsonschema.NewCompiler()
		compiler.DefaultDraft(jsonschema.Draft2020)
		compiler.UseLoader(toolSchemaLoader{})
		const location = "https://zakura.invalid/tool-schema.json"
		if err = compiler.AddResource(location, doc); err == nil {
			compiled, err = compiler.Compile(location)
		}
		if err != nil {
			return fmt.Errorf("invalid schema for tool %s: %w", tool.Name, err)
		}
		toolSchemas.Lock()
		if len(toolSchemas.entries) >= 128 {
			clear(toolSchemas.entries)
		}
		toolSchemas.entries[key] = compiled
		toolSchemas.Unlock()
	}
	if err := compiled.Validate(value); err != nil {
		return fmt.Errorf("invalid arguments for %s: %w", tool.Name, err)
	}
	return nil
}

func catalogTool(catalog agentCatalog, name string) agentTool {
	for _, tool := range catalog.Tools {
		if tool.Name == name {
			return tool
		}
	}
	return agentTool{Name: name}
}
