package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"hyperliquid-go/internal/middleware"
)

func TestAuditLogMiddlewareMatchesMethodAndRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	r := gin.New()
	policy := middleware.RoutePolicy{{Method: http.MethodPost, Route: "/api/order"}: {}}
	r.Use(auditLogMiddleware(policy))
	r.GET("/api/order", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/order", func(c *gin.Context) { c.Status(http.StatusOK) })

	getReq := httptest.NewRequest(http.MethodGet, "/api/order", nil)
	r.ServeHTTP(httptest.NewRecorder(), getReq)
	if logs.Len() != 0 {
		t.Fatalf("GET emitted audit log: %s", logs.String())
	}

	postReq := httptest.NewRequest(http.MethodPost, "/api/order", nil)
	r.ServeHTTP(httptest.NewRecorder(), postReq)
	if got := logs.String(); !bytes.Contains([]byte(got), []byte("mutating route")) {
		t.Fatalf("POST did not emit audit log: %s", got)
	}
}

func TestAuditLogMiddlewareSkipsHighVolumeReadAndControlRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	r := gin.New()
	policy := middleware.RoutePolicy{
		{Method: http.MethodPost, Route: "/api/chart-candles"}:    {},
		{Method: http.MethodPost, Route: "/api/cvd-scan"}:         {},
		{Method: http.MethodPost, Route: "/api/market-subscribe"}: {},
		{Method: http.MethodPost, Route: "/api/preload-hint"}:     {},
		{Method: http.MethodGet, Route: "/api/bot/status"}:        {},
		{Method: http.MethodGet, Route: "/api/has-saved-key"}:     {},
		{Method: http.MethodGet, Route: "/metrics"}:               {},
	}
	r.Use(auditLogMiddleware(policy))
	r.POST("/api/chart-candles", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/cvd-scan", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/market-subscribe", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/preload-hint", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/api/bot/status", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/api/has-saved-key", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/metrics", func(c *gin.Context) { c.Status(http.StatusOK) })

	posts := []string{"/api/chart-candles", "/api/cvd-scan", "/api/market-subscribe", "/api/preload-hint"}
	for _, route := range posts {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, route, nil))
	}
	for _, route := range []string{"/api/bot/status", "/api/has-saved-key", "/metrics"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, route, nil))
	}
	if logs.Len() != 0 {
		t.Fatalf("high-volume read/control routes emitted audit logs: %s", logs.String())
	}
}
