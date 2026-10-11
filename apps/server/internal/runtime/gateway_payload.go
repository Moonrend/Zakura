// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
)

// Leave nested JSON opaque on the common OpenAI path. This avoids decoding and
// rebuilding messages/tools and preserves integers larger than float64 can hold.
func prepareProviderPayload(protocol, operation, model string, original []byte) ([]byte, bool, error) {
	if protocol == "anthropic" || operation == "messages" {
		var body map[string]any
		decoder := json.NewDecoder(bytes.NewReader(original))
		decoder.UseNumber()
		if !json.Valid(original) || decoder.Decode(&body) != nil || body == nil {
			return nil, false, errors.New("invalid JSON body")
		}
		body["model"] = model
		body = normalizeProviderRequest(protocol, operation, body)
		streaming, _ := body["stream"].(bool)
		payload, err := json.Marshal(body)
		return payload, streaming, err
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(original, &body) != nil || body == nil {
		return nil, false, errors.New("invalid JSON body")
	}
	body["model"], _ = json.Marshal(model)
	var streaming bool
	_ = json.Unmarshal(body["stream"], &streaming)
	// RawMessage.MarshalJSON would validate and compact every nested value again.
	// They were already validated by Unmarshal, so copy them directly instead.
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	payload := make([]byte, 0, len(original)+len(body["model"])+16)
	payload = append(payload, '{')
	for i, key := range keys {
		if i > 0 {
			payload = append(payload, ',')
		}
		encodedKey, _ := json.Marshal(key)
		payload = append(payload, encodedKey...)
		payload = append(payload, ':')
		payload = append(payload, body[key]...)
	}
	payload = append(payload, '}')
	return payload, streaming, nil
}
