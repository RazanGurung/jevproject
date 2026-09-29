package websocket

import (
	"fmt"
	"testing"
)

// Permanent candle refs feed the server-side candle store. If they are
// dropped by client churn or lost on reconnect, the store's tails silently
// go stale.
func TestAddPermanentCandleSubscriptions(t *testing.T) {
	m := NewWebSocketManager(nil)
	m.AddPermanentCandleSubscriptions([][2]string{
		{"BTC", "8h"},
		{"BTC", "30m"},
		{"xyz:GOLD", "8h"},
	})

	for _, key := range []string{"BTC|8h", "BTC|30m", "xyz:GOLD|8h"} {
		if m.MarketCandleRefs[key] != 1 {
			t.Fatalf("ref %s = %d, want 1", key, m.MarketCandleRefs[key])
		}
	}

	// A client subscribing then leaving the same coin/interval must not
	// release the permanent ref.
	writeSub := func(string, map[string]interface{}) {}
	m.MarketSubMu.Lock()
	m.incrementCandleRef("BTC", "8h", writeSub)
	m.decrementCandleRef("BTC", "8h", writeSub)
	m.MarketSubMu.Unlock()
	if m.MarketCandleRefs["BTC|8h"] != 1 {
		t.Fatalf("permanent ref released by client churn: %d", m.MarketCandleRefs["BTC|8h"])
	}

	// reapplySubscriptions walks MarketCandleRefs, so permanent refs survive
	// reconnects; with a nil conn every write no-ops successfully.
	if !m.reapplySubscriptions(nil, nil, nil, false) {
		t.Fatal("reapply with permanent refs failed")
	}
}

// Eviction releases the store's permanent refs without touching client-held
// refs — a chart a browser is viewing must keep its upstream feed even when
// the store decides the series is idle.
func TestRemovePermanentCandleSubscriptions(t *testing.T) {
	m := NewWebSocketManager(nil)
	m.AddPermanentCandleSubscriptions([][2]string{
		{"BTC", "8h"},
		{"ETH", "15m"},
	})
	// A benign onRegister double-fire leaves a doubled permanent ref; removal
	// must drain it fully, not decrement once.
	m.AddPermanentCandleSubscriptions([][2]string{{"ETH", "15m"}})

	// A client is viewing BTC 8h.
	writeSub := func(string, map[string]interface{}) {}
	m.MarketSubMu.Lock()
	m.incrementCandleRef("BTC", "8h", writeSub)
	m.MarketSubMu.Unlock()

	m.RemovePermanentCandleSubscriptions([][2]string{
		{"BTC", "8h"},
		{"ETH", "15m"},
	})

	if _, ok := m.PermanentCandleRefs["BTC|8h"]; ok {
		t.Fatal("permanent ref entry not deleted for BTC|8h")
	}
	if _, ok := m.PermanentCandleRefs["ETH|15m"]; ok {
		t.Fatal("doubled permanent ref not fully drained for ETH|15m")
	}
	if m.MarketCandleRefs["BTC|8h"] != 1 {
		t.Fatalf("client-held ref lost: BTC|8h = %d, want 1", m.MarketCandleRefs["BTC|8h"])
	}
	if _, ok := m.MarketCandleRefs["ETH|15m"]; ok {
		t.Fatalf("permanent-only key still subscribed: ETH|15m = %d", m.MarketCandleRefs["ETH|15m"])
	}

	// Removing a key with no permanent refs is a no-op.
	m.RemovePermanentCandleSubscriptions([][2]string{{"SOL", "1h"}})
	if _, ok := m.MarketCandleRefs["SOL|1h"]; ok {
		t.Fatal("no-op removal created a ref")
	}
}

// Permanent (store-held) subscriptions are NOT "active": ActiveCandleSeries
// must report only client-held series, or the warm coordinator's Tier 0
// treats the whole warmed universe as actively viewed and grinds it (plus its
// CVD-source expansion) ahead of the ordered warm tiers — observed live as
// the initial warm pass devolving into map-random heavy-series churn.
func TestActiveCandleSeriesExcludesPermanentRefs(t *testing.T) {
	m := NewWebSocketManager(nil)
	m.AddPermanentCandleSubscriptions([][2]string{
		{"BTC", "8h"},
		{"ETH", "15m"},
	})

	if got := m.ActiveCandleSeries(); len(got) != 0 {
		t.Fatalf("permanent-only refs reported active: %v", got)
	}

	// A client subscribing to one of the same keys makes exactly that key active.
	writeSub := func(string, map[string]interface{}) {}
	m.MarketSubMu.Lock()
	m.incrementCandleRef("BTC", "8h", writeSub)
	m.MarketSubMu.Unlock()

	got := m.ActiveCandleSeries()
	if len(got) != 1 || got[0] != [2]string{"BTC", "8h"} {
		t.Fatalf("client-held series not reported active: %v", got)
	}

	// Client leaves: nothing active again, permanent ref intact.
	m.MarketSubMu.Lock()
	m.decrementCandleRef("BTC", "8h", writeSub)
	m.MarketSubMu.Unlock()
	if got := m.ActiveCandleSeries(); len(got) != 0 {
		t.Fatalf("series still active after client left: %v", got)
	}
	if m.MarketCandleRefs["BTC|8h"] != 1 {
		t.Fatalf("permanent ref lost: %d", m.MarketCandleRefs["BTC|8h"])
	}
}

