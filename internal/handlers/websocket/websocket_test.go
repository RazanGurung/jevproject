package websocket

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gorillaws "github.com/gorilla/websocket"
)

func armFlow(manager *WebSocketManager, coins ...string) {
	for _, coin := range coins {
		manager.incrementTradeRef(coin, func(string, map[string]interface{}) {})
	}
}

func TestMarketSubscriptionCountIncludesEveryBuilderMidsFeed(t *testing.T) {
	m := NewWebSocketManager(nil)
	// Non-xyz builder dexs are filtered out; only xyz HIP-3 mids are subscribed.
	m.SetBuilderDexes([]string{"xyz", "vntl", "cash"})
	m.MarketBookRefs["BTC"] = 1
	m.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	// default allMids + xyz allMids + book + candle
	if got := m.marketSubscriptionCountLocked(); got != 4 {
		t.Fatalf("subscription count=%d want 4", got)
	}
	if len(m.builderDexes) != 1 || m.builderDexes[0] != "xyz" {
		t.Fatalf("builderDexes=%v want [xyz]", m.builderDexes)
	}
}

func TestUpdateMarketSubscriptionsTracksClientsIndependently(t *testing.T) {
	manager := NewWebSocketManager(nil)

	clientA := &streamClient{id: "a", kind: marketStream}
	clientB := &streamClient{id: "b", kind: marketStream}

	manager.streamClients[clientA] = true
	manager.streamClients[clientB] = true

	manager.UpdateMarketSubscriptions("a", "BTC", "1m", []string{"BTC", "ETH"})
	manager.UpdateMarketSubscriptions("b", "ETH", "5m", []string{"ETH"})

	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs = %d, want 1", got)
	}
	// Book now rides along on tradeCoins like trades: both client a
	// ("BTC" active, tradeCoins ["BTC","ETH"]) and client b ("ETH" active,
	// tradeCoins ["ETH"]) contribute an ETH book ref, so it's 2, not 1.
	if got := manager.MarketBookRefs["ETH"]; got != 2 {
		t.Fatalf("ETH book refs = %d, want 2", got)
	}
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "1m")]; got != 1 {
		t.Fatalf("BTC 1m candle refs = %d, want 1", got)
	}
	if got := manager.MarketCandleRefs[candleRefKey("ETH", "5m")]; got != 1 {
		t.Fatalf("ETH 5m candle refs = %d, want 1", got)
	}
	if got := manager.MarketTradeRefs["BTC"]; got != 1 {
		t.Fatalf("BTC trade refs = %d, want 1", got)
	}
	if got := manager.MarketTradeRefs["ETH"]; got != 2 {
		t.Fatalf("ETH trade refs = %d, want 2", got)
	}

	manager.clearClientMarketSubscriptions(clientA)

	if got := manager.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("BTC book refs after clear = %d, want 0", got)
	}
	if got := manager.MarketBookRefs["ETH"]; got != 1 {
		t.Fatalf("ETH book refs after clear = %d, want 1", got)
	}
	if got := manager.MarketTradeRefs["ETH"]; got != 1 {
		t.Fatalf("ETH trade refs after clear = %d, want 1", got)
	}
}

func TestVisibleChartHoldsCompositeCvdSourceRefs(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{id: "cvd-tab", kind: marketStream}
	manager.streamClients[client] = true

	manager.UpdateMarketSubscriptions(client.id, "BTC", "2h", []string{"BTC"})
	for _, interval := range []string{"2h", "5m", "30m"} {
		if got := manager.MarketCandleRefs[candleRefKey("BTC", interval)]; got != 1 {
			t.Fatalf("BTC %s refs = %d, want 1", interval, got)
		}
	}

	// A timeframe switch keeps the shared source refs and replaces only the
	// primary chart interval.
	manager.UpdateMarketSubscriptions(client.id, "BTC", "4h", []string{"BTC"})
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "2h")]; got != 0 {
		t.Fatalf("old BTC 2h ref survived switch: %d", got)
	}
	for _, interval := range []string{"4h", "5m", "30m"} {
		if got := manager.MarketCandleRefs[candleRefKey("BTC", interval)]; got != 1 {
			t.Fatalf("BTC %s refs after switch = %d, want 1", interval, got)
		}
	}

	manager.clearClientMarketSubscriptions(client)
	for _, interval := range []string{"4h", "5m", "30m"} {
		if got := manager.MarketCandleRefs[candleRefKey("BTC", interval)]; got != 0 {
			t.Fatalf("BTC %s ref survived client clear: %d", interval, got)
		}
	}
}

func TestVisibleRvwapHoldsAndReleasesDedicatedSourceRef(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{id: "rvwap-tab", kind: marketStream}
	manager.streamClients[client] = true

	manager.UpdateMarketSubscriptionsWithIndicators(client.id, "BTC", "2h", []string{"BTC"}, []string{"4h"})
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "4h")]; got != 1 {
		t.Fatalf("BTC 4h RVWAP refs = %d, want 1", got)
	}
	manager.UpdateMarketSubscriptionsWithIndicators(client.id, "BTC", "2h", []string{"BTC"}, nil)
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "4h")]; got != 0 {
		t.Fatalf("BTC 4h RVWAP ref survived disable: %d", got)
	}
}

// TestMarketBookRefSurvivesActiveCoinSwitchWhileInTradeCoins asserts book
// ref-counting now follows the TradeCoins diff (like trades) instead of the
// single active Coin — under the old logic, switching the active chart away
// from BTC while BTC remained in tradeCoins would have decremented (and
// unsubscribed) its book ref; under the new logic it must not, since BTC is
// still in the watchlist/tracked tradeCoins set.
func TestMarketBookRefSurvivesActiveCoinSwitchWhileInTradeCoins(t *testing.T) {
	manager := NewWebSocketManager(nil)

	client := &streamClient{id: "a", kind: marketStream}
	manager.streamClients[client] = true

	manager.UpdateMarketSubscriptions("a", "BTC", "1m", []string{"BTC", "ETH"})
	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs = %d, want 1", got)
	}

	// Switch the active chart to ETH; BTC stays in tradeCoins (still tracked
	// or watchlisted).
	manager.UpdateMarketSubscriptions("a", "ETH", "1m", []string{"BTC", "ETH"})

	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs after active coin switch = %d, want 1 (BTC still in tradeCoins)", got)
	}
	if got := manager.MarketBookRefs["ETH"]; got != 1 {
		t.Fatalf("ETH book refs after active coin switch = %d, want 1", got)
	}
}

