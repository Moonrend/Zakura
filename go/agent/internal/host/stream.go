package host

import (
	"io"
	"os/exec"
)

// LiveStream 统一的交互流（真 PTY / Windows 管道 / docker exec -i）。
type LiveStream struct {
	ID       string
	Mode     string
	In       io.WriteCloser
	Out      io.ReadCloser
	Cmd      *exec.Cmd
	Cancel   func()
	ResizeFn func(cols, rows int) error
}

func (s *LiveStream) Write(b []byte) (int, error) { return s.In.Write(b) }
func (s *LiveStream) Read(b []byte) (int, error)  { return s.Out.Read(b) }
func (s *LiveStream) Resize(cols, rows int) error {
	if s.ResizeFn != nil {
		return s.ResizeFn(cols, rows)
	}
	return nil
}
func (s *LiveStream) Close() error {
	if s.Cancel != nil {
		s.Cancel()
	}
	_ = s.In.Close()
	_ = s.Out.Close()
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = s.Cmd.Process.Kill()
	}
	return nil
}

func newPipeSession(id string, stdin io.WriteCloser, stdout io.ReadCloser, cmd *exec.Cmd, cancel func()) *LiveStream {
	return &LiveStream{ID: id, Mode: "pipe", In: stdin, Out: stdout, Cmd: cmd, Cancel: cancel}
}
