// Package web holds the browser UI, embedded into rterm-server.
package web

import "embed"

//go:embed static
var FS embed.FS