func TestMarketSubscriptionReorderPreservesRefsAndFlow(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{id: "mover-tab", kind: marketStream}
	manager.streamClients[client] = true

	initial := manager.UpdateMarketSubscriptions(client.id, "BTC", "1m", []string{"BTC", "ETH", "SOL"})
	if !initial.Changed || len(initial.AddedTradeCoins) != 3 {
		t.Fatalf("initial subscription result = %+v, want three added coins", initial)
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
		map[string]interface{}{
			"coin": "ETH", "px": "100", "sz": "2", "side": "B",
			"tid": float64(1), "time": float64(1000),
		},
	}})
	before := manager.flowSnapshot("ETH")

	// The mover poll may return the same membership in a different rank order.
	// Subscription state is set-based, so this must not release/reacquire refs
	// or clear the retained rolling Flow window.
	reordered := manager.UpdateMarketSubscriptions(client.id, "BTC", "1m", []string{"SOL", "ETH", "BTC"})
	if reordered.Changed || len(reordered.AddedTradeCoins) != 0 {
		t.Fatalf("membership-only reorder was not an idempotent no-op: %+v", reordered)
	}

	for _, coin := range []string{"BTC", "ETH", "SOL"} {
		if got := manager.MarketBookRefs[coin]; got != 1 {
			t.Fatalf("%s book refs after reorder = %d, want 1", coin, got)
		}
		if got := manager.MarketTradeRefs[coin]; got != 1 {
			t.Fatalf("%s trade refs after reorder = %d, want 1", coin, got)
		}
	}
	after := manager.flowSnapshot("ETH")
	if before == nil || after == nil || *after != *before {
		t.Fatalf("ETH Flow changed across membership-only reorder: before=%+v after=%+v", before, after)
	}
}

func TestMarketFlowSnapshotNeededOncePerSocket(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{id: "snapshot-tab", kind: marketStream}
	manager.streamClients[client] = true

	if !manager.consumeMarketSnapshotNeed(client.id) {
		t.Fatal("first POST on a socket must request full flow hydration")
	}
	if manager.consumeMarketSnapshotNeed(client.id) {
		t.Fatal("second idempotent POST must not request another bulk hydration")
	}

	replacement := &streamClient{id: client.id, kind: marketStream}
	manager.registerStreamClient(replacement)
	if !manager.consumeMarketSnapshotNeed(replacement.id) {
		t.Fatal("replacement socket must start a fresh flow-snapshot epoch")
	}
}

func TestSubscriptionBudgetShedsBackgroundBeforeActiveFeed(t *testing.T) {
	manager := NewWebSocketManager(nil)
	sink := &recordingSink{}
	manager.SetCandleSink(sink)
	for i := 0; i < maxMarketSubscriptions-2; i++ {
		key := candleRefKey(fmt.Sprintf("WARM%d", i), "1h")
		manager.MarketCandleRefs[key] = 1
		manager.PermanentCandleRefs[key] = 1
	}
	client := &streamClient{id: "budget-client", kind: marketStream}
	manager.streamClients[client] = true

	result := manager.UpdateMarketSubscriptions("budget-client", "BTC", "1m", []string{"BTC", "ETH"})
	if len(result.AcceptedTradeCoins) != 1 || result.AcceptedTradeCoins[0] != "BTC" {
		t.Fatalf("active coin was not retained: %+v", result)
	}
	if len(result.DroppedTradeCoins) != 1 || result.DroppedTradeCoins[0] != "ETH" {
		t.Fatalf("background coin was not shed: %+v", result)
	}
	if got := manager.marketSubscriptionCountLocked(); got > maxMarketSubscriptions {
		t.Fatalf("subscription count = %d, exceeds budget %d", got, maxMarketSubscriptions)
	}
	// The active chart needs candle, book, and trade capacity, so it can evict
	// multiple dormant permanent feeds. Every one must be reported to the
	// candle store before it can serve a stale tail.
	if len(sink.dropped) == 0 {
		t.Fatal("expected evicted permanent feeds to be reported")
	}
}

func TestAdmissionCountsIndicatorCandleTowardBudget(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{id: "rvwap-budget", kind: marketStream}
	manager.streamClients[client] = true

	// Leave exactly two slots after the active BTC 1m chart (candle+book+trade).
	// Enabling 4h RVWAP in the same request as a new background coin must
	// consume one of those slots so ETH is shed instead of crossing 900.
	for i := 0; i < maxMarketSubscriptions-7; i++ {
		manager.MarketCandleRefs[fmt.Sprintf("WARM%d|1h", i)] = 1
	}
	if got := manager.marketSubscriptionCountLocked(); got != maxMarketSubscriptions-5 {
		t.Fatalf("prefill count=%d want %d", got, maxMarketSubscriptions-5)
	}

	initial := manager.UpdateMarketSubscriptions(client.id, "BTC", "1m", []string{"BTC"})
	if !initial.Changed {
		t.Fatalf("initial chart did not apply: %+v", initial)
	}
	if got := manager.marketSubscriptionCountLocked(); got != maxMarketSubscriptions-2 {
		t.Fatalf("after BTC 1m count=%d want %d", got, maxMarketSubscriptions-2)
	}

	enabled := manager.UpdateMarketSubscriptionsWithIndicators(
		client.id, "BTC", "1m", []string{"BTC", "ETH"}, []string{"4h"},
	)
	if got := manager.marketSubscriptionCountLocked(); got > maxMarketSubscriptions {
		t.Fatalf("RVWAP + new background coin exceeded budget: after=%d cap=%d result=%+v", got, maxMarketSubscriptions, enabled)
	}
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "4h")]; got != 1 {
		t.Fatalf("BTC 4h RVWAP refs = %d, want 1", got)
	}
	if len(enabled.DroppedTradeCoins) != 1 || enabled.DroppedTradeCoins[0] != "ETH" {
		t.Fatalf("expected ETH to be shed for the 4h candle slot: %+v", enabled)
	}
}

func TestClientWantsMarketMessage(t *testing.T) {
	client := &streamClient{
		kind:   marketStream,
		market: buildMarketSubscriptionState("BTC", "1m", []string{"BTC", "ETH"}, []string{"4h"}),
	}

	if !clientWantsMarketMessage(client, "l2Book", map[string]interface{}{
		"channel": "l2Book",
		"data": map[string]interface{}{
			"coin": "BTC",
		},
	}) {
		t.Fatal("expected l2Book BTC message to match client subscription")
	}

	// ETH is in the client's tradeCoins set (background watchlist/tracked
	// coin), so its l2Book now rides along too, mirroring trades.
	if !clientWantsMarketMessage(client, "l2Book", map[string]interface{}{
		"channel": "l2Book",
		"data": map[string]interface{}{
			"coin": "ETH",
		},
	}) {
		t.Fatal("expected ETH l2Book message to match client's tradeCoins subscription")
	}

	if clientWantsMarketMessage(client, "l2Book", map[string]interface{}{
		"channel": "l2Book",
		"data": map[string]interface{}{
			"coin": "SOL",
		},
	}) {
		t.Fatal("did not expect SOL l2Book message to match a client with neither coin nor tradeCoins for SOL")
	}

	// Real Hyperliquid candle messages are flat with "s"/"i" keys.
	if !clientWantsMarketMessage(client, "candle", map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(1700000000000),
			"T": float64(1700000059999),
			"s": "BTC",
			"i": "1m",
			"o": "50000",
			"c": "50100",
			"h": "50200",
			"l": "49900",
			"v": "12.5",
			"n": float64(42),
		},
	}) {
		t.Fatal("expected BTC 1m candle to match client subscription")
	}

	if clientWantsMarketMessage(client, "candle", map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(1700000000000),
			"s": "BTC",
			"i": "5m",
			"o": "50000",
			"c": "50100",
		},
	}) {
		t.Fatal("did not expect BTC 5m candle to match BTC 1m client subscription")
	}

	if !clientWantsMarketMessage(client, "candle", map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(1700000000000),
			"s": "BTC",
			"i": "4h",
			"o": "50000",
			"c": "50100",
		},
	}) {
		t.Fatal("expected BTC 4h RVWAP source candle to match indicator subscription")
	}

	// Legacy {coin, interval} shape remains supported.
	if !clientWantsMarketMessage(client, "candle", map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"coin":     "BTC",
			"interval": "1m",
		},
	}) {
		t.Fatal("expected legacy-shaped BTC 1m candle to match client subscription")
	}

	if !clientWantsMarketMessage(client, "trades", map[string]interface{}{
		"channel": "trades",
		"data": []interface{}{
			map[string]interface{}{"coin": "ETH"},
		},
	}) {
		t.Fatal("expected ETH trades to match client trade subscriptions")
	}
}

