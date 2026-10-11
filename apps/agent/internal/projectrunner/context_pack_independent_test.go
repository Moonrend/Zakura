package projectrunner

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestIndependentContextCancelledRequestDoesNotWaitForProjectMutation(t *testing.T) {
	m, _, _ := testManager(t, &fakeExecutor{})
	params := scoped(map[string]any{"snapshotId": strings.Repeat("a", 64), "maxBytes": 512})
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	req, err := decodeContextRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	p, err := m.get(req.Scope)
	if err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	held := true
	defer func() {
		if held {
			p.mu.Unlock()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	finished := make(chan error, 1)
	go func() { _, e := m.ContextDispatch(ctx, "project.context.pack", raw); finished <- e }()
	select {
	case err = <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled request started work: %v", err)
		}
	case <-time.After(200 * time.Millisecond):
		// Release the fixture lock and collect the goroutine before reporting
		// failure; a regression must not hang the suite or leak work.
		p.mu.Unlock()
		held = false
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("context request remained blocked after releasing fixture lock")
		}
		t.Fatal("already-cancelled context waited for an unrelated project mutation")
	}
}
