// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"testing"
)

func TestCatalogContainerPorts(t *testing.T) {
	want := map[string]int{"searxng": 8080, "jina-reader": 8081, "crawl4ai": 11235, "firecrawl": 3002}
	for key, port := range want {
		if got := catalogContainerPort(key); got != port {
			t.Fatalf("catalogContainerPort(%q) = %d, want %d", key, got, port)
		}
	}
	if got := catalogContainerPort("unknown"); got != 0 {
		t.Fatalf("catalogContainerPort(unknown) = %d, want 0", got)
	}
}

func TestContainerRuntimeDetected(t *testing.T) {
	detect := func(paths ...string) bool {
		return containerRuntimeDetected(func(p string) bool {
			for _, x := range paths {
				if x == p {
					return true
				}
			}
			return false
		})
	}
	if !detect("/.dockerenv") {
		t.Fatal("expected /.dockerenv to be detected")
	}
	if !detect("/run/.containerenv") {
		t.Fatal("expected /run/.containerenv to be detected")
	}
	if detect() {
		t.Fatal("expected no detection without marker files")
	}
}

func TestEndpointModeFor(t *testing.T) {
	if got := endpointModeFor(true); got != "network" {
		t.Fatalf("endpointModeFor(true) = %q, want network", got)
	}
	if got := endpointModeFor(false); got != "published" {
		t.Fatalf("endpointModeFor(false) = %q, want published", got)
	}
}

func TestPlatformServiceNetworkName(t *testing.T) {
	t.Setenv("ZAKURA_DOCKER_NETWORK", "")
	if got := platformServiceNetworkName(); got != "zakura" {
		t.Fatalf("default network = %q, want zakura", got)
	}
	t.Setenv("ZAKURA_DOCKER_NETWORK", "  custom-net  ")
	if got := platformServiceNetworkName(); got != "custom-net" {
		t.Fatalf("custom network = %q, want custom-net", got)
	}
}

func TestPlatformServiceHostPort(t *testing.T) {
	meta := catalogService("searxng")
	if got := platformServiceHostPort(map[string]any{}, meta); got != 18080 {
		t.Fatalf("default host port = %d, want 18080", got)
	}
	if got := platformServiceHostPort(map[string]any{"hostPort": float64(19000)}, meta); got != 19000 {
		t.Fatalf("configured host port = %d, want 19000", got)
	}
	if got := platformServiceHostPort(map[string]any{"hostPort": json.Number("19001")}, meta); got != 19001 {
		t.Fatalf("json.Number host port = %d, want 19001", got)
	}
	if got := platformServiceHostPort(map[string]any{"hostPort": float64(0)}, meta); got != 18080 {
		t.Fatalf("zero host port falls back = %d, want 18080", got)
	}
}

func TestManagedServiceEndpoint(t *testing.T) {
	cases := []struct {
		mode          string
		name          string
		containerPort int
		hostPort      int
		want          string
	}{
		{"published", "zakura-service-searxng", 8080, 18080, "http://127.0.0.1:18080"},
		{"network", "zakura-service-searxng", 8080, 18080, "http://zakura-service-searxng:8080"},
		{"network", "zakura-service-firecrawl", 3002, 13002, "http://zakura-service-firecrawl:3002"},
		{"published", "zakura-service-jina-reader", 8081, 0, ""},
		{"network", "zakura-service-jina-reader", 0, 18081, ""},
	}
	for _, c := range cases {
		if got := managedServiceEndpoint(c.mode, c.name, c.containerPort, c.hostPort); got != c.want {
			t.Fatalf("managedServiceEndpoint(%q,%q,%d,%d) = %q, want %q", c.mode, c.name, c.containerPort, c.hostPort, got, c.want)
		}
	}
}

func TestPlatformServiceContainerBodyPublished(t *testing.T) {
	body := platformServiceContainerBody("searxng/searxng:latest", []string{"A=B"}, "searxng", "published", "zakura", 8080, 18080)
	if body["Image"] != "searxng/searxng:latest" {
		t.Fatalf("image = %v", body["Image"])
	}
	if _, ok := body["NetworkingConfig"]; ok {
		t.Fatal("published body must not carry NetworkingConfig")
	}
	exposed, ok := body["ExposedPorts"].(map[string]any)
	if !ok {
		t.Fatalf("ExposedPorts missing: %#v", body["ExposedPorts"])
	}
	if _, ok := exposed["8080/tcp"]; !ok {
		t.Fatalf("ExposedPorts missing 8080/tcp: %#v", exposed)
	}
	hc, ok := body["HostConfig"].(map[string]any)
	if !ok {
		t.Fatalf("HostConfig missing: %#v", body["HostConfig"])
	}
	bindings, ok := hc["PortBindings"].(map[string]any)
	if !ok {
		t.Fatalf("PortBindings missing: %#v", hc["PortBindings"])
	}
	entry, ok := bindings["8080/tcp"].([]map[string]string)
	if !ok || len(entry) != 1 {
		t.Fatalf("port binding shape: %#v", bindings["8080/tcp"])
	}
	if entry[0]["HostIp"] != "127.0.0.1" || entry[0]["HostPort"] != "18080" {
		t.Fatalf("port binding = %#v", entry[0])
	}
}

func TestPlatformServiceContainerBodyNetwork(t *testing.T) {
	body := platformServiceContainerBody("searxng/searxng:latest", nil, "searxng", "network", "zakura", 8080, 18080)
	if _, ok := body["HostConfig"]; ok {
		t.Fatal("network body must not carry HostConfig port bindings")
	}
	nc, ok := body["NetworkingConfig"].(map[string]any)
	if !ok {
		t.Fatalf("NetworkingConfig missing: %#v", body["NetworkingConfig"])
	}
	endpoints, ok := nc["EndpointsConfig"].(map[string]any)
	if !ok {
		t.Fatalf("EndpointsConfig missing: %#v", nc["EndpointsConfig"])
	}
	if _, ok := endpoints["zakura"]; !ok {
		t.Fatalf("EndpointsConfig missing network: %#v", endpoints)
	}
}

func TestPlatformServiceContainerBodyNoPort(t *testing.T) {
	body := platformServiceContainerBody("img", nil, "unknown", "published", "zakura", 0, 0)
	if _, ok := body["ExposedPorts"]; ok {
		t.Fatal("body without container port must not expose ports")
	}
	if _, ok := body["HostConfig"]; ok {
		t.Fatal("body without container port must not bind ports")
	}
	if body["Labels"].(map[string]string)["com.zakura.platform-service"] != "unknown" {
		t.Fatalf("labels = %#v", body["Labels"])
	}
}
