package semantic

import (
	"context"
	"strings"
	"unicode"
	"unicode/utf8"
)

type scriptToken struct {
	text       string
	kind       string
	start, end int
}

var scriptKeywords = map[string]bool{
	"as": true, "async": true, "await": true, "break": true, "case": true, "catch": true, "class": true, "const": true, "continue": true, "debugger": true, "declare": true, "default": true, "delete": true, "do": true, "else": true, "enum": true, "export": true, "extends": true, "false": true, "finally": true, "for": true, "from": true, "function": true, "get": true, "if": true, "implements": true, "import": true, "in": true, "infer": true, "instanceof": true, "interface": true, "is": true, "keyof": true, "let": true, "namespace": true, "new": true, "null": true, "of": true, "private": true, "protected": true, "public": true, "readonly": true, "return": true, "set": true, "static": true, "super": true, "switch": true, "this": true, "throw": true, "true": true, "try": true, "type": true, "typeof": true, "undefined": true, "var": true, "void": true, "while": true, "with": true, "yield": true,
}

func identifierStart(r rune) bool { return r == '_' || r == '$' || unicode.IsLetter(r) }
func identifierPart(r rune) bool {
	return identifierStart(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r)
}
func canStartRegex(tokens []scriptToken) bool {
	if len(tokens) == 0 {
		return true
	}
	t := tokens[len(tokens)-1].text
	switch t {
	case "(", "[", "{", "=", ":", ",", ";", "!", "?", "return", "throw", "case", "=>", "&&", "||", "??":
		return true
	}
	return false
}
func lexScript(ctx context.Context, data []byte, state *buildState) ([]scriptToken, []Diagnostic) {
	tokens := []scriptToken{}
	diagnostics := []Diagnostic{}
	ps := positions(data)
	addDiagnostic := func(code, msg string, start, end int) {
		if len(diagnostics) < 50 {
			r := ps.rangeAt(start, end)
			diagnostics = append(diagnostics, Diagnostic{Code: code, Message: msg, Severity: "warning", Range: &r})
		}
	}
	for offset := 0; offset < len(data); {
		if ctx.Err() != nil || state.stopped {
			break
		}
		r, size := utf8.DecodeRune(data[offset:])
		if unicode.IsSpace(r) {
			offset += size
			continue
		}
		start := offset
		if r == '/' && offset+1 < len(data) && data[offset+1] == '/' {
			offset += 2
			for offset < len(data) && data[offset] != '\n' {
				offset++
			}
			continue
		}
		if r == '/' && offset+1 < len(data) && data[offset+1] == '*' {
			offset += 2
			closed := false
			for offset+1 < len(data) {
				if data[offset] == '*' && data[offset+1] == '/' {
					offset += 2
					closed = true
					break
				}
				offset++
			}
			if !closed {
				offset = len(data)
				addDiagnostic("unterminated_comment", "Unterminated block comment.", start, offset)
			}
			continue
		}
		kind := "punctuation"
		switch {
		case identifierStart(r):
			kind = "identifier"
			offset += size
			for offset < len(data) {
				r, n := utf8.DecodeRune(data[offset:])
				if !identifierPart(r) {
					break
				}
				offset += n
			}
		case unicode.IsDigit(r):
			kind = "number"
			offset += size
			for offset < len(data) {
				r, n := utf8.DecodeRune(data[offset:])
				if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '.' && r != '_' {
					break
				}
				offset += n
			}
		case r == '\'' || r == '"' || r == '`':
			quote := byte(r)
			kind = "string"
			if quote == '`' {
				kind = "template"
			}
			offset++
			closed := false
			for offset < len(data) {
				b := data[offset]
				if b == '\\' {
					offset += 2
					if offset > len(data) {
						offset = len(data)
					}
					continue
				}
				offset++
				if b == quote {
					closed = true
					break
				}
				if quote != '`' && b == '\n' {
					break
				}
			}
			if !closed {
				addDiagnostic("unterminated_literal", "Unterminated literal; following declarations may be incomplete.", start, offset)
			}
			if quote == '`' && strings.Contains(string(data[start:offset]), "${") {
				addDiagnostic("template_expression", "Template expression bodies are omitted from lexical indexing.", start, offset)
			}
		case r == '/' && canStartRegex(tokens):
			kind = "regex"
			offset++
			closed := false
			inClass := false
			for offset < len(data) {
				b := data[offset]
				if b == '\\' {
					offset += 2
					if offset > len(data) {
						offset = len(data)
					}
					continue
				}
				if b == '\n' {
					break
				}
				offset++
				if b == '[' {
					inClass = true
				}
				if b == ']' {
					inClass = false
				}
				if b == '/' && !inClass {
					closed = true
					break
				}
			}
			if closed {
				for offset < len(data) {
					r, n := utf8.DecodeRune(data[offset:])
					if !unicode.IsLetter(r) {
						break
					}
					offset += n
				}
			} else {
				addDiagnostic("unterminated_regex", "Unterminated regular-expression literal.", start, offset)
			}
		default:
			offset += size
			if offset < len(data) {
				pair := string(data[start : offset+1])
				switch pair {
				case "=>", "?.", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "**", "+=", "-=", "*=", "/=":
					offset++
				}
			}
		}
		if !state.node() {
			break
		}
		tokens = append(tokens, scriptToken{text: string(data[start:offset]), kind: kind, start: start, end: offset})
	}
	return tokens, diagnostics
}
func tokenLiteral(t scriptToken) (string, bool) {
	if t.kind != "string" || len(t.text) < 2 {
		return "", false
	}
	value := t.text[1 : len(t.text)-1]
	if strings.Contains(value, "\\") || strings.ContainsAny(value, "\r\n") {
		return "", false
	}
	return value, true
}
func scriptSignature(tokens []scriptToken, start int) string {
	end := start
	depth := 0
	for end < len(tokens) && end-start < 200 {
		t := tokens[end].text
		if depth == 0 && (t == "{" || t == "=" || t == ";" || t == "=>") {
			break
		}
		if t == "(" || t == "[" || t == "<" {
			depth++
		}
		if t == ")" || t == "]" || t == ">" {
			if depth > 0 {
				depth--
			}
		}
		end++
	}
	words := []string{}
	for _, t := range tokens[start:end] {
		words = append(words, t.text)
	}
	return strings.Join(words, " ")
}
func parseScript(ctx context.Context, f *File, data []byte, state *buildState) {
	f.Status = "partial"
	f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "lexical_analysis", "Lexical analysis is partial; syntax and type correctness were not checked.", "info"))
	tokens, diagnostics := lexScript(ctx, data, state)
	for _, d := range diagnostics {
		d.Path = f.Path
		f.Diagnostics = append(f.Diagnostics, d)
	}
	ps := positions(data)
	definitions := map[int]string{}
	depth := 0
	add := func(t scriptToken, kind, signature string, exported bool, keyName string) {
		if t.kind != "identifier" && keyName != "default" {
			return
		}
		name := t.text
		if keyName == "" {
			keyName = name
		}
		s := Symbol{ID: symbolID(f.Path, kind, name, t.start), Key: apiKey(*f, kind, keyName, ""), Name: name, Kind: kind, Path: f.Path, Exported: exported, Signature: signature, Range: ps.rangeAt(t.start, t.end), Selection: ps.rangeAt(t.start, t.end), Confidence: "lexical"}
		if state.addSymbol(f, s) {
			definitions[t.start] = s.ID
		}
	}
	for i, t := range tokens {
		if ctx.Err() != nil || state.stopped {
			break
		}
		if t.text == "{" {
			depth++
		}
		if t.text == "}" && depth > 0 {
			depth--
		}
		if t.text == "import" || t.text == "export" {
			isImport := t.text == "import"
			dynamic := i+1 < len(tokens) && tokens[i+1].text == "("
			// Static imports/reexports and literal dynamic imports are dependency
			// evidence. Expression-based paths are explicitly left unresolved.
			stop := i + 1
			for stop < len(tokens) && stop-i < 150 {
				u := tokens[stop]
				if u.text == ";" || (u.text == "\n") {
					break
				}
				if u.kind == "string" {
					if module, ok := tokenLiteral(u); ok && (isImport || stop > i+1 && tokens[stop-1].text == "from") {
						f.Imports = append(f.Imports, Import{Path: module, Range: ps.rangeAt(u.start, u.end), Targets: []string{}, Confidence: "lexical"})
						break
					}
				}
				if stop > i+1 && (u.text == "function" || u.text == "class" || u.text == "const") {
					break
				}
				stop++
			}
			if dynamic && (i+2 >= len(tokens) || tokens[i+2].kind != "string") {
				f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "dynamic_import", "Nonliteral dynamic import cannot be resolved.", "info"))
			}
			if isImport && !dynamic {
				for j := i + 1; j < stop && j < len(tokens); j++ {
					u := tokens[j]
					if u.text == "from" {
						break
					}
					if u.kind == "identifier" && !scriptKeywords[u.text] {
						if j+1 < stop && tokens[j+1].text == "as" {
							continue
						}
						add(u, "import", u.text, false, "")
					}
				}
			}
			if !isImport && i+1 < len(tokens) && tokens[i+1].text == "{" {
				for j := i + 2; j < len(tokens) && j-i < 150 && tokens[j].text != "}"; j++ {
					u := tokens[j]
					if u.kind != "identifier" || scriptKeywords[u.text] {
						continue
					}
					name := u.text
					alias := u
					if j+2 < len(tokens) && tokens[j+1].text == "as" {
						alias = tokens[j+2]
						j += 2
					}
					add(alias, "export", name+" as "+alias.text, true, alias.text)
				}
			}
		}
		if t.text == "require" && i+3 < len(tokens) && tokens[i+1].text == "(" && tokens[i+3].text == ")" {
			if module, ok := tokenLiteral(tokens[i+2]); ok {
				f.Imports = append(f.Imports, Import{Path: module, Range: ps.rangeAt(tokens[i+2].start, tokens[i+2].end), Targets: []string{}, Confidence: "lexical"})
			}
		}
		kind := ""
		switch t.text {
		case "function":
			kind = "function"
		case "class":
			kind = "class"
		case "interface":
			kind = "interface"
		case "type":
			kind = "type"
		case "enum":
			kind = "enum"
		case "const", "let", "var":
			kind = "variable"
		}
		if kind == "" {
			continue
		}
		start := i + 1
		if start < len(tokens) && tokens[start].text == "*" {
			start++
		}
		if start >= len(tokens) {
			continue
		}
		exported, defaultExport := false, false
		for j := i - 1; j >= 0 && i-j <= 4; j-- {
			if tokens[j].text == "export" {
				exported = true
				break
			}
			if tokens[j].text == "default" {
				defaultExport = true
			}
			if tokens[j].text != "async" && tokens[j].text != "declare" && tokens[j].text != "default" {
				break
			}
		}
		if depth > 0 {
			exported = false
		}
		if tokens[start].kind == "identifier" && !scriptKeywords[tokens[start].text] {
			key := ""
			if defaultExport {
				key = "default"
			}
			add(tokens[start], kind, scriptSignature(tokens, i), exported, key)
		} else if exported && defaultExport {
			token := tokens[i]
			token.kind = "identifier"
			token.text = "default"
			add(token, kind, scriptSignature(tokens, i), true, "default")
		} else if tokens[start].text == "{" || tokens[start].text == "[" {
			f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "destructured_declaration", "Destructured declarations are omitted from exported API matching.", "info"))
		}
	}
	for i, t := range tokens {
		if state.stopped || ctx.Err() != nil {
			break
		}
		if t.kind != "identifier" || scriptKeywords[t.text] || definitions[t.start] != "" {
			continue
		}
		ref := Reference{Path: f.Path, Name: t.text, Kind: "reference", Range: ps.rangeAt(t.start, t.end), SymbolIDs: []string{}, Confidence: "lexical"}
		if i+1 < len(tokens) && tokens[i+1].text == "(" {
			ref.Kind = "call"
		}
		if i > 1 && (tokens[i-1].text == "." || tokens[i-1].text == "?.") {
			ref.Kind = "selector"
			ref.Qualifier = tokens[i-2].text
		}
		state.addReference(f, ref)
	}
	if state.stopped {
		f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "index_limit", "Source indexing stopped at the shared resource limit.", "warning"))
	}
}
