package dial

import "testing"

func TestHubURL(t *testing.T) {
	got, err := hubURL("https://zakura.example/app")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://zakura.example/app/api/runtime-nodes/hub" {
		t.Fatalf("got %s", got)
	}
	got, err = hubURL("http://127.0.0.1:8787")
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://127.0.0.1:8787/api/runtime-nodes/hub" {
		t.Fatalf("got %s", got)
	}
}
