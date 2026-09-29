package middleware

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func newTokenRouter(token string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	protected := RoutePolicy{{Method: http.MethodPost, Route: "/api/order"}: {}}
	r.Use(RequireAPIToken(token, protected))
	r.POST("/api/order", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/api/coin-meta", func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

func doPOST(r *gin.Engine, path, auth string) int {
	req := httptest.NewRequest(http.MethodPost, path, nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

func TestRequireAPITokenNoopWhenUnset(t *testing.T) {
	r := newTokenRouter("")
	if code := doPOST(r, "/api/order", ""); code != http.StatusOK {
		t.Fatalf("unset token should allow protected route, got %d", code)
	}
}

func TestRequireAPITokenRejectsMissingAndWrong(t *testing.T) {
	r := newTokenRouter("s3cret")
	if code := doPOST(r, "/api/order", ""); code != http.StatusUnauthorized {
		t.Fatalf("missing token should be 401, got %d", code)
	}
	if code := doPOST(r, "/api/order", "Bearer nope"); code != http.StatusUnauthorized {
		t.Fatalf("wrong token should be 401, got %d", code)
	}
}

func TestRequireAPITokenAcceptsBearerAndRaw(t *testing.T) {
	r := newTokenRouter("s3cret")
	if code := doPOST(r, "/api/order", "Bearer s3cret"); code != http.StatusOK {
		t.Fatalf("correct bearer token should pass, got %d", code)
	}
	if code := doPOST(r, "/api/order", "s3cret"); code != http.StatusOK {
		t.Fatalf("raw token should pass, got %d", code)
	}
}

func TestRequireAPITokenIgnoresUnprotectedRoute(t *testing.T) {
	r := newTokenRouter("s3cret")
	req := httptest.NewRequest(http.MethodGet, "/api/coin-meta", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unprotected route should not require token, got %d", w.Code)
	}
}

func TestRequireAPITokenDistinguishesMethodsOnSharedRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	protected := RoutePolicy{{Method: http.MethodPost, Route: "/api/order"}: {}}
	r.Use(RequireAPIToken("s3cret", protected))
	r.GET("/api/order", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/api/order", func(c *gin.Context) { c.Status(http.StatusOK) })

	getReq := httptest.NewRequest(http.MethodGet, "/api/order", nil)
	getRes := httptest.NewRecorder()
	r.ServeHTTP(getRes, getReq)
	if getRes.Code != http.StatusOK {
		t.Fatalf("GET /api/order = %d, want 200", getRes.Code)
	}

	if code := doPOST(r, "/api/order", ""); code != http.StatusUnauthorized {
		t.Fatalf("POST /api/order without token = %d, want 401", code)
	}
}

func TestLimitAPIRequestBodyRejectsOversizedJSON(t *testing.T) {
	r := gin.New()
	r.Use(LimitAPIRequestBody())
	r.POST("/api/test", func(c *gin.Context) {
		_, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.Status(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodPost, "/api/test", bytes.NewReader(make([]byte, maxAPIRequestBodyBytes+2)))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusRequestEntityTooLarge)
	}
}
