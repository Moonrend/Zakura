module github.com/Moonrend/Zakura/apps/agent

go 1.23.0

require (
	github.com/Moonrend/Zakura/packages/projectkit v0.0.0
	github.com/creack/pty v1.1.24
	github.com/gorilla/websocket v1.5.3
	golang.org/x/sys v0.35.0
)

replace github.com/Moonrend/Zakura/packages/projectkit => ../../packages/projectkit