func TestUpdateFlowFromTradesIncludesEveryValidPrintAndWhaleSubset(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	manager.updateFlowFromTrades(map[string]interface{}{
		"data": []interface{}{
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "999", "side": "B"},
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "1000", "side": "B"},
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "99999", "side": "A"},
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "100000", "side": "A"},
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "250000", "side": "A"},
		},
	})
	snapshot := manager.flowSnapshot("BTC")
	if snapshot.regularBuyVol != 1999 || snapshot.regularSellVol != 99999 ||
		snapshot.buyVol != 1999 || snapshot.sellVol != 449999 || snapshot.whaleSellVol != 350000 {
		t.Fatalf("unexpected flow totals: %+v", snapshot)
	}
	if snapshot.whaleBuyVol != 0 || snapshot.sampleCount != 5 || snapshot.whaleSampleCount != 2 {
		t.Fatalf("unexpected independent sample metadata: %+v", snapshot)
	}
}

func TestAnnotateTradesMessagePublishesRollingFlow(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	message := map[string]interface{}{
		"channel": "trades",
		"data": []interface{}{
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "1000", "side": "B", "tid": float64(1), "time": float64(1000)},
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "100000", "side": "A", "tid": float64(2), "time": float64(2000)},
		},
	}
	manager.updateFlowFromTrades(message)
	raw, _ := json.Marshal(message)
	var decoded map[string]interface{}
	if err := json.Unmarshal(manager.annotateTradesMessage(message, raw), &decoded); err != nil {
		t.Fatalf("annotated trades message is not valid JSON: %v", err)
	}
	flow, ok := decoded["_flow"].(map[string]interface{})
	if !ok {
		t.Fatalf("_flow missing from trades annotation: %v", decoded)
	}
	if flow["buyVol"] != float64(1000) || flow["sellVol"] != float64(100000) {
		t.Fatalf("unexpected rolling totals: %v", flow)
	}
	if flow["whaleSellVol"] != float64(100000) || flow["whaleHaloHalfLifeMs"] != whaleHaloHalfLifeMs {
		t.Fatalf("unexpected whale metadata: %v", flow)
	}
	if flow["whaleThresholdUsd"] != whaleThreshold || flow["whaleFlowThresholdUsd"] != whaleFlowThreshold {
		t.Fatalf("unexpected DOM/flow whale thresholds: %v", flow)
	}
	if flow["sampleCount"] != float64(2) || flow["sampleCapacity"] != float64(flowSampleCapacity) ||
		flow["oldestTimeMs"] != float64(1000) || flow["newestTimeMs"] != float64(2000) {
		t.Fatalf("unexpected rolling sample metadata: %v", flow)
	}
	if flow["whaleSampleCount"] != float64(1) || flow["whaleSampleCapacity"] != float64(flowSampleCapacity) ||
		flow["whaleOldestTimeMs"] != float64(2000) || flow["whaleNewestTimeMs"] != float64(2000) {
		t.Fatalf("unexpected whale rolling sample metadata: %v", flow)
	}
	if flow["revision"] != float64(2) {
		t.Fatalf("missing first inserted Flow revision: %v", flow)
	}
	if _, exists := flow["halfLifeMs"]; exists {
		t.Fatalf("obsolete flow half-life still published: %v", flow)
	}
}

func TestFlowRevisionAdvancesOnlyForNewTradesAndSurvivesCoinCleanup(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	first := map[string]interface{}{"data": []interface{}{
		map[string]interface{}{"coin": "BTC", "px": "1", "sz": "10", "side": "B", "tid": float64(1)},
	}}
	manager.updateFlowFromTrades(first)
	manager.updateFlowFromTrades(first)
	if snapshot := manager.flowSnapshot("BTC"); snapshot == nil || snapshot.revision != 2 {
		t.Fatalf("replay changed Flow revision: %+v", snapshot)
	}

	manager.decrementTradeRef("BTC", func(string, map[string]interface{}) {})
	if snapshot := manager.flowSnapshot("BTC"); snapshot == nil || snapshot.revision != 3 || snapshot.sampleCount != 0 {
		t.Fatalf("cleared Flow did not publish a newer empty revision: %+v", snapshot)
	}
	armFlow(manager, "BTC")
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
		map[string]interface{}{"coin": "BTC", "px": "1", "sz": "20", "side": "A", "tid": float64(2)},
	}})
	if snapshot := manager.flowSnapshot("BTC"); snapshot == nil || snapshot.revision != 5 {
		t.Fatalf("Flow revision reset after cleanup: %+v", snapshot)
	}
}

func TestFlowSnapshotDoesNotDecayWithElapsedTime(t *testing.T) {
	manager := NewWebSocketManager(nil)
	manager.coinFlowCache["BTC"] = &coinFlowEntry{
		all: rollingFlowWindow{
			buyVol: 1400, sellVol: 700, regularBuyVol: 1000, regularSellVol: 500,
		},
		whale: rollingFlowWindow{buyVol: 400, sellVol: 200},
	}

	first := manager.flowSnapshot("BTC")
	time.Sleep(time.Millisecond)
	second := manager.flowSnapshot("BTC")
	if first == nil || second == nil || *first != *second {
		t.Fatalf("rolling flow changed without a trade: first=%+v second=%+v", first, second)
	}
}

func TestFlowSampleEvictsOldestPrintAtCapacity(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	trades := make([]interface{}, 0, flowSampleCapacity+1)
	for index := 0; index <= flowSampleCapacity; index++ {
		trades = append(trades, map[string]interface{}{
			"coin": "BTC", "px": "1", "sz": "1", "side": "B",
			"tid": float64(index + 1), "time": float64(1000 + index),
		})
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": trades})

	snapshot := manager.flowSnapshot("BTC")
	if snapshot == nil || snapshot.sampleCount != flowSampleCapacity {
		t.Fatalf("unexpected sample size: %+v", snapshot)
	}
	if snapshot.buyVol != flowSampleCapacity || snapshot.regularBuyVol != flowSampleCapacity ||
		snapshot.oldestTimeMs != 1001 || snapshot.newestTimeMs != 1500 {
		t.Fatalf("oldest print was not evicted exactly: %+v", snapshot)
	}
}

func TestWhaleFlowKeepsIndependentLatestQualifyingSample(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
		map[string]interface{}{
			"coin": "BTC", "px": "1", "sz": "100000", "side": "A",
			"tid": float64(1), "time": float64(1000),
		},
	}})

	trades := make([]interface{}, 0, flowSampleCapacity+1)
	for index := 0; index <= flowSampleCapacity; index++ {
		trades = append(trades, map[string]interface{}{
			"coin": "BTC", "px": "1", "sz": "1", "side": "B",
			"tid": float64(index + 2), "time": float64(2000 + index),
		})
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": trades})

	snapshot := manager.flowSnapshot("BTC")
	if snapshot == nil || snapshot.sampleCount != flowSampleCapacity ||
		snapshot.buyVol != flowSampleCapacity || snapshot.sellVol != 0 {
		t.Fatalf("unexpected ALL sample after ordinary traffic: %+v", snapshot)
	}
	if snapshot.whaleSampleCount != 1 || snapshot.whaleSellVol != 100000 ||
		snapshot.whaleOldestTimeMs != 1000 || snapshot.whaleNewestTimeMs != 1000 {
		t.Fatalf("ordinary traffic evicted the independent WHALE sample: %+v", snapshot)
	}
}

