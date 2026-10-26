//go:build !windows

package host

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerInteractiveTTYInputResizeClose(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "docker")
	script := `#!/bin/sh
[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = -t ] || exit 2
exec /bin/sh -c 'test -t 0 && test -t 1 || exit 3; stty -echo; printf "TTY_READY\n"; while IFS= read -r line; do case "$line" in size) stty size;; quit) exit 0;; *) printf "INPUT=%s\n" "$line";; esac; done'
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	session, err := StartDockerExecTTY("login-container", []string{"sh"}, "", nil, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if session.Mode != "pty" {
		t.Fatalf("mode=%s", session.Mode)
	}
	output := make(chan string, 64)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, e := session.Read(buf)
			if n > 0 {
				output <- string(buf[:n])
			}
			if e != nil {
				close(output)
				return
			}
		}
	}()
	await := func(fragment string) {
		t.Helper()
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		var got strings.Builder
		for {
			select {
			case text, ok := <-output:
				if !ok {
					t.Fatalf("closed awaiting %q: %s", fragment, got.String())
				}
				got.WriteString(text)
				if strings.Contains(got.String(), fragment) {
					return
				}
			case <-deadline.C:
				t.Fatalf("timeout awaiting %q: %s", fragment, got.String())
			}
		}
	}
	await("TTY_READY")
	if _, err = session.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	await("INPUT=hello")
	if err = session.Resize(132, 43); err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(session.In, "size\n"); err != nil {
		t.Fatal(err)
	}
	await("43 132")
	if err = session.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-output:
	case <-time.After(5 * time.Second):
		t.Fatal("close did not stop PTY")
	}
	_ = session.Cmd.Wait()
}
