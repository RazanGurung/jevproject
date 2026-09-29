package main

import (
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"hyperliquid-go/internal/middleware"
)

// Custom app metrics served alongside the promhttp defaults on /metrics. The
// set is deliberately small and forensics-oriented: rate-limit pressure and
// candle-store effectiveness are what past live debugging actually needed
// (grep'd out of logs at the time), plus per-route traffic/error counts.
var (
	httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_http_requests_total",
		Help: "HTTP requests by gin route pattern, method, and status code.",
	}, []string{"route", "method", "status"})

	httpRequestSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pez_http_request_seconds",
		Help:    "HTTP request latency by gin route pattern (API routes only).",
		Buckets: prometheus.ExponentialBuckets(0.002, 2, 12), // 2ms .. ~8s
	}, []string{"route"})

	candleServeTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_candle_serve_total",
		Help: "candleSnapshot serves by source: store (memory hit), passthrough (upstream fetch), passthrough_error (upstream failure).",
	}, []string{"source"})

	upstreamRateLimitedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_upstream_rate_limited_total",
		Help: "Hyperliquid HTTP 429 responses observed on proxy/passthrough paths, by /info request type.",
	}, []string{"type"})

	candleBudgetWaitSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "pez_candle_budget_wait_seconds",
		Help:    "Time background candle fetches spent blocked on the shared weight budget (only waits that actually blocked).",
		Buckets: prometheus.ExponentialBuckets(0.05, 2, 12), // 50ms .. ~100s
	})

	cvdScanSeriesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_cvd_scan_series_total",
		Help: "Backend CVD scanner series outcomes: store, passthrough, not_ready, or error.",
	}, []string{"result"})
)

func init() {
	prometheus.MustRegister(
		httpRequestsTotal,
		httpRequestSeconds,
		candleServeTotal,
		upstreamRateLimitedTotal,
		candleBudgetWaitSeconds,
		cvdScanSeriesTotal,
	)
}

// auditLogMiddleware writes one structured line per mutating/fund-moving
// request outcome (route, method, status, duration) — an audit trail for the
// signed order paths, which previously logged nothing on success. Never logs
// request bodies (they can carry key material). Protected high-volume read and
// control-plane routes stay authenticated but are excluded from this audit
// stream; their request metrics remain available separately.
func auditLogMiddleware(audited middleware.RoutePolicy) gin.HandlerFunc {
	return func(c *gin.Context) {
		route := c.FullPath()
		if !audited.Contains(c.Request.Method, route) || isAuditNoiseRoute(route) {
			c.Next()
			return
		}
		start := time.Now()
		c.Next()
		slog.Info("mutating route",
			"route", route,
			"method", c.Request.Method,
			"status", c.Writer.Status(),
			"durMs", time.Since(start).Milliseconds(),
		)
	}
}

func isAuditNoiseRoute(route string) bool {
	switch route {
	case "/api/hl", "/api/chart-candles", "/api/cvd-scan", "/api/market-subscribe", "/api/preload-hint",
		"/api/bot/status", "/api/has-saved-key", "/metrics", "/api/jev/signal", "/api/jev/status":
		return true
	default:
		return false
	}
}

// metricsMiddleware records per-route request counts (all routes) and latency
// (API routes only, to keep static-asset noise out of the histogram). Route
// label is the gin pattern (bounded cardinality), never the raw URL.
func metricsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		httpRequestsTotal.WithLabelValues(route, c.Request.Method, strconv.Itoa(c.Writer.Status())).Inc()
		if strings.HasPrefix(route, "/api/") {
			httpRequestSeconds.WithLabelValues(route).Observe(time.Since(start).Seconds())
		}
	}
}
