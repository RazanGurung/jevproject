package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestProxyHLRejectsHighWeightTypes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/hl", proxyHL)
	req := httptest.NewRequest(http.MethodPost, "/api/hl", bytes.NewBufferString(`{"type":"userRole","user":"0xabc"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400, body=%s", w.Code, w.Body.String())
	}
}

func TestProxyHLRejectsEmptyType(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/hl", proxyHL)
	req := httptest.NewRequest(http.MethodPost, "/api/hl", bytes.NewBufferString(`{"user":"0xabc"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400, body=%s", w.Code, w.Body.String())
	}
}
