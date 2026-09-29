package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestStartupReadinessGateKeepsLivenessAvailable(t *testing.T) {
	previousActive := startupGateActive.Load()
	previousReady := startupReady.Load()
	startupGateActive.Store(true)
	startupReady.Store(false)
	t.Cleanup(func() {
		startupGateActive.Store(previousActive)
		startupReady.Store(previousReady)
	})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(startupReadinessGate())
	router.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusOK) })
	router.GET("/api/test", func(c *gin.Context) { c.Status(http.StatusOK) })

	health := httptest.NewRecorder()
	router.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d", health.Code, http.StatusOK)
	}

	blocked := httptest.NewRecorder()
	router.ServeHTTP(blocked, httptest.NewRequest(http.MethodGet, "/api/test", nil))
	if blocked.Code != http.StatusServiceUnavailable {
		t.Fatalf("startup API status = %d, want %d", blocked.Code, http.StatusServiceUnavailable)
	}

	startupReady.Store(true)
	ready := httptest.NewRecorder()
	router.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/api/test", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("ready API status = %d, want %d", ready.Code, http.StatusOK)
	}
}
