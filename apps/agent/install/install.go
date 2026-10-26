// Package install embeds the official persistent-service installers.
package install

import _ "embed"

//go:embed install.sh
var Shell string

//go:embed install.ps1
var PowerShell string
