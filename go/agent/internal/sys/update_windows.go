package sys

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func restartSelf(bin, staged string) error {
	service, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	workingDir, err := os.Getwd()
	if err != nil {
		return err
	}
	script := staged + ".ps1"
	content := windowsUpdateScript(windowsUpdateConfig{
		Bin: bin, Staged: staged, PID: os.Getpid(), Service: service,
		Args: windows.ComposeCommandLine(os.Args[1:]), WorkingDir: workingDir,
	})
	if err := os.WriteFile(script, []byte(content), 0o600); err != nil {
		return err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
	cmd.Dir = filepath.Dir(bin)
	// A helper in the scheduled task's job would be killed together with the agent.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_BREAKAWAY_FROM_JOB}
	if err := cmd.Start(); err != nil {
		_ = os.Remove(script)
		return err
	}
	// A successful helper stops this process, so Wait never returns on success.
	// If it exits while we are still alive, return an error to release the update
	// lock and allow a retry (for example after a denied Stop-Service operation).
	err = cmd.Wait()
	if failure, readErr := os.ReadFile(bin + ".update-error"); readErr == nil {
		return fmt.Errorf("Windows 更新失败: %s", strings.TrimSpace(string(failure)))
	}
	if err != nil {
		return fmt.Errorf("Windows 更新辅助进程失败: %w", err)
	}
	return fmt.Errorf("Windows 更新辅助进程已退出，但原代理仍在运行")
}
