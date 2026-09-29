package middleware

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

const maxAPIRequestBodyBytes int64 = 1 << 20

// RouteMethod identifies one HTTP operation. Policies intentionally include
// the method because a read and a mutation may share a route pattern.
type RouteMethod struct {
	Method string
	Route  string
}

// RoutePolicy is shared by authentication and audit middleware so both apply
// to exact operations rather than broadly matching a route path.
type RoutePolicy map[RouteMethod]struct{}

func (p RoutePolicy) Contains(method, route string) bool {
	_, ok := p[RouteMethod{Method: method, Route: route}]
	return ok
}

// LimitAPIRequestBody bounds JSON request memory before Gin binds it. All
// normal trading and market-control payloads are tiny; this primarily protects
// unauthenticated read/control endpoints from oversized bodies.
func LimitAPIRequestBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") && c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAPIRequestBodyBytes)
		}
		c.Next()
	}
}

// RequireAPIToken protects fund-moving and key/proxy routes with a shared
// secret. When token is empty (the default for single-user localhost use) the
// middleware is a no-op, so existing local workflows are unaffected. When
// PEZ_API_TOKEN is set — the case for any publicly reachable deployment — the
// listed routes require a matching bearer token, since CORS is browser-only and
// does not stop a direct HTTP client from hitting the signing endpoints.
//
// protected holds method + gin route patterns that require the token.
// Unprotected reads, previews, and static assets pass through unchanged.
func RequireAPIToken(token string, protected RoutePolicy) gin.HandlerFunc {
	token = strings.TrimSpace(token)
	expected := []byte(token)
	return func(c *gin.Context) {
		if token == "" {
			c.Next()
			return
		}
		if c.Request.Method == http.MethodOptions {
			c.Next()
			return
		}
		if !protected.Contains(c.Request.Method, c.FullPath()) {
			c.Next()
			return
		}
		provided := []byte(extractRequestToken(c))
		if subtle.ConstantTimeCompare(provided, expected) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

func extractRequestToken(c *gin.Context) string {
	if header := strings.TrimSpace(c.GetHeader("Authorization")); header != "" {
		if strings.HasPrefix(strings.ToLower(header), "bearer ") {
			return strings.TrimSpace(header[len("bearer "):])
		}
		return header
	}
	return strings.TrimSpace(c.GetHeader("X-PEZ-Token"))
}

func SecurityHeaders(extraConnectSrc ...string) gin.HandlerFunc {
	connectSrc := []string{"'self'", "wss://api.hyperliquid.xyz", "https://api.hyperliquid.xyz"}
	for _, origin := range extraConnectSrc {
		for _, expanded := range expandConnectSrc(origin) {
			connectSrc = append(connectSrc, expanded)
		}
	}
	csp := "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src " + strings.Join(connectSrc, " ")
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("X-XSS-Protection", "1; mode=block")
		if c.Request.TLS != nil {
			c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Header("Content-Security-Policy", csp)
		c.Next()
	}
}

func expandConnectSrc(origin string) []string {
	trimmed := strings.TrimSpace(origin)
	if trimmed == "" {
		return nil
	}

	values := []string{trimmed}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return values
	}

	switch parsed.Scheme {
	case "https":
		values = append(values, "wss://"+parsed.Host)
	case "http":
		values = append(values, "ws://"+parsed.Host)
	}

	return values
}

func CORS(allowedOrigins []string) gin.HandlerFunc {
	allowAll := false
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		trimmed := strings.TrimSpace(origin)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			allowAll = true
			continue
		}
		allowed[trimmed] = struct{}{}
	}

	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.Request.Header.Get("Origin"))
		if origin != "" {
			if allowAll {
				c.Header("Access-Control-Allow-Origin", "*")
			} else if _, ok := allowed[origin]; ok {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
			}
		}

		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PEZ-Token")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
