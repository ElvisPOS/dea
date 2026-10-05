// Package web holds the browser UI, embedded into dea-server.
package web

import "embed"

//go:embed static
var FS embed.FS
