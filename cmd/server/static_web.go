package main

// Static web root resolution and filtered static/precompressed serving.

import (

	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"github.com/gin-gonic/gin"
)

func init() {
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".woff", "font/woff")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
}


func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func resolveWebDir() string {
	for _, p := range []string{"web", filepath.Clean("../web")} {
		st, err := os.Stat(filepath.Join(p, "index.html"))
		if err == nil && !st.IsDir() {
			return p
		}
	}
	return "web"
}

func registerFilteredStatic(r gin.IRoutes, routePrefix, root string, allowedExts map[string]struct{}) {
	handler := func(c *gin.Context) {
		rel := strings.TrimPrefix(path.Clean("/"+c.Param("filepath")), "/")
		if rel == "" || rel == "." || isBlockedStaticPath(rel, allowedExts) {
			c.Status(http.StatusNotFound)
			return
		}

		rootClean := filepath.Clean(root)
		fullPath := filepath.Join(rootClean, filepath.FromSlash(rel))
		if fullPath != rootClean && !strings.HasPrefix(fullPath, rootClean+string(os.PathSeparator)) {
			c.Status(http.StatusNotFound)
			return
		}

		st, err := os.Stat(fullPath)
		if err != nil || st.IsDir() {
			c.Status(http.StatusNotFound)
			return
		}

		servePrecompressedFile(c, fullPath)
	}

	r.GET(routePrefix+"/*filepath", handler)
	r.HEAD(routePrefix+"/*filepath", handler)
}

func servePrecompressedFile(c *gin.Context, originalPath string) {
	selectedPath := originalPath
	encoding := ""
	acceptEncoding := c.GetHeader("Accept-Encoding")
	if strings.Contains(acceptEncoding, "br") && fileExists(originalPath+".br") {
		selectedPath = originalPath + ".br"
		encoding = "br"
	} else if strings.Contains(acceptEncoding, "gzip") && fileExists(originalPath+".gz") {
		selectedPath = originalPath + ".gz"
		encoding = "gzip"
	}

	if contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(originalPath))); contentType != "" {
		c.Header("Content-Type", contentType)
	}
	if encoding != "" {
		c.Header("Content-Encoding", encoding)
		c.Header("Vary", "Accept-Encoding")
	}
	c.File(selectedPath)
}

func isBlockedStaticPath(rel string, allowedExts map[string]struct{}) bool {
	rel = filepath.ToSlash(rel)
	base := path.Base(rel)
	ext := strings.ToLower(path.Ext(base))

	if _, ok := allowedExts[ext]; !ok {
		return true
	}
	if strings.Contains(rel, "/__tests__/") || strings.HasPrefix(rel, "__tests__/") {
		return true
	}
	if strings.Contains(rel, "/test-utils/") || strings.HasPrefix(rel, "test-utils/") {
		return true
	}
	if strings.HasSuffix(rel, ".test.js") || strings.HasSuffix(rel, ".spec.js") || strings.HasSuffix(rel, ".map") {
		return true
	}
	switch base {
	case "package.json", "package-lock.json", "vitest.config.js", "vitest.config.mjs":
		return true
	}
	return false
}
