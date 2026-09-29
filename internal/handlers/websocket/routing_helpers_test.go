package websocket

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestStreamOriginPolicy(t *testing.T) {
	m := NewWebSocketManager(nil)

	sameOrigin := httptest.NewRequest("GET", "http://terminal.test/api/trading-stream", nil)
	sameOrigin.Host = "terminal.test"
	sameOrigin.Header.Set("Origin", "https://terminal.test")
	if !m.isOriginAllowed(sameOrigin) {
		t.Fatal("same-origin browser handshake should be allowed without an explicit allowlist")
	}

	foreign := httptest.NewRequest("GET", "http://terminal.test/api/trading-stream", nil)
	foreign.Host = "terminal.test"
	foreign.Header.Set("Origin", "https://evil.example")
	if m.isOriginAllowed(foreign) {
		t.Fatal("cross-origin browser handshake must not be allowed by the empty-list default")
	}

	m.SetAllowedOrigins([]string{"https://app.example"})
	allowed := httptest.NewRequest("GET", "http://terminal.test/api/market-stream", nil)
	allowed.Host = "terminal.test"
	allowed.Header.Set("Origin", "https://app.example")
	if !m.isOriginAllowed(allowed) {
		t.Fatal("configured origin should be allowed")
	}

	originless := httptest.NewRequest("GET", "http://terminal.test/api/market-stream", nil)
	originless.Host = "terminal.test"
	if m.isOriginAllowed(originless) {
		t.Fatal("origin-less client must not bypass an explicit allowlist")
	}
}

func TestStreamTokenAuthentication(t *testing.T) {
	m := NewWebSocketManager(nil)
	m.SetAPIToken("correct horse battery staple")

	missing := httptest.NewRequest(http.MethodGet, "http://terminal.test/api/market-stream", nil)
	if m.authorizeStreamRequest(missing) {
		t.Fatal("missing websocket token must be rejected")
	}

	wrong := httptest.NewRequest(http.MethodGet, "http://terminal.test/api/market-stream", nil)
	wrong.Header.Set("Sec-WebSocket-Protocol", "pez-token.wrong")
	if m.authorizeStreamRequest(wrong) {
		t.Fatal("wrong websocket token must be rejected")
	}

	valid := httptest.NewRequest(http.MethodGet, "http://terminal.test/api/market-stream", nil)
	valid.Header.Set("Sec-WebSocket-Protocol", m.streamTokenProtocol())
	if !m.authorizeStreamRequest(valid) {
		t.Fatal("matching websocket subprotocol token should be accepted")
	}

	bearer := httptest.NewRequest(http.MethodGet, "http://terminal.test/api/market-stream", nil)
	bearer.Header.Set("Authorization", "Bearer correct horse battery staple")
	if !m.authorizeStreamRequest(bearer) {
		t.Fatal("matching bearer token should be accepted for non-browser tooling")
	}
}

func TestBroadcastToAccountNeverTreatsEmptyAccountAsWildcard(t *testing.T) {
	m := NewWebSocketManager(nil)
	matching := &streamClient{
		conn: &websocket.Conn{}, account: "0x1111111111111111111111111111111111111111",
		kind: tradingStream, sendCh: make(chan []byte, 1), doneCh: make(chan struct{}),
	}
	unscoped := &streamClient{
		conn: &websocket.Conn{}, account: "",
		kind: tradingStream, sendCh: make(chan []byte, 1), doneCh: make(chan struct{}),
	}
	m.streamClients[matching] = true
	m.streamClients[unscoped] = true

	m.BroadcastToAccount(matching.account, []byte(`{"channel":"webData2"}`))
	if len(matching.sendCh) != 1 {
		t.Fatal("matching account did not receive targeted message")
	}
	if len(unscoped.sendCh) != 0 {
		t.Fatal("empty-account client received targeted message")
	}
}

// collectFillEntries feeds ProcessUserFills and the bot engine. Mis-parsing it
// means missed or duplicated fills, so every shape the exchange can send must
// be pinned.
func TestCollectFillEntries(t *testing.T) {
	t.Run("array passthrough", func(t *testing.T) {
		in := []interface{}{
			map[string]interface{}{"oid": float64(1)},
			map[string]interface{}{"oid": float64(2)},
		}
		got := collectFillEntries(in)
		if len(got) != 2 {
			t.Fatalf("got %d entries, want 2", len(got))
		}
	})

	t.Run("object with fills array", func(t *testing.T) {
		in := map[string]interface{}{
			"fills": []interface{}{map[string]interface{}{"oid": float64(7)}},
		}
		got := collectFillEntries(in)
		if len(got) != 1 {
			t.Fatalf("got %d entries, want 1", len(got))
		}
	})

	t.Run("object without fills wraps itself", func(t *testing.T) {
		in := map[string]interface{}{"oid": float64(9)}
		got := collectFillEntries(in)
		if len(got) != 1 {
			t.Fatalf("got %d entries, want 1 (self-wrapped)", len(got))
		}
		entry, ok := got[0].(map[string]interface{})
		if !ok || entry["oid"] != float64(9) {
			t.Fatalf("unexpected wrapped entry: %+v", got[0])
		}
	})

	t.Run("nil and scalar yield nil", func(t *testing.T) {
		if got := collectFillEntries(nil); got != nil {
			t.Fatalf("nil input = %+v, want nil", got)
		}
		if got := collectFillEntries("string"); got != nil {
			t.Fatalf("scalar input = %+v, want nil", got)
		}
	})
}

