//go:build windows

package host

import (
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestWindowsPTYInputResizeClose(t *testing.T) {
	root := t.TempDir()
	session, err := StartPty(root, ExecParams{Command: []string{"powershell.exe", "-NoLogo", "-NoProfile", "-Command", `$size=$Host.UI.RawUI.WindowSize; Write-Output ('SIZE='+$size.Width+'x'+$size.Height); Write-Output ('CWD='+$pwd.Path); Write-Output ('ENV='+$env:ZAKURA_PTY_FIXTURE); Write-Output 'READY'; while ($true) { $line=[Console]::ReadLine(); if ($null -eq $line -or $line -eq 'quit') { break }; Write-Output ('INPUT='+$line) }`}, Env: map[string]string{"ZAKURA_PTY_FIXTURE": "fresh-value"}}, 100, 40)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if session.Mode != "pty" {
		t.Fatalf("mode=%s", session.Mode)
	}
	output := make(chan string, 64)
	go func() {
		defer close(output)
		buf := make([]byte, 4096)
		for {
			n, err := session.Read(buf)
			if n > 0 {
				output <- string(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	await := func(want string) string {
		t.Helper()
		deadline := time.NewTimer(10 * time.Second)
		defer deadline.Stop()
		var text strings.Builder
		for {
			select {
			case part, ok := <-output:
				text.WriteString(part)
				if strings.Contains(text.String(), want) {
					return text.String()
				}
				if !ok {
					t.Fatalf("PTY closed awaiting %q: %q", want, text.String())
				}
			case <-deadline.C:
				t.Fatalf("PTY timeout awaiting %q: %q", want, text.String())
			}
		}
	}
	ready := await("READY")
	if !strings.Contains(ready, "SIZE=100x40") || !strings.Contains(ready, "ENV=fresh-value") || !strings.Contains(ready, "CWD="+filepath.Clean(root)) {
		t.Fatalf("terminal startup: %q", ready)
	}
	if err := session.Resize(132, 43); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(session.In, "hello\r"); err != nil {
		t.Fatal(err)
	}
	await("INPUT=hello")
	if _, err := io.WriteString(session.In, "quit\r"); err != nil {
		t.Fatal(err)
	}
	for range output {
	}
	if code := session.Wait(); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := session.Resize(80, 24); err == nil {
		t.Fatal("resized a closed terminal")
	}
}

func TestWindowsPTYEnvironmentDeduplicates(t *testing.T) {
	block, err := terminalEnvironment([]string{"Path=old", "PATH=new", "=C:=C:\\fixture", "VALUE=中文"})
	if err != nil {
		t.Fatal(err)
	}
	value := string(utf16.Decode(block))
	if strings.Contains(value, "old") || !strings.Contains(value, "PATH=new\x00") || !strings.Contains(value, "VALUE=中文\x00") || !strings.HasSuffix(value, "\x00\x00") {
		t.Fatalf("environment=%q", value)
	}
	if _, err := terminalEnvironment([]string{"BAD=a\x00b"}); err == nil {
		t.Fatal("accepted NUL environment")
	}
}