func TestFlowSampleKeepsLatestPrintsWhenBatchArrivesOutOfOrder(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	trades := make([]interface{}, 0, flowSampleCapacity+1)
	for index := flowSampleCapacity; index >= 0; index-- {
		trades = append(trades, map[string]interface{}{
			"coin": "BTC", "px": "1", "sz": "1", "side": "A",
			"tid": float64(index + 1), "time": float64(1000 + index),
		})
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": trades})

	snapshot := manager.flowSnapshot("BTC")
	if snapshot == nil || snapshot.sampleCount != flowSampleCapacity || snapshot.sellVol != flowSampleCapacity ||
		snapshot.regularSellVol != flowSampleCapacity {
		t.Fatalf("unexpected out-of-order sample: %+v", snapshot)
	}
	if snapshot.oldestTimeMs != 1001 || snapshot.newestTimeMs != 1500 {
		t.Fatalf("sample is not exchange-time ordered: %+v", snapshot)
	}
}

func TestWhaleFlowEvictsItsOldestQualifyingPrintOutOfOrder(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	trades := make([]interface{}, 0, flowSampleCapacity+1)
	for index := flowSampleCapacity; index >= 0; index-- {
		trades = append(trades, map[string]interface{}{
			"coin": "BTC", "px": "1", "sz": "100000", "side": "B",
			"tid": float64(index + 1), "time": float64(1000 + index),
		})
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": trades})

	snapshot := manager.flowSnapshot("BTC")
	if snapshot == nil || snapshot.whaleSampleCount != flowSampleCapacity ||
		snapshot.whaleBuyVol != float64(flowSampleCapacity)*100000 {
		t.Fatalf("unexpected WHALE sample: %+v", snapshot)
	}
	if snapshot.whaleOldestTimeMs != 1001 || snapshot.whaleNewestTimeMs != 1500 {
		t.Fatalf("WHALE sample is not independently exchange-time ordered: %+v", snapshot)
	}
}

func TestUpdateFlowFromTradesDedupesReplayedTradeIDs(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	message := map[string]interface{}{
		"data": []interface{}{
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "100000", "side": "B", "tid": float64(42)},
		},
	}
	manager.updateFlowFromTrades(message)
	manager.updateFlowFromTrades(message)
	entry := manager.flowSnapshot("BTC")
	if entry == nil || entry.whaleBuyVol != 100000 {
		t.Fatalf("replayed trade changed whale flow: %+v", entry)
	}
}

func TestWhaleFlowDedupeOutlivesOrdinaryTradeReplayFIFO(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	whale := map[string]interface{}{
		"coin": "BTC", "px": "1", "sz": "100000", "side": "B",
		"tid": float64(1), "time": float64(1000),
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{whale}})
	for index := 0; index <= maxFlowSeenKeys; index++ {
		manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
			map[string]interface{}{
				"coin": "BTC", "px": "1", "sz": "1", "side": "A",
				"tid": float64(index + 2), "time": float64(2000 + index),
			},
		}})
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{whale}})

	snapshot := manager.flowSnapshot("BTC")
	if snapshot == nil || snapshot.whaleSampleCount != 1 || snapshot.whaleBuyVol != 100000 {
		t.Fatalf("replayed whale changed the independent WHALE sample: %+v", snapshot)
	}
}

func TestCoinFlowConcurrentUpdateSnapshotAndCleanup(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	message := map[string]interface{}{
		"data": []interface{}{
			map[string]interface{}{"coin": "BTC", "px": "100", "sz": "100", "side": "B", "tid": float64(42)},
		},
	}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			manager.updateFlowFromTrades(message)
		}()
		go func() {
			defer wg.Done()
			_ = manager.flowSnapshot("BTC")
		}()
		go func() {
			defer wg.Done()
			manager.clearCoinFlow("BTC")
		}()
	}
	wg.Wait()
}

func TestDecrementFinalTradeRefClearsFlow(t *testing.T) {
	manager := NewWebSocketManager(nil)
	manager.MarketTradeRefs["BTC"] = 1
	manager.coinFlowCache["BTC"] = &coinFlowEntry{
		whale: rollingFlowWindow{
			buyVol: 10000,
			seen: tradeIdentityFIFO{
				seen: map[string]struct{}{"tid:1": {}}, order: []string{"tid:1"},
			},
		},
	}
	manager.decrementTradeRef("BTC", func(string, map[string]interface{}) {})
	if _, ok := manager.coinFlowCache["BTC"]; ok {
		t.Fatal("expected final trade ref release to clear flow")
	}
}

func TestLateTradesAfterUnsubscribeDoNotRecreateFlow(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
		map[string]interface{}{"coin": "BTC", "px": "1", "sz": "10", "side": "B", "tid": float64(1), "time": float64(1000)},
	}})
	manager.decrementTradeRef("BTC", func(string, map[string]interface{}) {})
	if _, ok := manager.coinFlowCache["BTC"]; ok {
		t.Fatal("expected unsubscribe to delete the flow cache")
	}

	snapshot := manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
		map[string]interface{}{"coin": "BTC", "px": "1", "sz": "20", "side": "A", "tid": float64(2), "time": float64(2000)},
	}})
	if _, ok := manager.coinFlowCache["BTC"]; ok {
		t.Fatal("in-flight trades after final unsubscribe recreated the flow cache")
	}
	if snapshot == nil || snapshot.sampleCount != 0 || snapshot.buyVol != 0 || snapshot.sellVol != 0 {
		t.Fatalf("late trades published a live window: %+v", snapshot)
	}
}

func TestFlowIdentityNotForgottenWhileStillInSample(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	newest := map[string]interface{}{
		"coin": "BTC", "px": "1", "sz": "1", "side": "B",
		"tid": float64(1), "time": float64(100000),
	}
	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{newest}})
	for index := 0; index < maxFlowSeenKeys; index++ {
		manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{
			map[string]interface{}{
				"coin": "BTC", "px": "1", "sz": "1", "side": "A",
				"tid": float64(index + 2), "time": float64(index + 1),
			},
		}})
	}

	before := manager.flowSnapshot("BTC")
	if before == nil || before.sampleCount != flowSampleCapacity {
		t.Fatalf("expected a full ALL window before replay: %+v", before)
	}
	newestStillPresent := false
	for _, trade := range manager.coinFlowCache["BTC"].all.trades {
		if trade.key == "tid:1" {
			newestStillPresent = true
			break
		}
	}
	if !newestStillPresent {
		t.Fatal("newest print left the time-ordered window; test does not exercise live-key FIFO wrap")
	}

	manager.updateFlowFromTrades(map[string]interface{}{"data": []interface{}{newest}})
	after := manager.flowSnapshot("BTC")
	if after == nil || after.sampleCount != before.sampleCount || after.buyVol != before.buyVol ||
		after.sellVol != before.sellVol || after.revision != before.revision {
		t.Fatalf("replay of an in-sample identity mutated the window: before=%+v after=%+v", before, after)
	}
}

