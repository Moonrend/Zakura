#!/bin/sh
# zakura-agent 一键安装：Linux systemd / macOS launchd
set -eu

SERVER="${ZAKURA_AGENT_SERVER:-}"
TOKEN="${ZAKURA_AGENT_TOKEN:-}"
KIND="${ZAKURA_AGENT_KIND:-computer}"
VERSION="${ZAKURA_AGENT_VERSION:-latest}"
BASE="${ZAKURA_AGENT_DOWNLOAD_BASE:-}"

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  echo "需要 ZAKURA_AGENT_SERVER 与 ZAKURA_AGENT_TOKEN" >&2
  exit 2
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "不支持的架构: $arch" >&2; exit 1 ;;
esac
case "$os" in
  linux|darwin) ;;
  *) echo "请在 Windows 上使用 install.ps1" >&2; exit 1 ;;
esac

if [ -z "$BASE" ]; then
  BASE="${SERVER%/}/api/runtime-nodes/agent-binaries"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
url="$BASE/$os/$arch"
if [ "$VERSION" != "latest" ]; then
  url="$url?version=$VERSION"
fi
echo "下载 $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/zakura-agent"
else
  wget -qO "$tmp/zakura-agent" "$url"
fi
chmod +x "$tmp/zakura-agent"

bin=/usr/local/bin/zakura-agent
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$HOME/.local/bin"
  bin="$HOME/.local/bin/zakura-agent"
fi
mkdir -p "$(dirname "$bin")"
cp "$tmp/zakura-agent" "$bin"

if [ "$os" = "linux" ]; then
  unit="[Unit]
Description=Zakura Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$bin -server $SERVER -token $TOKEN -kind $KIND
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"
  if [ "$(id -u)" -eq 0 ]; then
    echo "$unit" > /etc/systemd/system/zakura-agent.service
    systemctl daemon-reload
    systemctl enable --now zakura-agent
  else
    mkdir -p "$HOME/.config/systemd/user"
    echo "$unit" > "$HOME/.config/systemd/user/zakura-agent.service"
    systemctl --user daemon-reload
    systemctl --user enable --now zakura-agent
  fi
  echo "已安装 systemd 服务 zakura-agent"
else
  label=dev.zakura.agent
  plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bin</string>
    <string>-server</string><string>$SERVER</string>
    <string>-token</string><string>$TOKEN</string>
    <string>-kind</string><string>$KIND</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
"
  if [ "$(id -u)" -eq 0 ]; then
    echo "$plist" > /Library/LaunchDaemons/$label.plist
    launchctl bootout system/$label 2>/dev/null || true
    launchctl bootstrap system /Library/LaunchDaemons/$label.plist
  else
    mkdir -p "$HOME/Library/LaunchAgents"
    echo "$plist" > "$HOME/Library/LaunchAgents/$label.plist"
    launchctl bootout gui/$(id -u)/$label 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/$label.plist"
  fi
  echo "已安装 launchd $label"
fi
