package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestServePrecompressedFileNegotiatesBrotli(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	asset := filepath.Join(dir, "main-ABC.js")
	if err := os.WriteFile(asset, []byte("raw"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset+".br", []byte("brotli"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset+".gz", []byte("gzip"), 0o600); err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.GET("/asset.js", func(c *gin.Context) { servePrecompressedFile(c, asset) })
	request := httptest.NewRequest(http.MethodGet, "/asset.js", nil)
	request.Header.Set("Accept-Encoding", "gzip, br")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Encoding"); got != "br" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	if got := response.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := response.Body.String(); got != "brotli" {
		t.Fatalf("body = %q", got)
	}
}

func TestServePrecompressedFileFallsBackToRaw(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	asset := filepath.Join(dir, "styles-ABC.css")
	if err := os.WriteFile(asset, []byte("raw-css"), 0o600); err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.GET("/asset.css", func(c *gin.Context) { servePrecompressedFile(c, asset) })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/asset.css", nil))

	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "text/css; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := response.Body.String(); got != "raw-css" {
		t.Fatalf("body = %q", got)
	}
}