// marketMessageCoin decides which client a market message is routed to. The
// exchange puts the coin in three different places depending on channel.
func TestMarketMessageCoin(t *testing.T) {
	cases := []struct {
		name string
		msg  map[string]interface{}
		want string
	}{
		{"top-level coin", map[string]interface{}{"coin": "BTC"}, "BTC"},
		{"nested data.coin", map[string]interface{}{"data": map[string]interface{}{"coin": "ETH"}}, "ETH"},
		{"data array coin", map[string]interface{}{"data": []interface{}{map[string]interface{}{"coin": "SOL"}}}, "SOL"},
		{"data array symbol field s", map[string]interface{}{"data": []interface{}{map[string]interface{}{"s": "XRP"}}}, "XRP"},
		{"no coin anywhere", map[string]interface{}{"channel": "x"}, ""},
		{"top-level wins over nested", map[string]interface{}{"coin": "BTC", "data": map[string]interface{}{"coin": "ETH"}}, "BTC"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := marketMessageCoin(tc.msg); got != tc.want {
				t.Fatalf("marketMessageCoin = %q, want %q", got, tc.want)
			}
		})
	}
}

// normalizeAccountAddress is what makes account routing case-insensitive — a
// reconnect or a checksummed address must still match the lowercase key used
// to fan messages out to the right user.
func TestNormalizeAccountAddress(t *testing.T) {
	valid := "0x" + strings.Repeat("Ab", 20) // 42 chars, mixed case
	wantLower := "0x" + strings.Repeat("ab", 20)

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"mixed case lowercased", valid, wantLower},
		{"already lowercase", wantLower, wantLower},
		{"uppercase 0X prefix", "0X" + strings.Repeat("CD", 20), "0x" + strings.Repeat("cd", 20)},
		{"surrounding whitespace trimmed", "  " + valid + "  ", wantLower},
		{"wrong length rejected", "0x1234", ""},
		{"missing 0x prefix rejected", strings.Repeat("a", 42), ""},
		{"empty rejected", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeAccountAddress(tc.in); got != tc.want {
				t.Fatalf("normalizeAccountAddress(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// candleRefKey/splitCandleKey are inverses; subscription ref-counting on
// reconnect relies on the round-trip being lossless.
func TestCandleKeyRoundTrip(t *testing.T) {
	if got := candleRefKey("BTC", "1m"); got != "BTC|1m" {
		t.Fatalf("candleRefKey = %q, want %q", got, "BTC|1m")
	}

	for _, pair := range [][2]string{{"BTC", "1m"}, {"ETH", "15m"}, {"xyz:CL", "1h"}} {
		coin, interval, ok := splitCandleKey(candleRefKey(pair[0], pair[1]))
		if !ok || coin != pair[0] || interval != pair[1] {
			t.Fatalf("round trip of (%q,%q) = (%q,%q,%v)", pair[0], pair[1], coin, interval, ok)
		}
	}

	for _, bad := range []string{"nopipe", "BTC|", "|1m", ""} {
		if _, _, ok := splitCandleKey(bad); ok {
			t.Fatalf("splitCandleKey(%q) reported ok, want false", bad)
		}
	}
}

func TestChartCandleRefSetIncludesCompositeCVDFeeds(t *testing.T) {
	refs := chartCandleRefSet("BTC", "2h")
	for _, key := range []string{"BTC|2h", "BTC|5m", "BTC|30m"} {
		if !refs[key] {
			t.Fatalf("missing active chart candle ref %q: %v", key, refs)
		}
	}
	if len(refs) != 3 {
		t.Fatalf("2h refs = %v, want exactly primary + 5m/30m sources", refs)
	}

	// 1m computes CVD from its own bars; 1w/1M do not attach CVD.
	for _, interval := range []string{"1m", "1w", "1M"} {
		refs = chartCandleRefSet("BTC", interval)
		if len(refs) != 1 || !refs[candleRefKey("BTC", interval)] {
			t.Fatalf("%s refs = %v, want primary only", interval, refs)
		}
	}
}
