package websocket

import (
	"hyperliquid-go/internal/services"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gorillaws "github.com/gorilla/websocket"
)

// dialTestConn stands up a throwaway websocket endpoint and returns a live
// client-side *websocket.Conn, so code paths that call conn.Close() operate on
// a real connection rather than panicking on a zero-value Conn.
func dialTestConn(t *testing.T) *gorillaws.Conn {
	t.Helper()
	upgrader := gorillaws.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		go func() {
			for {
				if _, _, err := c.ReadMessage(); err != nil {
					return
				}
			}
		}()
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := gorillaws.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial test websocket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func clientIsClosed(c *streamClient) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func TestDecorateMessageForInjectsIncrementingEventId(t *testing.T) {
	m := NewWebSocketManager(nil)

	first := string(m.decorateMessageFor(tradingStream, []byte(`{"a":1}`)))
	if first != `{"eventId":1,"a":1}` {
		t.Fatalf("first decorate = %q, want %q", first, `{"eventId":1,"a":1}`)
	}

	second := string(m.decorateMessageFor(tradingStream, []byte(`{"b":2}`)))
	if second != `{"eventId":2,"b":2}` {
		t.Fatalf("second decorate = %q, want eventId 2", second)
	}
}

func TestDecorateMessageForLeavesNonObjectPayloadsUntouched(t *testing.T) {
	m := NewWebSocketManager(nil)

	// A JSON array does not start with '{', so it must pass through unchanged
	// (the sequence is still consumed, but the bytes are not rewritten).
	if got := string(m.decorateMessageFor(marketStream, []byte(`[1,2,3]`))); got != `[1,2,3]` {
		t.Fatalf("array payload = %q, want unchanged", got)
	}
	if got := string(m.decorateMessageFor(marketStream, []byte(``))); got != `` {
		t.Fatalf("empty payload = %q, want unchanged", got)
	}
}

func TestTradingAndMarketSequencesAreIndependent(t *testing.T) {
	m := NewWebSocketManager(nil)
	marketFirst := string(m.decorateMessageFor(marketStream, []byte(`{"lane":"market"}`)))
	marketSecond := string(m.decorateMessageFor(marketStream, []byte(`{"lane":"market"}`)))
	tradingFirst := string(m.decorateMessageFor(tradingStream, []byte(`{"lane":"trading"}`)))

	if !strings.Contains(marketFirst, `"eventId":1`) || !strings.Contains(marketSecond, `"eventId":2`) {
		t.Fatalf("market sequence not monotonic: %s / %s", marketFirst, marketSecond)
	}
	if !strings.Contains(tradingFirst, `"eventId":1`) {
		t.Fatalf("trading sequence was advanced by market traffic: %s", tradingFirst)
	}
}

func TestDomainBroadcastsUseIsolatedClientQueues(t *testing.T) {
	const account = "0x1111111111111111111111111111111111111111"
	m := NewWebSocketManager(nil)
	newClient := func(kind streamKind) *streamClient {
		return &streamClient{
			kind: kind, account: account, conn: &gorillaws.Conn{},
			sendCh: make(chan []byte, 4), doneCh: make(chan struct{}),
		}
	}
	trading := newClient(tradingStream)
	market := newClient(marketStream)
	m.streamClients[trading] = true
	m.streamClients[market] = true

	m.BroadcastMarket([]byte(`{"channel":"allMids","data":{}}`))
	if len(trading.sendCh) != 0 || len(market.sendCh) != 1 {
		t.Fatalf("market broadcast queues trading=%d market=%d", len(trading.sendCh), len(market.sendCh))
	}

	m.BroadcastToAccount(account, []byte(`{"channel":"webData2","data":{}}`))
	if len(trading.sendCh) != 1 || len(market.sendCh) != 1 {
		t.Fatalf("trading broadcast queues trading=%d market=%d", len(trading.sendCh), len(market.sendCh))
	}
}

func TestMarketSubscriptionIntentIgnoresTradingClientWithSameID(t *testing.T) {
	m := NewWebSocketManager(nil)
	trading := &streamClient{id: "tab-1", kind: tradingStream}
	market := &streamClient{id: "tab-1", kind: marketStream}
	m.streamClients[trading] = true
	m.streamClients[market] = true

	result := m.UpdateMarketSubscriptions("tab-1", "BTC", "1m", []string{"BTC"})
	if result.Rejected || market.market.Coin != "BTC" {
		t.Fatalf("market client did not receive intent: result=%+v state=%+v", result, market.market)
	}
	if !trading.market.isEmpty() {
		t.Fatalf("trading client acquired market subscription state: %+v", trading.market)
	}
}

// The backpressure contract: a slow client whose send buffer fills up is
// dropped rather than allowed to block the broadcaster. This protects every
// other connected client from one stalled consumer.
func TestSendRawToClientDropsClientWhenQueueFull(t *testing.T) {
	m := NewWebSocketManager(nil)
	client := &streamClient{
		id:     "slow",
		kind:   marketStream,
		conn:   dialTestConn(t),
		sendCh: make(chan []byte, clientSendQueueSize),
		doneCh: make(chan struct{}),
	}

	// Fill the buffer exactly. No writer goroutine is started, so nothing drains it.
	for i := 0; i < clientSendQueueSize; i++ {
		m.sendRawToClient(client, []byte(`{"k":1}`))
	}
	if clientIsClosed(client) {
		t.Fatal("client closed before the queue was full")
	}
	if got := len(client.sendCh); got != clientSendQueueSize {
		t.Fatalf("queued %d messages, want %d", got, clientSendQueueSize)
	}

	// The next send cannot be buffered → the client is dropped.
	m.sendRawToClient(client, []byte(`{"k":1}`))
	if !clientIsClosed(client) {
		t.Fatal("expected client to be dropped once its send queue was full")
	}
}

func TestSendRawToClientIsNoOpForClosedClient(t *testing.T) {
	m := NewWebSocketManager(nil)
	client := &streamClient{
		id:     "gone",
		kind:   tradingStream,
		sendCh: make(chan []byte, 4),
		doneCh: make(chan struct{}),
	}
	m.closeStreamClient(client)

	// Must not panic and must not enqueue onto a closed client.
	m.sendRawToClient(client, []byte(`{"k":1}`))
	if got := len(client.sendCh); got != 0 {
		t.Fatalf("enqueued %d messages onto a closed client, want 0", got)
	}
}

func TestCloseStreamClientIsIdempotent(t *testing.T) {
	m := NewWebSocketManager(nil)
	client := &streamClient{
		id:     "x",
		kind:   tradingStream,
		sendCh: make(chan []byte, 1),
		doneCh: make(chan struct{}),
	}

	// Closing twice must not panic (double close of doneCh would).
	m.closeStreamClient(client)
	m.closeStreamClient(client)

	if !clientIsClosed(client) {
		t.Fatal("client not marked closed")
	}
	select {
	case <-client.doneCh:
		// expected: doneCh is closed
	default:
		t.Fatal("doneCh was not closed")
	}
}

func TestFilterNewsForClientKeepsGlobalAndSubscribedCoins(t *testing.T) {
	client := &streamClient{kind: marketStream, market: marketSubscriptionState{Coin: "BTC", TradeCoins: map[string]bool{"SOL": true}}}
	items := []*services.MarketNewsItem{
		{ID: "global", Scope: "global"},
		{ID: "btc", Coins: []string{"BTC"}},
		{ID: "sol", Coins: []string{"SOL"}},
		{ID: "eth", Coins: []string{"ETH"}},
	}
	got := filterNewsForClient(client, items)
	if len(got) != 3 {
		t.Fatalf("filtered %d items, want 3", len(got))
	}
	for _, item := range got {
		if item.ID == "eth" {
			t.Fatal("included unsubscribed ETH news")
		}
	}
}

func TestStreamQueueCapacityForKind(t *testing.T) {
	if got := streamQueueCapacityFor(marketStream); got != 2048 {
		t.Fatalf("market stream capacity = %d, want 2048", got)
	}
	if got := streamQueueCapacityFor(tradingStream); got != 512 {
		t.Fatalf("trading stream capacity = %d, want 512", got)
	}
}