func TestAnnotateTradesMessageDoesNotPublishTombstoneForInsertedBatch(t *testing.T) {
	manager := NewWebSocketManager(nil)
	armFlow(manager, "BTC")
	message := map[string]interface{}{
		"channel": "trades",
		"data": []interface{}{
			map[string]interface{}{"coin": "BTC", "px": "1", "sz": "1000", "side": "B", "tid": float64(7), "time": float64(1000)},
		},
	}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal trades: %v", err)
	}

	annotated := manager.annotateTradesMessage(message, raw)
	var decoded map[string]interface{}
	if err := json.Unmarshal(annotated, &decoded); err != nil {
		t.Fatalf("annotated trades message is not valid JSON: %v", err)
	}
	flow, ok := decoded["_flow"].(map[string]interface{})
	if !ok {
		t.Fatalf("_flow missing from trades annotation: %v", decoded)
	}
	if flow["buyVol"] != float64(1000) || flow["sampleCount"] != float64(1) {
		t.Fatalf("annotate published a snapshot that does not include the inserted print: %v", flow)
	}

	// A later unsubscribe tombstone must be a newer revision, not a rewrite of
	// the batch that already went downstream with buyVol=1000.
	insertedRevision := flow["revision"]
	manager.decrementTradeRef("BTC", func(string, map[string]interface{}) {})
	tombstone := manager.flowSnapshot("BTC")
	if tombstone == nil || tombstone.sampleCount != 0 || tombstone.revision <= uint64(insertedRevision.(float64)) {
		t.Fatalf("unsubscribe tombstone did not advance past the inserted batch: inserted=%v tombstone=%+v", insertedRevision, tombstone)
	}
}

func TestSetUserSessionKeepsExistingConnectionForSameSession(t *testing.T) {
	manager := NewWebSocketManager(nil)
	existingConn := &gorillaws.Conn{}
	pk := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	account := "0xef492108b4beb6ce032f170749d4115281c7278a"

	manager.UserWsKey = pk
	manager.UserAccountAddr = account
	manager.UserAddr = account
	manager.UserWsConn = existingConn

	manager.SetUserSession(pk, account)

	if manager.UserWsConn != existingConn {
		t.Fatal("expected existing user websocket connection to be preserved")
	}
	if got := len(manager.UserTrigger); got != 0 {
		t.Fatalf("expected no reconnect trigger for same session, got %d", got)
	}
}

func TestRegisterStreamClientReplacesExistingClientWithSameID(t *testing.T) {
	manager := NewWebSocketManager(nil)

	oldClient := &streamClient{
		id:     "client-1",
		kind:   marketStream,
		market: buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
	}
	manager.streamClients[oldClient] = true
	manager.MarketBookRefs["BTC"] = 1
	manager.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	manager.MarketTradeRefs["BTC"] = 1

	newClient := &streamClient{id: "client-1", kind: marketStream}
	count := manager.registerStreamClient(newClient)

	if count != 1 {
		t.Fatalf("expected exactly one logical stream client, got %d", count)
	}
	if manager.MarketBookRefs["BTC"] != 0 {
		t.Fatalf("expected old client market refs to be cleared, got %d", manager.MarketBookRefs["BTC"])
	}
	if !oldClient.closed {
		t.Fatal("expected old duplicate client to be marked closed")
	}
	if !manager.streamClients[newClient] {
		t.Fatal("expected new client to be registered")
	}
}

func TestWriteMarketSubscriptionClearsDegradedConnection(t *testing.T) {
	upgrader := gorillaws.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed: %v", err)
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := gorillaws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	manager := NewWebSocketManager(nil)
	manager.MarketWsConn = conn

	if err := conn.Close(); err != nil {
		t.Fatalf("close failed: %v", err)
	}

	if ok := manager.writeMarketSubscription(conn, "subscribe", marketSubscriptionPayload("l2Book", "BTC", "")); ok {
		t.Fatal("expected closed websocket write to fail")
	}
	if manager.MarketWsConn != nil {
		t.Fatal("expected degraded market websocket connection to be cleared")
	}
}

func TestSubscriptionWriterStopsAfterFirstFailure(t *testing.T) {
	calls := 0
	writeSub := stopAfterMarketSubscriptionWriteFailure(func(string, map[string]interface{}) bool {
		calls++
		return false
	})

	writeSub("unsubscribe", map[string]interface{}{"type": "trades", "coin": "BTC"})
	writeSub("unsubscribe", map[string]interface{}{"type": "l2Book", "coin": "BTC"})
	if calls != 1 {
		t.Fatalf("dead socket writer called %d times, want 1", calls)
	}
}

func TestSubscriptionWriterContinuesUntilFailure(t *testing.T) {
	calls := 0
	writeSub := stopAfterMarketSubscriptionWriteFailure(func(string, map[string]interface{}) bool {
		calls++
		return calls < 2
	})

	writeSub("subscribe", map[string]interface{}{"type": "trades", "coin": "BTC"})
	writeSub("subscribe", map[string]interface{}{"type": "l2Book", "coin": "BTC"})
	writeSub("subscribe", map[string]interface{}{"type": "candle", "coin": "BTC", "interval": "1h"})
	if calls != 2 {
		t.Fatalf("writer called %d times, want 2", calls)
	}
}

func TestReapplySubscriptionsClearsDegradedConnection(t *testing.T) {
	upgrader := gorillaws.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed: %v", err)
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := gorillaws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	manager := NewWebSocketManager(nil)
	manager.MarketWsConn = conn
	manager.MarketBookRefs["BTC"] = 1
	manager.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	manager.MarketTradeRefs["BTC"] = 1

	if err := conn.Close(); err != nil {
		t.Fatalf("close failed: %v", err)
	}

	if ok := manager.reapplySubscriptions(conn, nil, nil, false); ok {
		t.Fatal("expected reapply to fail on closed websocket connection")
	}
	if manager.MarketWsConn != nil {
		t.Fatal("expected degraded market websocket connection to be cleared after failed reapply")
	}
}

// The stall watchdog must force reconnects (bounded) instead of only logging:
// a silently-degraded upstream payload previously left the dashboard on REST
// fallbacks forever.
func TestHandleAccountStreamSilenceForcesReconnectThenWarnsOnly(t *testing.T) {
	manager := NewWebSocketManager(nil)
	lastWarnAt := time.Time{}

	// Fresh data: no intervention.
	manager.lastAccountStreamDataAt.Store(time.Now().Unix())
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != 0 {
		t.Fatalf("fresh stream: forced reconnects = %d, want 0", got)
	}

	// Stale data: force reconnect (UserWsConn is nil, so close is a no-op).
	manager.lastAccountStreamDataAt.Store(time.Now().Add(-10 * time.Minute).Unix())
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != 1 {
		t.Fatalf("first stall: forced reconnects = %d, want 1", got)
	}

	// Rate-limited within the warn window: no second action.
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != 1 {
		t.Fatalf("rate-limited stall: forced reconnects = %d, want 1", got)
	}

	// Next window: second (final) forced reconnect.
	lastWarnAt = time.Time{}
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != 2 {
		t.Fatalf("second stall: forced reconnects = %d, want 2", got)
	}

	// Cap reached: warn-only, the counter must not grow.
	lastWarnAt = time.Time{}
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != int32(maxForcedStreamReconnects) {
		t.Fatalf("capped stall: forced reconnects = %d, want %d", got, maxForcedStreamReconnects)
	}

	// Account state arriving resets the budget (mirrors the read-loop reset).
	manager.forcedUserReconnects.Store(0)
	manager.lastAccountStreamDataAt.Store(time.Now().Add(-10 * time.Minute).Unix())
	lastWarnAt = time.Time{}
	manager.handleAccountStreamSilence(&lastWarnAt)
	if got := manager.forcedUserReconnects.Load(); got != 1 {
		t.Fatalf("after reset: forced reconnects = %d, want 1", got)
	}
}

