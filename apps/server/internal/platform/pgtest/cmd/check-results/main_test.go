package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCheckResults(t *testing.T) {
	const pass = `{"Action":"start","Package":"p"}
{"Action":"output","Package":"p","Output":"fixture output\n"}
{"Action":"pass","Package":"p","Test":"TestPostgres"}
{"Action":"pass","Package":"p"}
`
	for _, tc := range []struct {
		name, input, wantError string
	}{
		{name: "pass", input: pass},
		{name: "empty", wantError: "no passing tests"},
		{name: "package without tests", input: `{"Action":"pass","Package":"p"}`, wantError: "no passing tests"},
		{name: "skipped test", input: pass + `{"Action":"skip","Package":"p","Test":"TestOther"}`, wantError: "skipped"},
		{name: "skipped package", input: pass + `{"Action":"skip","Package":"other"}`, wantError: "skipped"},
		{name: "failed test", input: pass + `{"Action":"fail","Package":"p","Test":"TestOther"}`, wantError: "failed"},
		{name: "failed package", input: pass + `{"Action":"fail","Package":"other"}`, wantError: "failed"},
		{name: "truncated results", input: `{"Action":"pass","Package":"p","Test":"TestPostgres"}`, wantError: "did not complete"},
		{name: "partial package", input: pass + `{"Action":"start","Package":"other"}`, wantError: "did not complete"},
		{name: "malformed", input: pass + `{`, wantError: "invalid go test JSON"},
		{name: "null", input: `null`, wantError: "no passing tests"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			err := checkResults(strings.NewReader(tc.input), &output)
			if tc.wantError == "" {
				if err != nil {
					t.Fatal(err)
				}
				if output.String() != "fixture output\n" {
					t.Fatalf("output changed: %q", output.String())
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error=%v, want %q", err, tc.wantError)
			}
		})
	}
}
