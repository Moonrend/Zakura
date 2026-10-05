// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"strings"
	"testing"
)

func TestMCPResourceTemplateQualificationExpandsVariablesFaithfully(t *testing.T) {
	upstream := "repo://{owner}/{name}/files/{+path}{?ref,tags*}"
	qualified := qualifyMCPResourceTemplate("instance-one", upstream)
	for _, variable := range []string{"owner", "name", "path", "ref", "tags"} {
		if !strings.Contains(qualified, variable) {
			t.Fatalf("qualified template hid variable %q: %s", variable, qualified)
		}
	}
	expanded := strings.Replace(qualified, "{?owner,name,path,ref,tags}", "?owner=moon%20rend&name=zakura&path=docs/readme.md&ref=main&tags=go&tags=mcp", 1)
	instance, decoded, err := decodeMCPResourceURI(expanded)
	if err != nil {
		t.Fatal(err)
	}
	if instance != "instance-one" {
		t.Fatalf("instance mismatch: %q", instance)
	}
	if decoded != "repo://moon%20rend/zakura/files/docs/readme.md?ref=main&tags=go&tags=mcp" {
		t.Fatalf("upstream expansion mismatch: %q", decoded)
	}
}

func TestExpandURITemplateOperatorsAndPrefix(t *testing.T) {
	qualified := qualifyMCPResourceTemplate("i", "https://example.test{/segments*}{;lang}{#fragment:4}")
	expanded := strings.Replace(qualified, "{?segments,lang,fragment}", "?segments=one&segments=two&lang=en&fragment=abcdef", 1)
	_, decoded, err := decodeMCPResourceURI(expanded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded != "https://example.test/one/two;lang=en#abcd" {
		t.Fatalf("operator expansion mismatch: %q", decoded)
	}
}
