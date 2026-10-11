// SPDX-License-Identifier: AGPL-3.0-or-later
package blueprint

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

// DecodeStrict rejects duplicate JSON keys as well as unknown struct fields;
// accepting either would make imported previews disagree with their authors.
func DecodeStrict(raw []byte, target any) error {
	if len(raw) > MaxDocumentBytes {
		return invalid("document", "document_limit", "JSON document exceeds 2 MiB")
	}
	if !utf8.Valid(raw) {
		return invalid("document", "utf8", "JSON document is not valid UTF-8")
	}
	duplicateDecoder := json.NewDecoder(bytes.NewReader(raw))
	duplicateDecoder.UseNumber()
	nodes := 0
	if err := scanJSON(duplicateDecoder, 0, &nodes); err != nil {
		return invalid("document", "json", err.Error())
	}
	if _, err := duplicateDecoder.Token(); err != io.EOF {
		return invalid("document", "json", "JSON document requires exactly one value")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return invalid("document", "json", err.Error())
	}
	return nil
}

func scanJSON(decoder *json.Decoder, depth int, nodes *int) error {
	*nodes++
	if depth > 32 || *nodes > 100000 {
		return fmt.Errorf("JSON structure exceeds depth or node limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := token.(string)
			if !ok {
				return fmt.Errorf("object key must be a string")
			}
			if seen[key] {
				return fmt.Errorf("duplicate JSON key %q", key)
			}
			seen[key] = true
			if err := scanJSON(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim('}') {
			return fmt.Errorf("invalid object ending")
		}
	case '[':
		for decoder.More() {
			if err := scanJSON(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim(']') {
			return fmt.Errorf("invalid array ending")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	return nil
}

func Import(raw []byte) (Definition, error) {
	var document Document
	if err := DecodeStrict(raw, &document); err != nil {
		return Definition{}, err
	}
	if document.Schema != Schema || document.Version != Version {
		return Definition{}, invalid("document", "schema", "unsupported blueprint schema or version")
	}
	if err := Validate(document.Blueprint); err != nil {
		return Definition{}, err
	}
	return document.Blueprint, nil
}

func Export(d Definition) (Document, error) {
	if err := Validate(d); err != nil {
		return Document{}, err
	}
	return Document{Schema: Schema, Version: Version, Blueprint: d}, nil
}
