package host

import (
	"bytes"
	"sync"
	"testing"
)

func TestBoundedExecOutputCombinedBudget(t *testing.T) {
	budget := &outputBudget{remaining: 16384, limited: true}
	var out, stderr bytes.Buffer
	writers := []*boundedOutput{{budget: budget, dst: &out}, {budget: budget, dst: &stderr}}
	var wg sync.WaitGroup
	for _, writer := range writers {
		wg.Add(1)
		go func(w *boundedOutput) {
			defer wg.Done()
			payload := bytes.Repeat([]byte("x"), 10000)
			for i := 0; i < 10; i++ {
				if n, err := w.Write(payload); n != len(payload) || err != nil {
					t.Errorf("drain returned %d, %v", n, err)
				}
			}
		}(writer)
	}
	wg.Wait()
	if out.Len()+stderr.Len() != 16384 {
		t.Fatalf("combined bytes=%d", out.Len()+stderr.Len())
	}
}

func TestBoundedExecOutputDefaultCompatibility(t *testing.T) {
	var out bytes.Buffer
	writer := &boundedOutput{budget: &outputBudget{}, dst: &out}
	payload := bytes.Repeat([]byte("x"), 20000)
	_, _ = writer.Write(payload)
	if out.Len() != len(payload) {
		t.Fatal("default command output was truncated")
	}
}