// Wake detection must compare wall-clock timestamps: time.Since uses the
// monotonic clock, which pauses during system sleep on darwin, so a real
// lid-close sleep measured as a ~3s tick gap and the detector never fired
// (observed live June 12, 2026 — five sleep/wake cycles, zero detections).
func TestCloseAllUpstreamsForWakeDebounces(t *testing.T) {
	m := NewWebSocketManager(nil)
	if !m.closeAllUpstreamsForWake() {
		t.Fatal("first lid-close cycle must run")
	}
	if m.closeAllUpstreamsForWake() {
		t.Fatal("a second cycle within wakeGapThreshold must not tear recovered sockets down again")
	}
	m.lastWakeCycleMs.Store(time.Now().UnixMilli() - wakeGapThreshold.Milliseconds() - 1)
	if !m.closeAllUpstreamsForWake() {
		t.Fatal("a later lid-close after the debounce window must cycle again")
	}
}

func TestMarketKeepaliveShouldCycleIgnoresReplacedConnections(t *testing.T) {
	now := time.Now().UnixMilli()
	stale := now - (2 * time.Hour).Milliseconds()
	if marketKeepaliveShouldCycle(false, stale, now) {
		t.Fatal("a replaced keepalive must not cycle the live socket after sleep")
	}
	if !marketKeepaliveShouldCycle(true, stale, now) {
		t.Fatal("the live keepalive must cycle after a lid-close gap")
	}
	if marketKeepaliveShouldCycle(true, now-upstreamPingInterval.Milliseconds(), now) {
		t.Fatal("a normal ping interval must not register as a system wake")
	}
}

func TestWakeGapExceededUsesWallClock(t *testing.T) {
	now := time.Now().UnixMilli()
	if wakeGapExceeded(now-xyzPositionPollInterval.Milliseconds(), now) {
		t.Fatal("a normal 3s tick gap must not register as a system wake")
	}
	if wakeGapExceeded(now-wakeGapThreshold.Milliseconds(), now) {
		t.Fatal("a gap exactly at the threshold must not register as a system wake")
	}
	if !wakeGapExceeded(now-(30*time.Minute).Milliseconds(), now) {
		t.Fatal("a 30-minute wall-clock gap (lid-close sleep) must register as a system wake")
	}
}

func TestIsSnapshotFillMessage(t *testing.T) {
	if !isSnapshotFillMessage(map[string]interface{}{"isSnapshot": true, "fills": []interface{}{}}) {
		t.Fatal("snapshot payload not detected")
	}
	if isSnapshotFillMessage(map[string]interface{}{"fills": []interface{}{}}) {
		t.Fatal("live payload misdetected as snapshot")
	}
	if isSnapshotFillMessage([]interface{}{}) {
		t.Fatal("array payload misdetected as snapshot")
	}
}

func TestBuildMidsSnapshotFiltersStaleAndFormatsMid(t *testing.T) {
	manager := NewWebSocketManager(nil)
	manager.MarketWsConn = &gorillaws.Conn{}
	now := time.Now()
	manager.BBOCache["BTC"] = BBOCache{Bid: 99999.5, Ask: 100000.5, Time: now}
	manager.BBOCache["xyz:GOLD"] = BBOCache{Bid: 2400, Ask: 2400, Time: now.Add(-30 * time.Second)}
	manager.BBOCache["STALE"] = BBOCache{Bid: 10, Ask: 10, Time: now.Add(-5 * time.Minute)}
	manager.BBOCache["ZERO"] = BBOCache{Bid: 0, Ask: 0, Time: now}

	mids := manager.buildMidsSnapshot(midsSnapshotMaxAge)

	if got := mids["BTC"]; got != "100000" {
		t.Fatalf("BTC mid = %v, want 100000", got)
	}
	if got := mids["xyz:GOLD"]; got != "2400" {
		t.Fatalf("xyz:GOLD mid = %v, want 2400", got)
	}
	if _, ok := mids["STALE"]; ok {
		t.Fatal("stale entry should be excluded from the snapshot")
	}
	if _, ok := mids["ZERO"]; ok {
		t.Fatal("zero-price entry should be excluded from the snapshot")
	}
}

func TestBuildMidsSnapshotEmptyCache(t *testing.T) {
	manager := NewWebSocketManager(nil)
	manager.MarketWsConn = &gorillaws.Conn{}
	if mids := manager.buildMidsSnapshot(midsSnapshotMaxAge); len(mids) != 0 {
		t.Fatalf("expected empty snapshot, got %d entries", len(mids))
	}
}

func TestBuildMidsSnapshotRequiresUpstream(t *testing.T) {
	manager := NewWebSocketManager(nil)
	now := time.Now()
	manager.BBOCache["BTC"] = BBOCache{Bid: 99999.5, Ask: 100000.5, Time: now}
	if mids := manager.buildMidsSnapshot(midsSnapshotMaxAge); len(mids) != 0 {
		t.Fatalf("disconnected snapshot = %d, want empty", len(mids))
	}
}

func TestClearClientMarketSubscriptionsDemotesToPending(t *testing.T) {
	manager := NewWebSocketManager(nil)

	client := &streamClient{
		id:     "client-1",
		kind:   marketStream,
		market: buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
	}
	manager.streamClients[client] = true
	manager.MarketBookRefs["BTC"] = 1
	manager.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	manager.MarketTradeRefs["BTC"] = 1

	manager.clearClientMarketSubscriptions(client)

	if got := manager.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("BTC book refs after clear = %d, want 0", got)
	}
	pending, ok := manager.PendingMarketSubs["client-1"]
	if !ok {
		t.Fatal("expected cleared subscription to be demoted to pending")
	}
	if pending.state.Coin != "BTC" || pending.state.Interval != "1m" || !pending.state.TradeCoins["BTC"] {
		t.Fatalf("pending state = %+v, want BTC/1m/[BTC]", pending.state)
	}

	// Clearing the same now-empty client again (the old handler's deferred
	// cleanup) must not touch the pending entry.
	manager.clearClientMarketSubscriptions(client)
	if _, ok := manager.PendingMarketSubs["client-1"]; !ok {
		t.Fatal("second clear on empty client must leave pending entry intact")
	}
}

