package main

import (
	"reflect"
	"testing"
)

func TestParseArgsAndPort(t *testing.T) {
	args, err := parseArgs(`["server","--flag","value with spaces"]`)
	if err != nil || !reflect.DeepEqual(args, []string{"server", "--flag", "value with spaces"}) {
		t.Fatalf("parseArgs=%q err=%v", args, err)
	}
	if _, err := parseArgs(`{"not":"an array"}`); err == nil {
		t.Fatal("non-array MCP_ARGS accepted")
	}
	if port, err := parsePort(""); err != nil || port != 3100 {
		t.Fatalf("default port=%d err=%v", port, err)
	}
	for _, raw := range []string{"0", "65536", "abc"} {
		if _, err := parsePort(raw); err == nil {
			t.Fatalf("invalid port %q accepted", raw)
		}
	}
}
