package websocket

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
)

var liqKnown = map[string]string{"BTC": "BTC", "ETH": "ETH", "kPEPE": "kPEPE"}

func TestParseBybitLiquidations(t *testing.T) {
	env := map[string]interface{}{
		"topic": "allLiquidation.ETHUSDT",
		"data":  []interface{}{map[string]interface{}{"T": float64(1), "s": "ETHUSDT", "S": "Buy", "v": "2", "p": "3000"}},
	}
	out := parseBybitLiquidations(env, liqKnown, 0)
	if len(out) != 1 {
		t.Fatalf("want 1, got %d", len(out))
	}
	got := out[0]
	// Bybit `S:Buy` = a long was liquidated => order side is a forced Sell.
	if got.Coin != "ETH" || got.Side != "Sell" || got.Px != "3000" || got.Sz != "2" || got.Value != 6000 {
		t.Fatalf("unexpected: %+v", got)
	}
}

// Bybit's allLiquidation `S` is the position side; the feed must normalize it to
// the order-side convention used by the QuickNode feed and the renderer.
func TestParseBybitLiquidations_SideNormalization(t *testing.T) {
	mk := func(side string) map[string]interface{} {
		return map[string]interface{}{
			"topic": "allLiquidation.ETHUSDT",
			"data":  []interface{}{map[string]interface{}{"T": float64(1), "s": "ETHUSDT", "S": side, "v": "2", "p": "3000"}},
		}
	}
	if out := parseBybitLiquidations(mk("Buy"), liqKnown, 0); len(out) != 1 || out[0].Side != "Sell" {
		t.Fatalf("liquidated long (S:Buy) should be a forced Sell, got %+v", out)
	}
	if out := parseBybitLiquidations(mk("Sell"), liqKnown, 0); len(out) != 1 || out[0].Side != "Buy" {
		t.Fatalf("liquidated short (S:Sell) should be a forced Buy, got %+v", out)
	}
}

func TestParseBybitLiquidations_FilterAndGate(t *testing.T) {
	mk := func(sym string) map[string]interface{} {
		return map[string]interface{}{
			"topic": "allLiquidation." + sym,
			"data":  []interface{}{map[string]interface{}{"T": float64(1), "s": sym, "S": "Buy", "v": "0.1", "p": "50000"}},
		}
	}
	if out := parseBybitLiquidations(mk("DOGEUSDT"), liqKnown, 0); out != nil {
		t.Fatalf("non-HL coin should be dropped, got %+v", out)
	}
	if out := parseBybitLiquidations(mk("1000PEPEUSDT"), liqKnown, 0); len(out) != 1 || out[0].Coin != "kPEPE" {
		t.Fatalf("1000PEPE should map to kPEPE, got %+v", out)
	}
	if out := parseBybitLiquidations(mk("BTCUSDT"), liqKnown, 6000); out != nil {
		t.Fatalf("value 5000 should be gated by minNotional 6000, got %+v", out)
	}
}

func TestSymbolMapping(t *testing.T) {
	if got := hlCoinFromExternal("BTCUSDT", liqKnown); got != "BTC" {
		t.Fatalf("BTCUSDT -> %q", got)
	}
	if got := hlCoinFromExternal("1000PEPEUSDT", liqKnown); got != "kPEPE" {
		t.Fatalf("1000PEPEUSDT -> %q", got)
	}
	if got := hlCoinFromExternal("DOGEUSDT", liqKnown); got != "" {
		t.Fatalf("DOGEUSDT should be unmapped, got %q", got)
	}
	if got := hlCoinToExternalSymbol("BTC"); got != "BTCUSDT" {
		t.Fatalf("BTC -> %q", got)
	}
	if got := hlCoinToExternalSymbol("kPEPE"); got != "1000PEPEUSDT" {
		t.Fatalf("kPEPE -> %q", got)
	}
	if got := hlCoinToExternalSymbol("NVDA"); got != "NVDAUSDT" {
		t.Fatalf("NVDA -> %q", got)
	}
	// A dex-qualified id is not a normalized base; it has no direct CEX symbol.
	if got := hlCoinToExternalSymbol("xyz:NVDA"); got != "" {
		t.Fatalf("dex-qualified id should have no CEX symbol, got %q", got)
	}
}

