# zakura-agent Windows 安装：管理员走 Windows 服务，否则走登录计划任务
param(
  [string]$Server = $env:ZAKURA_AGENT_SERVER,
  [string]$Token = $env:ZAKURA_AGENT_TOKEN,
  [string]$Kind = $(if ($env:ZAKURA_AGENT_KIND) { $env:ZAKURA_AGENT_KIND } else { "computer" }),
  [string]$Version = $(if ($env:ZAKURA_AGENT_VERSION) { $env:ZAKURA_AGENT_VERSION } else { "latest" }),
  [string]$Base = $env:ZAKURA_AGENT_DOWNLOAD_BASE
)

$ErrorActionPreference = "Stop"
if (-not $Server -or -not $Token) {
  Write-Error "需要 -Server / ZAKURA_AGENT_SERVER 与 -Token / ZAKURA_AGENT_TOKEN"
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
if (-not $Base) { $Base = "$Server".TrimEnd("/") + "/api/runtime-nodes/agent-binaries" }
$url = "$Base/windows/$arch"
if ($Version -ne "latest") { $url += "?version=$Version" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin -and $env:PROGRAMDATA) {
  $destDir = Join-Path $env:PROGRAMDATA "zakura\bin"
} else {
  $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
  $destDir = Join-Path $local "zakura\bin"
}
if (-not (Test-Path $destDir)) {
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}
$exe = Join-Path $destDir "zakura-agent.exe"
Write-Host "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing

$svc = "zakura-agent"
$binPath = "`"$exe`" -server $Server -token $Token -kind $Kind"

if ($isAdmin) {
  $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
    sc.exe delete $svc | Out-Null
    Start-Sleep -Seconds 1
  }
  sc.exe create $svc DisplayName= "Zakura Agent" binPath= $binPath start= auto | Out-Null
  sc.exe description $svc "Zakura local agent" | Out-Null
  Start-Service -Name $svc
  Write-Host "已安装并启动 Windows 服务 $svc"
} else {
  schtasks /Delete /TN $svc /F 2>$null | Out-Null
  schtasks /Create /TN $svc /SC ONLOGON /RL LIMITED /F /TR $binPath | Out-Null
  schtasks /Run /TN $svc | Out-Null
  Write-Host "无管理员权限：已注册登录计划任务 $svc（数据目录在 %LOCALAPPDATA%\zakura）"
}
