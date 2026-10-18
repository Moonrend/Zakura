package executor

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestExecutorProcess(t *testing.T) {
	if os.Getenv("ZAKURA_EXECUTOR_FIXTURE") == "" {
		return
	}
	fmt.Println("fixture-ready")
	if os.Getenv("ZAKURA_EXECUTOR_FIXTURE") == "sleep" {
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fmt.Println("echo:" + scanner.Text())
	}
	os.Exit(0)
}

func request(t *testing.T, e *Executor, method string, params any, send func(Message)) Message {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var response Message
	e.Dispatch(context.Background(), Message{Type: "req", ID: method, Method: method, Params: raw}, func(m Message) {
		if m.Type == "res" {
			response = m
		} else if send != nil {
			send(m)
		}
	})
	if response.OK == nil || !*response.OK {
		t.Fatalf("%s failed: %s", method, response.Error)
	}
	return response
}

func TestExecutorRealRPCAndInteractiveLifecycle(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "0")
	e := New("local", t.TempDir())
	defer e.Close()
	events := make(chan Message, 128)
	req := request(t, e, "host.pty.start", map[string]any{"command": []string{os.Args[0], "-test.run=^TestExecutorProcess$"}, "env": map[string]string{"ZAKURA_EXECUTOR_FIXTURE": "echo"}, "cols": 80, "rows": 24}, func(m Message) { events <- m })
	var result struct{ ID string }
	if err := json.Unmarshal(req.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.ID == "" {
		t.Fatal("stream id missing")
	}
	request(t, e, "host.pty.resize", map[string]any{"id": result.ID, "cols": 100, "rows": 40}, nil)
	input := "roundtrip\n"
	if runtime.GOOS == "windows" {
		input = "roundtrip\r"
	}
	request(t, e, "host.pty.write", map[string]any{"id": result.ID, "data": input}, nil)
	deadline := time.After(5 * time.Second)
	output := ""
	for !strings.Contains(output, "echo:roundtrip") {
		select {
		case m := <-events:
			if m.Stream != result.ID {
				t.Fatal("wrong stream identity")
			}
			b, err := base64.StdEncoding.DecodeString(m.Data)
			if err != nil {
				t.Fatal(err)
			}
			output += string(b)
		case <-deadline:
			t.Fatalf("interactive output missing: %q", output)
		}
	}
	request(t, e, "host.pty.close", map[string]any{"id": result.ID}, nil)
	for {
		select {
		case m := <-events:
			if m.Chan == "exit" {
				return
			}
		case <-deadline:
			t.Fatal("close did not emit exit")
		}
	}
}

func TestExecutorCancelAndClose(t *testing.T) {
	t.Setenv("ZAKURA_SANDBOX_ENABLED", "0")
	e := New("local", t.TempDir())
	raw, _ := json.Marshal(map[string]any{"command": []string{os.Args[0], "-test.run=^TestExecutorProcess$"}, "env": map[string]string{"ZAKURA_EXECUTOR_FIXTURE": "sleep"}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.Dispatch(ctx, Message{Type: "req", ID: "cancel-me", Method: "host.exec", Params: raw}, func(Message) {})
	}()
	time.AfterFunc(100*time.Millisecond, cancel)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("host exec ignored cancellation")
	}
	events := make(chan Message, 128)
	request(t, e, "host.pty.start", map[string]any{"command": []string{os.Args[0], "-test.run=^TestExecutorProcess$"}, "env": map[string]string{"ZAKURA_EXECUTOR_FIXTURE": "echo"}}, func(m Message) { events <- m })
	e.Close()
	e.Close()
	for {
		select {
		case m := <-events:
			if m.Chan == "exit" {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("executor close leaked interactive process")
		}
	}
}
