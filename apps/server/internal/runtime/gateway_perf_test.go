// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func BenchmarkGatewayFirstEvent(b *testing.B) {
	event := "data: " + strings.Repeat("x", 32<<10) + "\n\n"
	b.ReportAllocs()
	b.SetBytes(int64(len(event)))
	for b.Loop() {
		if _, err := readStreamCommit(bufio.NewReader(strings.NewReader(event))); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGatewayCandidatePayload(b *testing.B) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, "{}")
	}))
	defer upstream.Close()
	gateway := NewGateway(nil)
	defer gateway.client.CloseIdleConnections()
	config := Upstream{Protocol: "openai", Config: raw(map[string]any{"baseUrl": upstream.URL})}
	route := ModelRoute{Model: "actual-model"}
	payload := []byte(`{"model":"alias","messages":[{"role":"user","content":"` + strings.Repeat("hello ", 10000) + `"}],"metadata":{"id":9007199254740993}}`)
	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for b.Loop() {
		resp, err := gateway.doCandidate(context.Background(), "tenant", "chat", payload, route, config)
		if err != nil {
			b.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

func BenchmarkGatewayResolveCandidates(b *testing.B) {
	for _, count := range []int{1, 32, 128} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			deps := testDeps(b)
			seedTenant(b, deps, "tenant")
			store := NewStore(deps)
			for i := 0; i < count; i++ {
				up, err := store.CreateUpstream(context.Background(), "tenant", Upstream{Name: fmt.Sprint(i)})
				if err != nil {
					b.Fatal(err)
				}
				_, err = store.CreateRoute(context.Background(), "tenant", ModelRoute{Name: fmt.Sprint(i), Model: "m", UpstreamID: up.ID, IsDefault: true})
				if err != nil {
					b.Fatal(err)
				}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				candidates, err := store.ResolveCandidates(context.Background(), "tenant", "chat", "m")
				if err != nil || len(candidates) != count {
					b.Fatalf("candidates=%d err=%v", len(candidates), err)
				}
			}
		})
	}
}
