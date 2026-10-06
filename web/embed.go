// Package web holds the browser UI, embedded into dea-server.
//
// The UI source is the Angular app in ../ui; `make ui` (or `npm run build`
// there) writes the production build into dist/, which is embedded here.
package web

import "embed"

//go:embed dist
var FS embed.FS
