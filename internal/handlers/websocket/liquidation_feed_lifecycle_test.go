package websocket

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// silentLiqServer upgrades to a WS connection and then stays silent (sends
// nothing), reproducing a quiet liquidation feed — the exact condition that used
// to panic the read loop ("repeated read on failed websocket connection").
func silentLiqServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Drain client frames (subscribe/ping) but never push data.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	return srv, wsURL
}

// TestLiquidationFeedStop verifies that StartLiquidationFeeds runs against a
// silent upstream and StopLiquidationFeeds returns cleanly with no hang or panic.
func TestLiquidationFeedStop(t *testing.T) {
	srv, wsURL := silentLiqServer(t)
	defer srv.Close()

	m := NewWebSocketManager(nil)
	m.SetLiquidationConfig(wsURL, 0)

	m.StartLiquidationFeeds()
	time.Sleep(500 * time.Millisecond)

	done := make(chan struct{})
	go func() {
		m.StopLiquidationFeeds()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("StopLiquidationFeeds hung — context cancel did not unblock reads")
	}
}

// TestLiquidationFeedNoQuickNode verifies that feeds start and stop cleanly when
// QuickNode is unconfigured (only bybit).
func TestLiquidationFeedNoQuickNode(t *testing.T) {
	m := NewWebSocketManager(nil)
	m.StartLiquidationFeeds()
	time.Sleep(200 * time.Millisecond)
	m.StopLiquidationFeeds()
}

func TestLiquidationReconnectBackoffResetsAfterStableSession(t *testing.T) {
	backoff := newReconnectBackoff(time.Second, liqMaxBackoff, liqStableSession)
	for _, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second} {
		if got := backoff.Next(0); got != want {
			t.Fatalf("short session delay = %s, want %s", got, want)
		}
	}
	if got := backoff.Next(liqStableSession - time.Millisecond); got != liqMaxBackoff {
		t.Fatalf("short session reset backoff to %s, want %s", got, liqMaxBackoff)
	}
	if got := backoff.Next(liqStableSession); got != time.Second {
		t.Fatalf("stable session retained backoff %s, want 1s", got)
	}
	if got := backoff.Next(2 * liqStableSession); got != time.Second {
		t.Fatalf("long session retained capped backoff %s, want 1s", got)
	}
}
