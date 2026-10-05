$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "..\data\dev.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*([A-Z_]+)\s*=\s*(.*)\s*$") {
            Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

if (-not $env:ZAKURA_SECRET -or $env:ZAKURA_SECRET.Length -lt 32) {
    $bytes = [byte[]]::new(48)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $env:ZAKURA_SECRET = [Convert]::ToHexString($bytes)
}

$env:DATABASE_URL     = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { "file:./data/zakura.db" }
$env:DATA_DIR         = if ($env:DATA_DIR) { $env:DATA_DIR } else { "./data" }
$env:PUBLIC_BASE_URL  = if ($env:PUBLIC_BASE_URL) { $env:PUBLIC_BASE_URL } else { "http://localhost:8787" }
$env:WEB_PUBLIC_URL   = if ($env:WEB_PUBLIC_URL) { $env:WEB_PUBLIC_URL } else { "http://localhost:3000" }
$env:CGO_ENABLED      = "1"

New-Item -ItemType Directory -Force -Path data | Out-Null

if (-not (Test-Path ".\bin\zakura-server.exe")) {
    go build -o bin/zakura-server.exe ./cmd/zakura-server
}

& .\bin\zakura-server.exe
