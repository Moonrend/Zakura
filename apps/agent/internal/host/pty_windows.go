//go:build windows

package host

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// StartPty uses ConPTY so Docker and interactive shells observe a real terminal.
func StartPty(root string, p ExecParams, cols, rows int) (_ *LiveStream, startErr error) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if cols > 1000 || rows > 1000 {
		return nil, fmt.Errorf("invalid terminal size")
	}
	if len(p.Command) == 0 {
		p.Command = []string{"powershell.exe", "-NoLogo"}
	}
	cmd, err := buildCmd(context.Background(), root, p)
	if err != nil {
		return nil, err
	}
	if cmd.Err != nil {
		return nil, cmd.Err
	}
	input, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer input.Close()
	reader, output, err := os.Pipe()
	if err != nil {
		_ = writer.Close()
		return nil, err
	}
	defer output.Close()
	defer func() {
		if startErr != nil {
			_ = writer.Close()
			_ = reader.Close()
		}
	}()
	var console windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, windows.Handle(input.Fd()), windows.Handle(output.Fd()), 0, &console); err != nil {
		return nil, fmt.Errorf("create Windows terminal: %w", err)
	}
	defer func() {
		if startErr != nil {
			windows.ClosePseudoConsole(console)
		}
	}()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	// This attribute takes the HPCON value, not a pointer to an HPCON variable.
	// Pass it as a native handle, without converting an integer to a Go pointer.
	update := windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")
	if ok, _, err := update.Call(uintptr(unsafe.Pointer(attributes.List())), 0, windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(console), unsafe.Sizeof(console), 0, 0); ok == 0 {
		return nil, fmt.Errorf("attach Windows terminal: %w", err)
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	// Do not inherit a service/test host's redirected standard handles. ConPTY
	// supplies the child's console handles when these are left unset.
	startup.Flags = windows.STARTF_USESTDHANDLES
	app, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return nil, err
	}
	line, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(cmd.Args))
	if err != nil {
		return nil, err
	}
	dir, err := windows.UTF16PtrFromString(cmd.Dir)
	if err != nil {
		return nil, err
	}
	environment, err := terminalEnvironment(cmd.Env)
	if err != nil {
		return nil, err
	}
	var process windows.ProcessInformation
	if err := windows.CreateProcess(app, line, nil, nil, false, windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT, &environment[0], dir, &startup.StartupInfo, &process); err != nil {
		return nil, err
	}
	_ = windows.CloseHandle(process.Thread)
	// Only the pseudoconsole retains these ends after CreateProcess.
	_ = input.Close()
	_ = output.Close()
	waited := make(chan struct{})
	exitCode := -1
	var consoleMu sync.Mutex
	go func() {
		if _, err := windows.WaitForSingleObject(process.Process, windows.INFINITE); err == nil {
			var code uint32
			if windows.GetExitCodeProcess(process.Process, &code) == nil {
				exitCode = int(code)
			}
		}
		consoleMu.Lock()
		_ = windows.CloseHandle(process.Process)
		process.Process = 0
		consoleMu.Unlock()
		// ClosePseudoConsole may block until output is drained. Never hold the
		// resize/close mutex across it; closing the reader must be able to unblock it.
		windows.ClosePseudoConsole(console)
		close(waited)
	}()
	var closeOnce sync.Once
	closeProcess := func() {
		closeOnce.Do(func() {
			consoleMu.Lock()
			if process.Process != 0 {
				_ = windows.TerminateProcess(process.Process, 1)
			}
			consoleMu.Unlock()
			_ = writer.Close()
			_ = reader.Close()
		})
	}
	return &LiveStream{
		ID: newID(), Mode: "pty", In: writer, Out: reader, Cancel: closeProcess,
		ResizeFn: func(c, r int) error {
			if c < 1 || c > 1000 || r < 1 || r > 1000 {
				return fmt.Errorf("invalid terminal size")
			}
			consoleMu.Lock()
			defer consoleMu.Unlock()
			if process.Process == 0 {
				return io.ErrClosedPipe
			}
			return windows.ResizePseudoConsole(console, windows.Coord{X: int16(c), Y: int16(r)})
		},
		WaitFn: func() int { <-waited; return exitCode },
	}, nil
}

func terminalEnvironment(entries []string) ([]uint16, error) {
	values := map[string]string{}
	for _, entry := range entries {
		if strings.ContainsRune(entry, '\x00') {
			return nil, fmt.Errorf("invalid terminal environment")
		}
		start := 0
		if strings.HasPrefix(entry, "=") {
			start = 1 // Windows drive-current-directory variables, such as =C:.
		}
		split := strings.IndexByte(entry[start:], '=')
		if split < 0 {
			return nil, fmt.Errorf("invalid terminal environment")
		}
		values[strings.ToUpper(entry[:start+split])] = entry
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var block []uint16
	for _, key := range keys {
		block = append(block, utf16.Encode([]rune(values[key]))...)
		block = append(block, 0)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	return block, nil
}
