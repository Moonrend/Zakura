package sys

import (
	"encoding/base64"
	"encoding/json"
)

type windowsUpdateConfig struct {
	Bin        string `json:"bin"`
	Staged     string `json:"staged"`
	PID        int    `json:"pid"`
	Service    bool   `json:"service"`
	Args       string `json:"args"`
	WorkingDir string `json:"workingDir"`
}

func windowsUpdateScript(config windowsUpdateConfig) string {
	data, _ := json.Marshal(config)
	// All paths and arguments are data, including quotes, spaces and PowerShell metacharacters.
	return "$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + base64.StdEncoding.EncodeToString(data) + "')) | ConvertFrom-Json\r\n" + `
$ErrorActionPreference = 'Stop'
$backup = $config.bin + '.bak'
$errorFile = $config.bin + '.update-error'
$task = $null
$launched = $null
$replaced = $false
$exitCode = 0

function Stop-Agent {
  if ($config.service) {
    $service = Get-Service -Name 'zakura-agent' -ErrorAction Stop
    if ($service.Status -ne 'Stopped') {
      $service.Stop()
      $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
  } elseif ($task) {
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
  } else {
    $targetPid = if ($launched) { $launched.Id } else { $config.pid }
    $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($process) {
      $process | Stop-Process -Force -ErrorAction Stop
      if (-not $process.WaitForExit(30000)) { throw 'Timed out waiting for agent to stop' }
    }
  }
}

function Start-Agent {
  if ($config.service) {
    $service = Get-Service -Name 'zakura-agent' -ErrorAction Stop
    $service.Start()
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
  } elseif ($task) {
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    Start-Sleep -Seconds 2
    if ((Get-ScheduledTask -TaskName $task.TaskName).State -ne 'Running') { throw 'Agent task failed to start' }
  } else {
    $start = @{ FilePath = $config.bin; WorkingDirectory = $config.workingDir; PassThru = $true }
    if ($config.args) { $start.ArgumentList = $config.args }
    $script:launched = Start-Process @start
    if ($script:launched.WaitForExit(2000)) { throw 'Agent process exited after restart' }
  }
}

try {
  if (-not $config.service) {
    $task = Get-ScheduledTask -TaskName 'zakura-agent' -ErrorAction SilentlyContinue |
      Where-Object { $_.Actions.Execute.Trim('"') -eq $config.bin } | Select-Object -First 1
  }
  # Stop and wait BEFORE touching the locked executable.
  Stop-Agent
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (Get-Process -Id $config.pid -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for agent to stop' }
    Start-Sleep -Milliseconds 200
  }
  # Antivirus scanners may retain a short-lived handle after process exit.
  for ($attempt = 0; ; $attempt++) {
    try {
      [IO.File]::Replace($config.staged, $config.bin, $backup, $true)
      break
    } catch {
      if ($attempt -ge 29) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
  $replaced = $true
  Start-Agent
  Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
} catch {
  $exitCode = 1
  $failure = $_.Exception.Message
  try {
    if ($replaced) {
      Stop-Agent
      for ($attempt = 0; ; $attempt++) {
        try {
          [IO.File]::Replace($backup, $config.bin, $null, $true)
          break
        } catch {
          if ($attempt -ge 29) { throw }
          Start-Sleep -Milliseconds 200
        }
      }
    }
    if (-not (Get-Process -Id $config.pid -ErrorAction SilentlyContinue)) { Start-Agent }
  } catch { $failure += '; rollback/restart failed: ' + $_.Exception.Message }
  [IO.File]::WriteAllText($errorFile, $failure)
} finally {
  Remove-Item -LiteralPath $config.staged -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`
}
