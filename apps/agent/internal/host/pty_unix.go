//go:build !windows

package host

import (
	"context"

	"github.com/creack/pty"
)

func StartPty(root string, p ExecParams, cols, rows int) (*LiveStream, error) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd, err := buildCmd(ctx, root, p)
	if err != nil {
		cancel()
		return nil, err
	}
	size := &pty.Winsize{Cols: uint16(or(cols, 80)), Rows: uint16(or(rows, 24))}
	ptmx, err := pty.StartWithSize(cmd, size)
	if err != nil {
		cancel()
		return nil, err
	}
	return &LiveStream{
		ID:     newID(),
		Mode:   "pty",
		In:     ptmx,
		Out:    ptmx,
		Cmd:    cmd,
		Cancel: cancel,
		ResizeFn: func(c, r int) error {
			return pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(or(c, 80)), Rows: uint16(or(r, 24))})
		},
	}, nil
}

func or(v, d int) int {
	if v <= 0 {
		return d
	}
	return v
}