// Bybit carries the xyz HIP-3 synthetics (stocks/commodities), so an xyz base
// must map both ways: subscription symbol out, and the `xyz:`-prefixed HL id in.
func TestXyzSymbolMapping(t *testing.T) {
	known := map[string]string{"BTC": "BTC", "NVDA": "xyz:NVDA", "GOLD": "xyz:GOLD"}

	if got := hlCoinFromExternal("NVDAUSDT", known); got != "xyz:NVDA" {
		t.Fatalf("NVDAUSDT -> %q, want xyz:NVDA", got)
	}
	if got := hlCoinFromExternal("GOLDUSDT", known); got != "xyz:GOLD" {
		t.Fatalf("GOLDUSDT -> %q, want xyz:GOLD", got)
	}
	if got := hlCoinFromExternal("BTCUSDT", known); got != "BTC" {
		t.Fatalf("BTCUSDT -> %q, want BTC", got)
	}
	if got := hlCoinFromExternal("DOGEUSDT", known); got != "" {
		t.Fatalf("non-HL DOGEUSDT -> %q, want empty", got)
	}

	// A bybit liquidation on an xyz pair must emit the HL id as its coin.
	env := map[string]interface{}{
		"topic": "allLiquidation.NVDAUSDT",
		"data":  []interface{}{map[string]interface{}{"T": float64(1), "s": "NVDAUSDT", "S": "Sell", "v": "10", "p": "100"}},
	}
	out := parseBybitLiquidations(env, known, 0)
	if len(out) != 1 || out[0].Coin != "xyz:NVDA" {
		t.Fatalf("bybit xyz liquidation -> %+v, want coin xyz:NVDA", out)
	}
}

// Some HL xyz synthetics trade on Bybit under a different ticker (gold=XAU,
// AMD=AMDSTOCK, the S&P/Nasdaq indices via the SPY/QQQ ETFs). The alias must map
// both ways so those liquidations are subscribed and resolved.
func TestXyzCexAliasMapping(t *testing.T) {
	known := map[string]string{
		"GOLD": "xyz:GOLD", "SILVER": "xyz:SILVER", "AMD": "xyz:AMD",
		"NOK": "xyz:NOK", "SP500": "xyz:SP500", "XYZ100": "xyz:XYZ100",
	}
	out := map[string]string{
		"GOLD": "XAUUSDT", "SILVER": "XAGUSDT", "AMD": "AMDSTOCKUSDT",
		"NOK": "NOKIAUSDT", "SP500": "SPYUSDT", "XYZ100": "QQQUSDT",
	}
	for base, sym := range out {
		if got := hlCoinToExternalSymbol(base); got != sym {
			t.Fatalf("subscribe %s -> %q, want %q", base, got, sym)
		}
		if got := hlCoinFromExternal(sym, known); got != known[base] {
			t.Fatalf("resolve %s -> %q, want %q", sym, got, known[base])
		}
	}
	// A non-aliased xyz base still uses the plain <base>USDT path.
	if got := hlCoinToExternalSymbol("NVDA"); got != "NVDAUSDT" {
		t.Fatalf("NVDA -> %q, want NVDAUSDT", got)
	}
}

func TestBybitUniverseFromCanonicalMetadata(t *testing.T) {
	known := bybitUniverseFromCoins([]string{
		"BTC", "kPEPE", "xyz:NVDA", "xyz:GOLD", "vntl:BTC", "",
	})

	want := map[string]string{
		"BTC": "BTC", "kPEPE": "kPEPE", "NVDA": "xyz:NVDA", "GOLD": "xyz:GOLD",
	}
	if len(known) != len(want) {
		t.Fatalf("known = %#v, want %#v", known, want)
	}
	for base, coin := range want {
		if known[base] != coin {
			t.Fatalf("known[%q] = %q, want %q", base, known[base], coin)
		}
	}
	if _, ok := known["vntl:BTC"]; ok {
		t.Fatal("non-xyz builder dex must not be subscribed through Bybit")
	}
}