// candleSink wiring must tolerate being absent (nil) and must receive
// candle messages when present.
type recordingSink struct {
	applied  int
	down, up int
	lastCoin string
	lastIvl  string
	dropped  [][2]string
}

func (r *recordingSink) ApplyWSCandle(wsMsg map[string]interface{}) {
	r.applied++
	data, _ := wsMsg["data"].(map[string]interface{})
	r.lastCoin, _ = data["s"].(string)
	r.lastIvl, _ = data["i"].(string)
}
func (r *recordingSink) AnnotateWSCandle(wsMsg map[string]interface{}, raw []byte) []byte {
	return raw
}
func (r *recordingSink) OnMarketWSDown()      { r.down++ }
func (r *recordingSink) OnMarketWSReconnect() { r.up++ }
func (r *recordingSink) OnCandleFeedDropped(coin, interval string) {
	r.dropped = append(r.dropped, [2]string{coin, interval})
}

func TestClientOnlyCandleUnsubscribeNotifiesSink(t *testing.T) {
	m := NewWebSocketManager(nil)
	sink := &recordingSink{}
	m.SetCandleSink(sink)
	writeSub := func(string, map[string]interface{}) {}
	m.MarketSubMu.Lock()
	m.incrementCandleRef("ETH", "2h", writeSub)
	m.decrementCandleRef("ETH", "2h", writeSub)
	m.MarketSubMu.Unlock()
	if len(sink.dropped) != 1 || sink.dropped[0] != [2]string{"ETH", "2h"} {
		t.Fatalf("client-only unsubscribe dropped = %v, want ETH|2h", sink.dropped)
	}

	m.AddPermanentCandleSubscriptions([][2]string{{"BTC", "2h"}})
	m.MarketSubMu.Lock()
	m.incrementCandleRef("BTC", "2h", writeSub)
	m.decrementCandleRef("BTC", "2h", writeSub)
	m.MarketSubMu.Unlock()
	if len(sink.dropped) != 1 {
		t.Fatalf("permanent-held unsubscribe notified sink: %v", sink.dropped)
	}
}

func TestPermanentCandleFeedCapacityNotifiesSink(t *testing.T) {
	m := NewWebSocketManager(nil)
	sink := &recordingSink{}
	m.SetCandleSink(sink)
	for i := 0; i < maxMarketSubscriptions-2; i++ {
		key := candleRefKey(fmt.Sprintf("WARM%d", i), "1h")
		m.MarketCandleRefs[key] = 1
		m.PermanentCandleRefs[key] = 1
	}

	// A new permanent feed cannot fit once the two allMids subscriptions and
	// all existing candle feeds consume the entire budget.
	m.AddPermanentCandleSubscriptions([][2]string{{"NEW", "4h"}})
	if len(sink.dropped) != 1 || sink.dropped[0] != [2]string{"NEW", "4h"} {
		t.Fatalf("dropped feeds = %v, want NEW|4h", sink.dropped)
	}
}

func TestPermanentCandleFeedsHaveIndependentSmallCap(t *testing.T) {
	m := NewWebSocketManager(nil)
	sink := &recordingSink{}
	m.SetCandleSink(sink)
	for i := 0; i < maxPermanentCandleSubscriptions; i++ {
		m.AddPermanentCandleSubscriptions([][2]string{{fmt.Sprintf("CACHE%d", i), "1h"}})
	}

	m.AddPermanentCandleSubscriptions([][2]string{{"OVER", "1h"}})
	if len(m.PermanentCandleRefs) != maxPermanentCandleSubscriptions {
		t.Fatalf("permanent refs = %d, want cap %d", len(m.PermanentCandleRefs), maxPermanentCandleSubscriptions)
	}
	if len(sink.dropped) != 1 || sink.dropped[0] != [2]string{"OVER", "1h"} {
		t.Fatalf("dropped feeds = %v, want OVER|1h", sink.dropped)
	}
	if got := m.marketSubscriptionCountLocked(); got != maxPermanentCandleSubscriptions+2 {
		t.Fatalf("upstream subscriptions = %d, want %d", got, maxPermanentCandleSubscriptions+2)
	}
}

func TestMarkMarketSocketDegradedNotifiesSink(t *testing.T) {
	m := NewWebSocketManager(nil)
	sink := &recordingSink{}
	m.SetCandleSink(sink)

	// nil conn: nothing owned, no notification.
	m.markMarketSocketDegraded(nil)
	if sink.down != 0 {
		t.Fatalf("nil conn must not notify, down=%d", sink.down)
	}
}
