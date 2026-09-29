package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestExpandConnectSrcHTTPSAddsWSS(t *testing.T) {
	values := expandConnectSrc("https://api.example.test/base")
	if len(values) != 2 {
		t.Fatalf("expected 2 values, got %d: %#v", len(values), values)
	}
	if values[0] != "https://api.example.test/base" {
		t.Fatalf("unexpected first value: %q", values[0])
	}
	if values[1] != "wss://api.example.test" {
		t.Fatalf("unexpected websocket value: %q", values[1])
	}
}

func TestExpandConnectSrcHTTPAddsWS(t *testing.T) {
	values := expandConnectSrc("http://localhost:5000")
	if len(values) != 2 {
		t.Fatalf("expected 2 values, got %d: %#v", len(values), values)
	}
	if values[1] != "ws://localhost:5000" {
		t.Fatalf("unexpected websocket value: %q", values[1])
	}
}

func TestCORSAllowsPUT(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORS(nil))
	req := httptest.NewRequest(http.MethodOptions, "/api/color-palette-templates", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), "PUT") {
		t.Fatalf("CORS methods = %q, want PUT", w.Header().Get("Access-Control-Allow-Methods"))
	}
}

func TestExpandConnectSrcLeavesNonURLAsIs(t *testing.T) {
	values := expandConnectSrc("'self'")
	if len(values) != 1 {
		t.Fatalf("expected 1 value, got %d: %#v", len(values), values)
	}
	if values[0] != "'self'" {
		t.Fatalf("unexpected value: %q", values[0])
	}
}