func TestBybitUniverseFromCanonicalMetadataPrefersNativeCoin(t *testing.T) {
	for _, coins := range [][]string{
		{"BTC", "xyz:BTC"},
		{"xyz:BTC", "BTC"},
	} {
		known := bybitUniverseFromCoins(coins)
		if got := known["BTC"]; got != "BTC" {
			t.Fatalf("bybitUniverseFromCoins(%v)[BTC] = %q, want native BTC", coins, got)
		}
	}
}

func TestBuildBybitTopicsFiltersAndSortsInstrumentIntersection(t *testing.T) {
	known := map[string]string{
		"ZRO": "ZRO", "BTC": "BTC", "NVDA": "xyz:NVDA", "GOLD": "xyz:GOLD",
	}
	valid := map[string]struct{}{"BTCUSDT": {}, "NVDAUSDT": {}, "XAUUSDT": {}}
	got := buildBybitTopics(known, valid)
	want := []string{"allLiquidation.BTCUSDT", "allLiquidation.NVDAUSDT", "allLiquidation.XAUUSDT"}
	if len(got) != len(want) {
		t.Fatalf("topics = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("topics = %#v, want deterministic %#v", got, want)
		}
	}
}

func TestBybitAckTrackerRequiresEveryBatch(t *testing.T) {
	tracker := &bybitAckTracker{
		pending: map[string][]string{
			"one": {"allLiquidation.BTCUSDT"},
			"two": {"allLiquidation.ETHUSDT", "allLiquidation.SOLUSDT"},
		},
		requested: 3,
		batches:   2,
	}
	if handled, err := tracker.observe(map[string]interface{}{"op": "subscribe", "req_id": "one", "success": true}); !handled || err != nil {
		t.Fatalf("first acknowledgement: handled=%t err=%v", handled, err)
	}
	if tracker.complete() {
		t.Fatal("tracker completed before every batch was acknowledged")
	}
	if handled, err := tracker.observe(map[string]interface{}{"op": "subscribe", "req_id": "two", "success": true}); !handled || err != nil {
		t.Fatalf("second acknowledgement: handled=%t err=%v", handled, err)
	}
	if !tracker.complete() || tracker.subscribed != 3 {
		t.Fatalf("tracker = %+v, want complete with three subscribed topics", tracker)
	}
}

func TestBybitAckTrackerRejectsWholeFailedBatch(t *testing.T) {
	tracker := &bybitAckTracker{
		pending:   map[string][]string{"one": {"allLiquidation.BTCUSDT", "allLiquidation.INVALIDUSDT"}},
		requested: 2,
		batches:   1,
	}
	_, err := tracker.observe(map[string]interface{}{
		"op": "subscribe", "req_id": "one", "success": false, "ret_msg": "handler not found",
	})
	if !errors.Is(err, errBybitSubscriptionRejected) {
		t.Fatalf("error = %v, want subscription rejection", err)
	}
	if tracker.rejected != 2 || tracker.complete() {
		t.Fatalf("tracker = %+v, want entire batch rejected", tracker)
	}
}

type liqRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn liqRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestFetchBybitLinearSymbolsPaginatesAndKeepsTradingOnly(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: liqRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		body := `{"retCode":0,"result":{"nextPageCursor":"next","list":[{"symbol":"BTCUSDT","status":"Trading"},{"symbol":"OLDUSDT","status":"Settled"}]}}`
		if calls == 2 {
			if req.URL.Query().Get("cursor") != "next" {
				t.Fatalf("second request cursor = %q", req.URL.Query().Get("cursor"))
			}
			body = `{"retCode":0,"result":{"nextPageCursor":"","list":[{"symbol":"ethusdt","status":"Trading"}]}}`
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewBufferString(body)), Header: make(http.Header)}, nil
	})}
	symbols, err := fetchBybitLinearSymbols(context.Background(), client, "https://api.bybit.test/v5/market/instruments-info?category=linear&limit=1000")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(symbols) != 2 {
		t.Fatalf("calls=%d symbols=%v, want two pages and two trading symbols", calls, symbols)
	}
	if _, ok := symbols["BTCUSDT"]; !ok {
		t.Fatal("BTCUSDT missing")
	}
	if _, ok := symbols["ETHUSDT"]; !ok {
		t.Fatal("ETHUSDT missing or not normalized")
	}
	if _, ok := symbols["OLDUSDT"]; ok {
		t.Fatal("settled instrument must not be subscribed")
	}
}