func TestPendingRestoreSkipsClosedClient(t *testing.T) {
	manager := NewWebSocketManager(nil)
	client := &streamClient{
		id:     "client-1",
		kind:   marketStream,
		doneCh: make(chan struct{}),
		closed: true,
	}
	manager.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
		storedAt: time.Now(),
	}
	manager.applyPendingMarketSubscription(client)
	if got := manager.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("closed client must not restore refs, book=%d", got)
	}
	if _, ok := manager.PendingMarketSubs["client-1"]; !ok {
		t.Fatal("pending entry should remain for a live replacement client")
	}
}

func TestReconnectPreservesSubscriptionsWhenNewConnRegistersFirst(t *testing.T) {
	manager := NewWebSocketManager(nil)

	oldClient := &streamClient{
		id:     "client-1",
		kind:   marketStream,
		market: buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
	}
	manager.streamClients[oldClient] = true
	manager.MarketBookRefs["BTC"] = 1
	manager.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	manager.MarketTradeRefs["BTC"] = 1

	newClient := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(newClient)

	if got := manager.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("BTC book refs after register = %d, want 0", got)
	}
	if _, ok := manager.PendingMarketSubs["client-1"]; !ok {
		t.Fatal("expected stale client's subscription to be demoted to pending")
	}

	manager.applyPendingMarketSubscription(newClient)

	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs after pending apply = %d, want 1", got)
	}
	if got := manager.MarketCandleRefs[candleRefKey("BTC", "1m")]; got != 1 {
		t.Fatalf("BTC 1m candle refs after pending apply = %d, want 1", got)
	}
	if _, ok := manager.PendingMarketSubs["client-1"]; ok {
		t.Fatal("pending entry should be consumed by apply")
	}
	if newClient.market.Coin != "BTC" || newClient.market.Interval != "1m" {
		t.Fatalf("new client market state = %+v, want BTC/1m", newClient.market)
	}

	// The old handler's deferred clear arrives last; it must not damage the
	// restored refs or re-create a pending entry.
	manager.clearClientMarketSubscriptions(oldClient)
	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs after stale deferred clear = %d, want 1", got)
	}
	if _, ok := manager.PendingMarketSubs["client-1"]; ok {
		t.Fatal("stale deferred clear must not re-create pending entry")
	}
}

func TestReconnectPreservesSubscriptionsWhenOldHandlerExitsFirst(t *testing.T) {
	manager := NewWebSocketManager(nil)

	oldClient := &streamClient{
		id:     "client-1",
		kind:   marketStream,
		market: buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
	}
	manager.streamClients[oldClient] = true
	manager.MarketBookRefs["BTC"] = 1
	manager.MarketCandleRefs[candleRefKey("BTC", "1m")] = 1
	manager.MarketTradeRefs["BTC"] = 1

	// Old handler exits cleanly before the new connection arrives.
	manager.clearClientMarketSubscriptions(oldClient)
	delete(manager.streamClients, oldClient)

	newClient := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(newClient)
	manager.applyPendingMarketSubscription(newClient)

	if got := manager.MarketBookRefs["BTC"]; got != 1 {
		t.Fatalf("BTC book refs after reconnect = %d, want 1", got)
	}
	if got := manager.MarketTradeRefs["BTC"]; got != 1 {
		t.Fatalf("BTC trade refs after reconnect = %d, want 1", got)
	}
}

func TestStaleClearDoesNotDeletePendingStoredWhileDisconnected(t *testing.T) {
	manager := NewWebSocketManager(nil)

	// Subscribe POST lands while no client is connected.
	manager.UpdateMarketSubscriptions("client-1", "ETH", "5m", []string{"ETH"})
	if _, ok := manager.PendingMarketSubs["client-1"]; !ok {
		t.Fatal("expected subscribe with no live client to be stored as pending")
	}

	// Old handler's deferred clear for an already-empty client must not nuke it.
	staleClient := &streamClient{id: "client-1", kind: marketStream}
	manager.clearClientMarketSubscriptions(staleClient)
	if _, ok := manager.PendingMarketSubs["client-1"]; !ok {
		t.Fatal("stale clear deleted pending entry stored while disconnected")
	}

	newClient := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(newClient)
	manager.applyPendingMarketSubscription(newClient)
	if got := manager.MarketBookRefs["ETH"]; got != 1 {
		t.Fatalf("ETH book refs after pending apply = %d, want 1", got)
	}
}

func TestPendingMarketSubsExpireOnWrite(t *testing.T) {
	manager := NewWebSocketManager(nil)

	manager.PendingMarketSubs["expired"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", nil),
		storedAt: time.Now().Add(-11 * time.Minute),
	}

	// Any pending write prunes expired entries first.
	manager.UpdateMarketSubscriptions("fresh", "ETH", "5m", nil)

	if _, ok := manager.PendingMarketSubs["expired"]; ok {
		t.Fatal("expected expired pending entry to be pruned on write")
	}
	if _, ok := manager.PendingMarketSubs["fresh"]; !ok {
		t.Fatal("expected fresh pending entry to be kept")
	}
}

func TestFreshSubscribeWinsOverPendingApply(t *testing.T) {
	// Order 1: pending applies first, then a fresh POST transitions the refs.
	manager := NewWebSocketManager(nil)
	manager.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
		storedAt: time.Now(),
	}
	client := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(client)
	manager.applyPendingMarketSubscription(client)
	manager.UpdateMarketSubscriptions("client-1", "ETH", "5m", []string{"ETH"})
	if got := manager.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("BTC book refs after fresh subscribe = %d, want 0", got)
	}
	if got := manager.MarketBookRefs["ETH"]; got != 1 {
		t.Fatalf("ETH book refs after fresh subscribe = %d, want 1", got)
	}

	// Order 2: fresh POST first (deletes pending), pending apply then no-ops.
	manager2 := NewWebSocketManager(nil)
	manager2.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
		storedAt: time.Now(),
	}
	client2 := &streamClient{id: "client-1", kind: marketStream}
	manager2.registerStreamClient(client2)
	manager2.UpdateMarketSubscriptions("client-1", "ETH", "5m", []string{"ETH"})
	manager2.applyPendingMarketSubscription(client2)
	if got := manager2.MarketBookRefs["ETH"]; got != 1 {
		t.Fatalf("ETH book refs after late pending apply = %d, want 1", got)
	}
	if got := manager2.MarketBookRefs["BTC"]; got != 0 {
		t.Fatalf("BTC book refs after late pending apply = %d, want 0", got)
	}
	if client2.market.Coin != "ETH" {
		t.Fatalf("client market coin = %q, want ETH (fresh subscribe must win)", client2.market.Coin)
	}
}

func TestScheduledPendingRestoreYieldsToFreshSubscribe(t *testing.T) {
	prevGrace := pendingRestoreGrace
	pendingRestoreGrace = 40 * time.Millisecond
	defer func() { pendingRestoreGrace = prevGrace }()

	manager := NewWebSocketManager(nil)
	manager.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC", "ETH", "SOL"}),
		storedAt: time.Now(),
	}
	client := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(client)
	done := manager.schedulePendingMarketSubscription(client)

	// Healthy reconnect POST lands inside the grace window.
	manager.UpdateMarketSubscriptions("client-1", "ETH", "2h", []string{"ETH", "BTC"})
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("scheduled pending restore did not finish")
	}

	manager.MarketSubMu.Lock()
	ethBook := manager.MarketBookRefs["ETH"]
	solBook := manager.MarketBookRefs["SOL"]
	_, pendingLeft := manager.PendingMarketSubs["client-1"]
	manager.MarketSubMu.Unlock()
	client.mu.Lock()
	coin := client.market.Coin
	client.mu.Unlock()

	if ethBook != 1 {
		t.Fatalf("ETH book refs after grace = %d, want 1", ethBook)
	}
	if solBook != 0 {
		t.Fatalf("SOL book refs after grace = %d, want 0 (pending must not re-expand)", solBook)
	}
	if pendingLeft {
		t.Fatal("pending entry should be cleared once live intent exists")
	}
	if coin != "ETH" {
		t.Fatalf("client market coin = %q, want ETH", coin)
	}
}

func TestScheduledPendingRestoreAppliesWhenPostIsLost(t *testing.T) {
	prevGrace := pendingRestoreGrace
	pendingRestoreGrace = 30 * time.Millisecond
	defer func() { pendingRestoreGrace = prevGrace }()

	manager := NewWebSocketManager(nil)
	manager.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC"}),
		storedAt: time.Now(),
	}
	client := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(client)
	done := manager.schedulePendingMarketSubscription(client)
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("scheduled pending restore did not finish")
	}

	manager.MarketSubMu.Lock()
	btcBook := manager.MarketBookRefs["BTC"]
	manager.MarketSubMu.Unlock()
	client.mu.Lock()
	coin := client.market.Coin
	client.mu.Unlock()

	if btcBook != 1 {
		t.Fatalf("BTC book refs after lost-POST grace = %d, want 1", btcBook)
	}
	if coin != "BTC" {
		t.Fatalf("client market coin = %q, want BTC", coin)
	}
}

// atomicSink is a concurrency-safe CandleSink for tests that read its counters
// from a different goroutine than the one delivering messages.
type atomicSink struct {
	applied int64
	down    int64
	up      int64
}

func (s *atomicSink) ApplyWSCandle(map[string]interface{})                         { atomic.AddInt64(&s.applied, 1) }
func (s *atomicSink) AnnotateWSCandle(_ map[string]interface{}, raw []byte) []byte { return raw }
func (s *atomicSink) OnMarketWSDown()                                              { atomic.AddInt64(&s.down, 1) }
func (s *atomicSink) OnMarketWSReconnect()                                         { atomic.AddInt64(&s.up, 1) }
func (s *atomicSink) OnCandleFeedDropped(string, string)                           {}
func (s *atomicSink) appliedCount() int64                                          { return atomic.LoadInt64(&s.applied) }

// Regression: reapplySubscriptions can carry dozens of permanent candle
// subscriptions accumulated over a long session (on-demand-registered series
// are never evicted, see WarmOnDemand). StartMarketWebSocket used to write
// that whole burst before starting to read anything back; verified directly
// against Hyperliquid that writing many subscribes with nobody reading gets
// the connection dropped mid-burst, which then reconnected and repeated the
// same (growing) burst with no backoff — a reconnect storm. This drives a
// large accumulated ref set through a real (loopback) websocket connection and
// asserts every push the fake server sends back gets drained and the
// connection ends up healthy, proving the read pump runs concurrently with —
// not after — the subscribe burst.
func TestStartMarketWebSocketDrainsPushesDuringLargeSubscribeBurst(t *testing.T) {
	upgrader := gorillaws.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			// Mirror Hyperliquid: push a response immediately for every subscribe
			// received, without waiting for the client to read anything back.
			push := map[string]interface{}{
				"channel": "candle",
				"data":    map[string]interface{}{"s": "BTC", "i": "2h"},
			}
			if err := conn.WriteJSON(push); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	manager := NewWebSocketManager(nil)
	manager.WsURL = "ws" + strings.TrimPrefix(server.URL, "http")
	sink := &atomicSink{}
	manager.SetCandleSink(sink)

	// Simulate a long session's worth of accumulated permanent candle refs
	// (each an on-demand-registered off-list coin that is never evicted).
	const permanentRefs = 150
	for i := 0; i < permanentRefs; i++ {
		manager.MarketCandleRefs[candleRefKey(fmt.Sprintf("COIN%d", i), "2h")] = 1
	}

	manager.StartMarketWebSocket()
	defer manager.StopMarketWebSocket()

	// 2 initial allMids subscribes + permanentRefs candle subscribes, each
	// acked with one push by the fake server above.
	want := int64(permanentRefs + 2)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && sink.appliedCount() < want {
		time.Sleep(10 * time.Millisecond)
	}
	if got := sink.appliedCount(); got < want {
		t.Fatalf("expected the read pump to drain %d pushes from the subscribe burst, got %d (stuck read pump / stalled writer?)", want, got)
	}

	manager.MarketWsMu.RLock()
	connected := manager.MarketWsConn != nil
	manager.MarketWsMu.RUnlock()
	if !connected {
		t.Fatal("expected the market websocket to remain connected after a large subscribe burst, not reconnect-loop")
	}
}

// Residual: if re-subscribe POST lands after pendingRestoreGrace, pending already
// applied. Fresh POST must still win; final refs must match live intent (one thrash cycle OK).
func TestLateSubscribeAfterPendingGraceSettlesToLiveIntent(t *testing.T) {
	prevGrace := pendingRestoreGrace
	pendingRestoreGrace = 20 * time.Millisecond
	defer func() { pendingRestoreGrace = prevGrace }()

	manager := NewWebSocketManager(nil)
	manager.PendingMarketSubs["client-1"] = pendingMarketSub{
		state:    buildMarketSubscriptionState("BTC", "1m", []string{"BTC", "SOL"}),
		storedAt: time.Now(),
	}
	client := &streamClient{id: "client-1", kind: marketStream}
	manager.registerStreamClient(client)
	done := manager.schedulePendingMarketSubscription(client)

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("pending restore did not finish")
	}

	manager.MarketSubMu.Lock()
	if manager.MarketBookRefs["BTC"] != 1 || manager.MarketBookRefs["SOL"] != 1 {
		manager.MarketSubMu.Unlock()
		t.Fatalf("precondition: pending should have applied BTC+SOL books, got BTC=%d SOL=%d",
			manager.MarketBookRefs["BTC"], manager.MarketBookRefs["SOL"])
	}
	manager.MarketSubMu.Unlock()

	// Late POST (after grace): different coin + trade set.
	manager.UpdateMarketSubscriptions("client-1", "ETH", "2h", []string{"ETH", "BTC"})

	manager.MarketSubMu.Lock()
	ethBook := manager.MarketBookRefs["ETH"]
	btcBook := manager.MarketBookRefs["BTC"]
	solBook := manager.MarketBookRefs["SOL"]
	manager.MarketSubMu.Unlock()
	client.mu.Lock()
	coin := client.market.Coin
	interval := client.market.Interval
	client.mu.Unlock()

	if coin != "ETH" || interval != "2h" {
		t.Fatalf("live intent coin/interval = %s/%s, want ETH/2h", coin, interval)
	}
	if ethBook != 1 {
		t.Fatalf("ETH book refs = %d, want 1", ethBook)
	}
	if btcBook != 1 {
		t.Fatalf("BTC book refs = %d, want 1 (still in late tradeCoins)", btcBook)
	}
	if solBook != 0 {
		t.Fatalf("SOL book refs = %d, want 0 (must drop after late POST)", solBook)
	}
}
