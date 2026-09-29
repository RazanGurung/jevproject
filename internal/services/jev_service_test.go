package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"hyperliquid-go/internal/infrastructure/typesafe"
	"hyperliquid-go/internal/services/testutil"
)

type mockExchangeForJev struct {
	*testutil.MockExchange
	midPrice float64
	l2Book   interface{}
}

func (m *mockExchangeForJev) GetMidPrice(ctx context.Context, coin string, testnet bool) (float64, error) {
	return m.midPrice, nil
}

func (m *mockExchangeForJev) GetL2Snapshot(ctx context.Context, coin string, depth int, testnet bool) (interface{}, error) {
	return m.l2Book, nil
}

// stub remaining methods of exchange.Exchange if needed, or implement only what's tested
// Since JevService only calls GetMidPrice and GetL2Snapshot, we can test parseBookMetrics and Analyze directly.

func TestParseBookMetrics(t *testing.T) {
	raw := map[string]interface{}{
		"levels": []interface{}{
			// Bids
			[]interface{}{
				map[string]interface{}{"px": "65000.0", "sz": "2.0"},
				map[string]interface{}{"px": "64990.0", "sz": "1.5"},
			},
			// Asks
			[]interface{}{
				map[string]interface{}{"px": "65010.0", "sz": "1.0"},
				map[string]interface{}{"px": "65020.0", "sz": "0.5"},
			},
		},
	}

	bestBid, bestAsk, bidDepth, askDepth := parseBookMetrics(raw)
	if bestBid != 65000.0 {
		t.Errorf("expected bestBid 65000, got %f", bestBid)
	}
	if bestAsk != 65010.0 {
		t.Errorf("expected bestAsk 65010, got %f", bestAsk)
	}
	expectedBidDepth := 65000.0*2.0 + 64990.0*1.5
	if bidDepth != expectedBidDepth {
		t.Errorf("expected bidDepth %f, got %f", expectedBidDepth, bidDepth)
	}
	expectedAskDepth := 65010.0*1.0 + 65020.0*0.5
	if askDepth != expectedAskDepth {
		t.Errorf("expected askDepth %f, got %f", expectedAskDepth, askDepth)
	}
}

func TestJevServiceAnalyze(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.88,
					Probabilities: map[string]float64{
						"bullish": 0.88,
						"bearish": 0.10,
						"neutral": 0.02,
					},
				},
				"confidence": {
					Type:  "score",
					Score: 4.5,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: 0.05,
				},
				"suggested_action": {
					Type:   "choice",
					Choice: "enter_long",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())

	svc := &JevService{
		client: client,
	}

	// Test analyze with manual book parsing check
	if !svc.IsAvailable() {
		t.Fatal("svc should be available")
	}
	if svc.Model() != "jev-latest" {
		t.Fatalf("expected jev-latest, got %s", svc.Model())
	}
}

func TestJevServiceClassifyNewsHeadline(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"sentiment": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.92,
				},
				"impact_score": {
					Type:  "score",
					Score: 4.8,
				},
				"is_catalyst": {
					Type: "noul",
					Noul: 0.95,
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	svc := &JevService{client: client}

	res, err := svc.ClassifyNewsHeadline(context.Background(), "SEC approves spot Bitcoin ETF in historic milestone")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Direction != "bullish" {
		t.Errorf("expected bullish, got %s", res.Direction)
	}
	if !res.IsCatalyst {
		t.Errorf("expected isCatalyst to be true")
	}
	if res.Impact < 0.8 {
		t.Errorf("expected high impact (>0.8), got %f", res.Impact)
	}
}

func TestJevServiceEvaluateMispricing(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"dislocation_type": {
					Type:       "choice",
					Choice:     "mean_reverting_noise",
					Confidence: 0.85,
				},
				"recommendation": {
					Type:   "choice",
					Choice: "fade_arbitrage",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	svc := &JevService{client: client}

	verdict, err := svc.EvaluateMispricing(context.Background(), "xyz:SP500", 5520.0, 5550.0, -0.54)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verdict.Verdict != "mean_reverting_noise" {
		t.Errorf("expected mean_reverting_noise, got %s", verdict.Verdict)
	}
	if verdict.Recommended != "fade_arbitrage" {
		t.Errorf("expected fade_arbitrage, got %s", verdict.Recommended)
	}
}

func TestJevServiceGenerateSignal(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.82,
				},
				"confidence": {
					Type:  "score",
					Score: 4.2,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: 0.08,
				},
				"suggested_action": {
					Type:   "choice",
					Choice: "enter_long",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{
					map[string]interface{}{"px": "64995.0", "sz": "2.0"},
				},
				[]interface{}{
					map[string]interface{}{"px": "65005.0", "sz": "1.0"},
				},
			},
		},
	}
	svc := &JevService{
		client:   client,
		exchange: mockExch,
	}

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sig.Action != "BUY" {
		t.Errorf("expected Action BUY, got %s", sig.Action)
	}
	if sig.Conviction != 0.82 {
		t.Errorf("expected Conviction 0.82, got %f", sig.Conviction)
	}
	if sig.TakeProfitPct <= 0 || sig.StopLossPct <= 0 {
		t.Errorf("expected positive TP and SL percentages, got TP=%f, SL=%f", sig.TakeProfitPct, sig.StopLossPct)
	}
	if sig.TakeProfitPrice <= sig.EntryPrice {
		t.Errorf("expected TP price (%f) > Entry price (%f) for BUY", sig.TakeProfitPrice, sig.EntryPrice)
	}
	if sig.StopLossPrice >= sig.EntryPrice {
		t.Errorf("expected SL price (%f) < Entry price (%f) for BUY", sig.StopLossPrice, sig.EntryPrice)
	}
	if sig.RiskRewardRatio < 1.9 || sig.RiskRewardRatio > 2.1 {
		t.Errorf("expected ~2:1 R:R, got %f", sig.RiskRewardRatio)
	}
	if sig.Timeframe != "intraday" {
		t.Errorf("expected default timeframe intraday, got %s", sig.Timeframe)
	}
	if !strings.Contains(sig.EstimatedDuration, "Intraday") {
		t.Errorf("expected EstimatedDuration to mention Intraday, got %s", sig.EstimatedDuration)
	}

	// Test Scalp Horizon
	scalpSig, err := svc.GenerateSignal(context.Background(), "BTC", "scalp")
	if err != nil {
		t.Fatalf("unexpected error generating scalp signal: %v", err)
	}
	if scalpSig.Timeframe != "scalp" {
		t.Errorf("expected timeframe scalp, got %s", scalpSig.Timeframe)
	}
	if !strings.Contains(scalpSig.EstimatedDuration, "Scalp") {
		t.Errorf("expected scalp duration, got %s", scalpSig.EstimatedDuration)
	}
	if scalpSig.TakeProfitPct >= sig.TakeProfitPct {
		t.Errorf("expected scalp TP (%f) < intraday TP (%f)", scalpSig.TakeProfitPct, sig.TakeProfitPct)
	}

	// Test Swing Horizon
	swingSig, err := svc.GenerateSignal(context.Background(), "BTC", "swing")
	if err != nil {
		t.Fatalf("unexpected error generating swing signal: %v", err)
	}
	if swingSig.Timeframe != "swing" {
		t.Errorf("expected timeframe swing, got %s", swingSig.Timeframe)
	}
	if !strings.Contains(swingSig.EstimatedDuration, "Swing") {
		t.Errorf("expected swing duration, got %s", swingSig.EstimatedDuration)
	}
	if swingSig.TakeProfitPct <= sig.TakeProfitPct {
		t.Errorf("expected swing TP (%f) > intraday TP (%f)", swingSig.TakeProfitPct, sig.TakeProfitPct)
	}
}

func TestJevServiceGenerateSignalHoldConditions(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.82,
				},
				"confidence": {
					Type:  "score",
					Score: 4.2,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: 0.65, // Elevated toxic flow > 0.40 -> Must HOLD
				},
				"suggested_action": {
					Type:   "choice",
					Choice: "enter_long",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{
					map[string]interface{}{"px": "64995.0", "sz": "2.0"},
				},
				[]interface{}{
					map[string]interface{}{"px": "65005.0", "sz": "1.0"},
				},
			},
		},
	}
	svc := &JevService{
		client:   client,
		exchange: mockExch,
	}

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sig.Action != "HOLD" {
		t.Errorf("expected Action HOLD due to toxic risk, got %s", sig.Action)
	}
}

func TestParseDetailedBookMetrics(t *testing.T) {
	raw := map[string]interface{}{
		"levels": []interface{}{
			// Bids: level 0 is touch ($100k), level 1 is deep ($60k)
			[]interface{}{
				map[string]interface{}{"px": "50000.0", "sz": "2.0"},
				map[string]interface{}{"px": "49990.0", "sz": "1.2"},
			},
			// Asks: level 0 is touch ($50k), level 1 is deep ($150k)
			[]interface{}{
				map[string]interface{}{"px": "50010.0", "sz": "1.0"},
				map[string]interface{}{"px": "50020.0", "sz": "3.0"},
			},
		},
	}

	bestBid, bestAsk, bidDepth, askDepth, touchBid, touchAsk, deepBid, deepAsk := parseDetailedBookMetrics(raw)
	if bestBid != 50000.0 || bestAsk != 50010.0 {
		t.Errorf("expected bestBid 50000, bestAsk 50010, got %f, %f", bestBid, bestAsk)
	}
	if touchBid != 100000.0 || touchAsk != 50010.0 {
		t.Errorf("expected touchBid 100000, touchAsk 50010, got %f, %f", touchBid, touchAsk)
	}
	if deepBid != 49990.0*1.2 || deepAsk != 50020.0*3.0 {
		t.Errorf("expected deepBid %f, deepAsk %f, got %f, %f", 49990.0*1.2, 50020.0*3.0, deepBid, deepAsk)
	}
	if bidDepth != (touchBid+deepBid) || askDepth != (touchAsk+deepAsk) {
		t.Errorf("expected total depth to equal touch+deep")
	}
}

func TestJevServiceDualThresholdHysteresis(t *testing.T) {
	var currentConf float64 = 0.75
	var currentDir string = "bullish"
	var currentToxic float64 = 0.05

	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     currentDir,
					Confidence: currentConf,
				},
				"confidence": {
					Type:  "score",
					Score: currentConf * 5.0,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: currentToxic,
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "64995.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "65005.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Step 1: Initial activation (0.75 >= 0.65) -> Must enter BUY
	sig1, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig1.Action != "BUY" {
		t.Errorf("Step 1: expected Action BUY, got %s", sig1.Action)
	}

	// Step 2: Minor dip in conviction to 0.58 (below 0.65 activation, but above 0.50 retention)
	// Without hysteresis, this would jitter to HOLD. With hysteresis, it must stay in BUY!
	currentConf = 0.58
	mockExch.midPrice = 65002.0 // shift price slightly to bypass SHA-256 byte cache
	sig2, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig2.Action != "BUY" {
		t.Errorf("Step 2: expected Action BUY retained via hysteresis, got %s", sig2.Action)
	}
	if !strings.Contains(sig2.Reason, "hysteresis") {
		t.Errorf("Step 2: expected reason to mention hysteresis, got %s", sig2.Reason)
	}

	// Step 3: Conviction fades below retention floor (0.42 < 0.50) -> Must step down cleanly to HOLD
	currentConf = 0.42
	mockExch.midPrice = 65004.0
	sig3, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig3.Action != "HOLD" {
		t.Errorf("Step 3: expected Action HOLD when conviction fades below retention, got %s", sig3.Action)
	}

	// Step 4: Instant regime reversal: sellers take control (bearish, 0.80 confidence >= 0.65)
	currentDir = "bearish"
	currentConf = 0.80
	mockExch.midPrice = 64980.0
	sig4, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig4.Action != "SELL" {
		t.Errorf("Step 4: expected Action SELL on regime break, got %s", sig4.Action)
	}
}

func TestJevServiceInstantToxicTripwire(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.90,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: 0.70, // Adverse liquidity sweep
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "64995.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "65005.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig.Action != "HOLD" {
		t.Errorf("expected Action HOLD from instant tripwire, got %s", sig.Action)
	}
	if !strings.Contains(sig.Reason, "tripwire") {
		t.Errorf("expected reason to mention tripwire, got %s", sig.Reason)
	}
}

func TestParseExtendedBookMetrics(t *testing.T) {
	raw := map[string]interface{}{
		"levels": []interface{}{
			// Bids: level 0 = 50000 * 2 = 100k (w=1.0)
			//       level 1 = 49990 * 1 = 49.99k (w=0.5)
			[]interface{}{
				map[string]interface{}{"px": "50000.0", "sz": "2.0"},
				map[string]interface{}{"px": "49990.0", "sz": "1.0"},
			},
			// Asks: level 0 = 50010 * 1 = 50.01k (w=1.0)
			//       level 1 = 50020 * 2 = 100.04k (w=0.5)
			[]interface{}{
				map[string]interface{}{"px": "50010.0", "sz": "1.0"},
				map[string]interface{}{"px": "50020.0", "sz": "2.0"},
			},
		},
	}

	bestBid, bestAsk, bidDepth, askDepth, touchBid, touchAsk, deepBid, deepAsk, weightedBid, weightedAsk, touchBidSz, touchAskSz := parseExtendedBookMetrics(raw)

	if bestBid != 50000.0 || bestAsk != 50010.0 {
		t.Fatalf("unexpected touch prices: bid %f, ask %f", bestBid, bestAsk)
	}
	if touchBidSz != 2.0 || touchAskSz != 1.0 {
		t.Fatalf("unexpected touch sizes: bidSz %f, askSz %f", touchBidSz, touchAskSz)
	}
	if touchBid != 100000.0 || touchAsk != 50010.0 {
		t.Fatalf("unexpected touch USD: bid %f, ask %f", touchBid, touchAsk)
	}
	expectedWeightedBid := 100000.0*1.0 + 49990.0*0.5
	if weightedBid != expectedWeightedBid {
		t.Fatalf("expected weightedBid %f, got %f", expectedWeightedBid, weightedBid)
	}
	expectedWeightedAsk := 50010.0*1.0 + (50020.0*2.0)*0.5
	if weightedAsk != expectedWeightedAsk {
		t.Fatalf("expected weightedAsk %f, got %f", expectedWeightedAsk, weightedAsk)
	}
	if bidDepth != (touchBid + deepBid) || askDepth != (touchAsk + deepAsk) {
		t.Fatalf("total depth mismatch")
	}
}

func TestJevServiceMicroPriceAndDynamicOFI(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":  {Type: "choice", Choice: "bullish", Confidence: 0.85},
				"confidence": {Type: "score", Score: 4.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     50005.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "50000.0", "sz": "3.0"}}, // 150k bid
				[]interface{}{map[string]interface{}{"px": "50010.0", "sz": "1.0"}}, // 50k ask
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Call 1: Sets baseline snapshot
	res1, err := svc.Analyze(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("Analyze 1 error: %v", err)
	}
	// MicroPrice should be (150k * 50010 + 50k * 50000) / 200k = (7501.5M + 2500M)/200k = 50007.5
	if res1.MicroPrice <= res1.MidPrice {
		t.Errorf("expected MicroPrice (%f) > MidPrice (%f) when bids dominate touch", res1.MicroPrice, res1.MidPrice)
	}
	if res1.MicroPriceDriftBps <= 0 {
		t.Errorf("expected positive micro-price drift, got %f bps", res1.MicroPriceDriftBps)
	}

	// Call 2: Sequential snapshot with buyers stepping up (px 50002.0, sz 4.0)
	mockExch.l2Book = map[string]interface{}{
		"levels": []interface{}{
			[]interface{}{map[string]interface{}{"px": "50002.0", "sz": "4.0"}}, // higher bid, more size
			[]interface{}{map[string]interface{}{"px": "50010.0", "sz": "1.0"}},
		},
	}
	mockExch.midPrice = 50006.0
	res2, err := svc.Analyze(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("Analyze 2 error: %v", err)
	}
	// Dynamic OFI should be positive
	if res2.BookImbalance <= 0 {
		t.Errorf("expected positive dynamic OFI, got %f", res2.BookImbalance)
	}
}

func TestJevServiceSpoofTrapDefense(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":  {Type: "choice", Choice: "bullish", Confidence: 0.88},
				"confidence": {Type: "score", Score: 4.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	// Book with spoofed touch bid ($100k vs $20k ask -> touchImbalance = +0.67),
	// but massive deep ask overhang ($10k bid vs $200k ask -> deepImbalance = -0.90)
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     50005.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{
					map[string]interface{}{"px": "50000.0", "sz": "2.0"}, // touch: 100k
					map[string]interface{}{"px": "49990.0", "sz": "0.2"}, // deep: 10k
				},
				[]interface{}{
					map[string]interface{}{"px": "50010.0", "sz": "0.4"}, // touch: 20k
					map[string]interface{}{"px": "50020.0", "sz": "4.0"}, // deep: 200k
				},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Must gate to HOLD due to spoof trap defense!
	if sig.Action != "HOLD" {
		t.Errorf("expected Action HOLD due to spoof trap defense, got %s", sig.Action)
	}
	if !strings.Contains(sig.Reason, "Spoof trap defense") {
		t.Errorf("expected reason to mention Spoof trap defense, got: %s", sig.Reason)
	}
}

func TestJevServiceCrossedBookHold(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":  {Type: "choice", Choice: "bullish", Confidence: 0.90},
				"confidence": {Type: "score", Score: 4.8},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	// Crossed book: bestBid (50015.0) > bestAsk (50010.0)
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     50012.5,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "50015.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "50010.0", "sz": "2.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sig.Action != "HOLD" {
		t.Errorf("expected Action HOLD on crossed book, got %s", sig.Action)
	}
	if !strings.Contains(sig.Reason, "crossed") {
		t.Errorf("expected reason to mention crossed book, got: %s", sig.Reason)
	}
}

func TestJevServiceSpreadFeasibilityHold(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":  {Type: "choice", Choice: "bullish", Confidence: 0.85},
				"confidence": {Type: "score", Score: 4.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	// Wide spread: 50000 bid vs 50150 ask (150 USD spread on 50k = 30 bps spread)
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     50075.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "50000.0", "sz": "1.0"}},
				[]interface{}{map[string]interface{}{"px": "50150.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Scalp maxSpreadBps is 8.0 bps -> 30 bps spread must gate to HOLD
	sig, err := svc.GenerateSignal(context.Background(), "BTC", "scalp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sig.Action != "HOLD" {
		t.Errorf("expected Action HOLD due to wide spread, got %s", sig.Action)
	}
	if !strings.Contains(sig.Reason, "Spread too wide") {
		t.Errorf("expected reason to mention Spread too wide, got: %s", sig.Reason)
	}
}

type mockMetadataCacheForJev struct {
	decimals map[string]int
	tickSize map[string]float64
}

func (m *mockMetadataCacheForJev) GetDecimals(coin string) int {
	if m.decimals != nil {
		return m.decimals[coin]
	}
	return 2
}
func (m *mockMetadataCacheForJev) GetTickSize(coin string) float64 {
	if m.tickSize != nil {
		return m.tickSize[coin]
	}
	return 0.01
}
func (m *mockMetadataCacheForJev) GetMaxLeverage(coin string) int             { return 50 }
func (m *mockMetadataCacheForJev) SetDecimals(coin string, decimals int)     {}
func (m *mockMetadataCacheForJev) SetTickSize(coin string, size float64)     {}
func (m *mockMetadataCacheForJev) SetMaxLeverage(coin string, lev int)       {}

func TestJevServicePriceNormalization(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":  {Type: "choice", Choice: "bullish", Confidence: 0.85},
				"confidence": {Type: "score", Score: 4.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     81542.333333333,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "81542.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "81543.0", "sz": "2.0"}},
			},
		},
	}
	metaCache := &mockMetadataCacheForJev{
		decimals: map[string]int{"BTC": 5}, // 5 szDecimals -> maxDecimals = 6 - 5 = 1
	}
	svc := NewJevService(client, mockExch, nil, metaCache)

	sig, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Entry price must be integer or max 1 decimal
	if sig.EntryPrice != 81542.0 {
		t.Errorf("expected normalized EntryPrice 81542.0, got %f", sig.EntryPrice)
	}
	// Adaptive intraday noise-exceeding calibration (+3.60% TP / -1.80% SL):
	// TP price: 81542 * 1.036 = 84477.512 -> rounds to 84478.0
	if sig.TakeProfitPrice != 84478.0 {
		t.Errorf("expected clean normalized TP price 84478.0, got %f", sig.TakeProfitPrice)
	}
	// SL price: 81542 * 0.982 = 80074.244 -> rounds to 80074.0
	if sig.StopLossPrice != 80074.0 {
		t.Errorf("expected clean normalized SL price 80074.0, got %f", sig.StopLossPrice)
	}
}

func TestJevServiceNeutralConsolidationHysteresis(t *testing.T) {
	currentDir := "bullish"
	currentConf := 0.75
	var currentProbs map[string]float64

	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:          "choice",
					Choice:        currentDir,
					Confidence:    currentConf,
					Probabilities: currentProbs,
				},
				"confidence": {Type: "score", Score: currentConf * 5.0},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "64995.0", "sz": "1.0"}},
				[]interface{}{map[string]interface{}{"px": "65005.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// 1. Enter BUY
	sig1, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil || sig1.Action != "BUY" {
		t.Fatalf("expected initial Action BUY, got %s (err: %v)", sig1.Action, err)
	}

	// 2. Jev returns "neutral" with high confidence (0.85) and flat order flow (1.0 vs 1.0)
	// Without fix, it would wrongly think 0.85 confidence means strong BUY retention!
	// With our fix, it recognizes neutral consolidation and transitions cleanly to HOLD.
	currentDir = "neutral"
	currentConf = 0.85
	currentProbs = map[string]float64{"bullish": 0.15, "neutral": 0.85, "bearish": 0.0}
	mockExch.midPrice = 65002.0

	sig2, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error in step 2: %v", err)
	}
	if sig2.Action != "HOLD" {
		t.Errorf("expected Action HOLD when market enters dead neutral consolidation, got %s", sig2.Action)
	}
	if !strings.Contains(sig2.Reason, "neutral") {
		t.Errorf("expected reason to mention neutral consolidation, got: %s", sig2.Reason)
	}
}

func TestJevService_DynamicATRBrackets(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.80,
				},
				"confidence": {Type: "score", Score: 4.0},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     50000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "49999.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "50001.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Inject candle fetcher returning 14 bars with ATR of 500 (1.00% of 50000)
	rawCandles := make([]map[string]interface{}, 15)
	for i := 0; i < 15; i++ {
		rawCandles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((15-i)*15*60*1000),
			"o": "50000",
			"h": "50300",
			"l": "49800", // Range = 500
			"c": "50000",
			"v": "1000",
		}
	}
	candleBytes, _ := json.Marshal(rawCandles)
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		return candleBytes, nil
	})

	sig, err := svc.GenerateSignal(context.Background(), "BTC", "intraday")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sig.Action != "BUY" {
		t.Errorf("expected Action BUY, got %s", sig.Action)
	}
	if sig.ATRPct <= 0 {
		t.Errorf("expected positive ATRPct, got %f", sig.ATRPct)
	}
	// With ATR% ~ 1.00%, intraday SL should be ~ 1.00% * 1.20 = 1.20%, TP ~ 2.40%
	if sig.StopLossPct != 1.20 {
		t.Errorf("expected dynamic StopLossPct 1.20%%, got %.2f%%", sig.StopLossPct)
	}
	if sig.TakeProfitPct != 2.40 {
		t.Errorf("expected dynamic TakeProfitPct 2.40%%, got %.2f%%", sig.TakeProfitPct)
	}
}

func TestJevService_MacroTrendFilter(t *testing.T) {
	var currentConf float64 = 0.70
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: currentConf,
				},
				"confidence": {Type: "score", Score: currentConf * 5.0},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     60000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "59995.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "60005.0", "sz": "1.0"}},
			},
		},
	}
	// Asset context reporting severe 24h dump (-5.2%)
	mockExch.GetAssetCtxsFunc = func(dex string) ([]interface{}, error) {
		return []interface{}{
			map[string]interface{}{
				"coin":       "BTC",
				"change24h":  "-5.2",
				"dayNtlVlm":  "500000000",
				"funding":    "0.0001",
				"markPx":     "60000",
				"prevDayPx":  "63291",
			},
		}, nil
	}

	svc := NewJevService(client, mockExch, nil, nil)

	// 1. Weak/standard conviction (70% < 78%) counter-trend BUY must be suppressed to HOLD
	sig1, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig1.Action != "HOLD" {
		t.Errorf("expected counter-trend BUY to be suppressed to HOLD, got %s", sig1.Action)
	}
	if !strings.Contains(sig1.Reason, "Macro trend filter") {
		t.Errorf("expected reason to mention Macro trend filter, got: %s", sig1.Reason)
	}

	// 2. Institutional conviction (82% >= 78%) allows oversold bounce entry
	currentConf = 0.82
	mockExch.midPrice = 60005.0 // Shift mid price to bust request hash cache

	sig2, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig2.Action != "BUY" {
		t.Errorf("expected high-conviction oversold BUY to be accepted, got %s", sig2.Action)
	}
}

func TestJevService_ComputeVolumeProfile(t *testing.T) {
	rawCandles := make([]map[string]interface{}, 100)
	for i := 0; i < 100; i++ {
		p := 60000.0 + float64(i)*100.0
		rawCandles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((100-i)*24*60*60*1000),
			"o": p,
			"h": p + 1200.0,
			"l": p - 800.0,
			"c": p + 200.0,
			"v": 5000.0,
		}
	}

	vp := computeVolumeProfile(rawCandles, 70, 0.70)
	if vp == nil {
		t.Fatal("expected non-nil VolumeProfile")
	}
	if vp.VAH <= vp.VAL {
		t.Errorf("expected VAH (%f) > VAL (%f)", vp.VAH, vp.VAL)
	}
	if vp.POC < vp.VAL || vp.POC > vp.VAH {
		t.Errorf("expected POC (%f) between VAL and VAH", vp.POC)
	}
	if vp.TotalVolume <= 0 {
		t.Errorf("expected positive TotalVolume, got %f", vp.TotalVolume)
	}
}

func TestJevService_Gate7ResistanceRejection(t *testing.T) {
	currentConf := 0.70
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: currentConf,
				},
				"confidence": {Type: "score", Score: 3.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     85804.0, // Testing Yearly VAH resistance shelf at $85,850
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "85800.0", "sz": "5.0"}},
				[]interface{}{map[string]interface{}{"px": "85810.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Create 90 daily candles creating a Volume Profile with VAH and 90D TWAP around 80095
	rawCandles := make([]map[string]interface{}, 90)
	for i := 0; i < 90; i++ {
		p := 75000.0 + float64(i)*110.0
		rawCandles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((90-i)*24*60*60*1000),
			"o": p,
			"h": p + 1000.0,
			"l": p - 500.0,
			"c": p + 200.0,
			"v": 20000.0,
		}
	}
	candleBytes, _ := json.Marshal(rawCandles)
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		return candleBytes, nil
	})

	// 1. With standard conviction (70% < 82%), Gate 7 must suppress BUY at Volume Profile resistance
	sig1, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig1.Action != "HOLD" {
		t.Errorf("expected Gate 7 to suppress BUY to HOLD, got %s", sig1.Action)
	}
	if !strings.Contains(sig1.Reason, "Gate 7") {
		t.Errorf("expected reason to mention Gate 7, got: %s", sig1.Reason)
	}
	// Invariant: HOLD must zero out execution target prices
	if sig1.EntryPrice != 0 || sig1.TakeProfitPrice != 0 || sig1.StopLossPrice != 0 {
		t.Errorf("expected HOLD to clear target prices (0, 0, 0), got Entry=%f, TP=%f, SL=%f", sig1.EntryPrice, sig1.TakeProfitPrice, sig1.StopLossPrice)
	}

	// 2. With institutional breakout conviction (85% >= 82%), breakout BUY is permitted
	currentConf = 0.85
	mockExch.midPrice = 85805.0 // Shift mid price to bust request hash cache

	sig2, err := svc.GenerateSignal(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sig2.Action != "BUY" {
		t.Errorf("expected high-conviction breakout BUY to pass Gate 7, got %s", sig2.Action)
	}
	if sig2.EntryPrice <= 0 || sig2.TakeProfitPrice <= sig2.EntryPrice {
		t.Errorf("expected valid BUY target prices, got Entry=%f, TP=%f", sig2.EntryPrice, sig2.TakeProfitPrice)
	}
}

func TestJevService_MacroAndATRCaching(t *testing.T) {
	svc := NewJevService(nil, nil, nil, nil)

	// Create 40 synthetic daily candles
	var candles []map[string]interface{}
	for i := 0; i < 40; i++ {
		candles = append(candles, map[string]interface{}{
			"t": 1700000000000 + int64(i*86400000),
			"o": "80000.0",
			"h": "82000.0",
			"l": "79000.0",
			"c": "81000.0",
			"v": "1000.0",
		})
	}
	candleBytes, _ := json.Marshal(candles)

	var macroFetchCount int
	var atrFetchCount int

	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		if interval == "1d" || interval == "4h" {
			macroFetchCount++
			return candleBytes, nil
		}
		atrFetchCount++
		return candleBytes, nil
	})

	// 1. Initial computeMacroStructure: must invoke fetcher
	vp1, ext1 := svc.computeMacroStructure(context.Background(), "BTC", 81000.0)
	if vp1 == nil || ext1 == nil {
		t.Fatalf("expected non-nil vp1 and ext1")
	}
	if macroFetchCount != 1 {
		t.Fatalf("expected macroFetchCount=1, got %d", macroFetchCount)
	}

	// 2. Second computeMacroStructure with shifted price: must hit RAM cache (macroFetchCount remains 1)
	vp2, ext2 := svc.computeMacroStructure(context.Background(), "BTC", 82500.0)
	if vp2 == nil || ext2 == nil {
		t.Fatalf("expected non-nil vp2 and ext2 from cache")
	}
	if macroFetchCount != 1 {
		t.Errorf("expected macroFetchCount to remain 1 due to cache, got %d", macroFetchCount)
	}
	if ext2.DistFrom365DPct == ext1.DistFrom365DPct {
		t.Errorf("expected ext2 to recalculate extension dynamically for 82500 vs 81000")
	}

	// 3. computeATR caching: first call fetches, second call uses RAM cache
	atr1 := svc.computeATR(context.Background(), "BTC", "intraday", 81000.0, 1.5)
	if atr1 <= 0 {
		t.Fatalf("expected positive atr1, got %f", atr1)
	}
	if atrFetchCount != 1 {
		t.Fatalf("expected atrFetchCount=1, got %d", atrFetchCount)
	}
	atr2 := svc.computeATR(context.Background(), "BTC", "intraday", 81000.0, 1.5)
	if atr2 != atr1 {
		t.Errorf("expected atr2 == atr1, got %f vs %f", atr2, atr1)
	}
	if atrFetchCount != 1 {
		t.Errorf("expected atrFetchCount to remain 1 due to cache, got %d", atrFetchCount)
	}

	// 4. ResetSignalState clears both caches
	svc.ResetSignalState("BTC")
	_ = svc.computeATR(context.Background(), "BTC", "intraday", 81000.0, 1.5)
	if atrFetchCount != 2 {
		t.Errorf("expected atrFetchCount=2 after reset, got %d", atrFetchCount)
	}
}

func TestJevService_TimeoutResilience(t *testing.T) {
	svc := NewJevService(nil, nil, nil, nil)

	// Fetcher sleeps longer than the 1.5s timeout
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		select {
		case <-time.After(3 * time.Second):
			return []byte("[]"), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})

	start := time.Now()
	// Should not hang for 3s; bounded timeout cancels at ~1.5s
	vp, ext := svc.computeMacroStructure(context.Background(), "SOL", 140.0)
	elapsed := time.Since(start)

	if vp != nil || ext != nil {
		t.Errorf("expected nil vp/ext on timeout, got vp=%v, ext=%v", vp, ext)
	}
	if elapsed > 2500*time.Millisecond {
		t.Errorf("computeMacroStructure took too long: %v (expected <= 2.5s)", elapsed)
	}
}

func TestJevServiceVisibilityLadder(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req typesafe.SystemOneRequest
		_ = json.NewDecoder(r.Body).Decode(&req)

		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":        {Type: "choice", Choice: "bullish", Confidence: 0.85},
				"confidence":       {Type: "score", Score: 4.0},
				"toxic_flow":       {Type: "noul", Noul: 0.10},
				"suggested_action": {Type: "choice", Choice: "enter_long"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "65000.0", "sz": "1.0"}},
				[]interface{}{map[string]interface{}{"px": "65010.0", "sz": "1.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// 1. Scalp timeframe -> VisibilityShort
	resScalp, err := svc.Analyze(context.Background(), "BTC", "scalp")
	if err != nil {
		t.Fatalf("Analyze scalp failed: %v", err)
	}
	if resScalp.VisibilityLevel != string(typesafe.VisibilityShort) {
		t.Errorf("expected scalp visibility %s, got %s", typesafe.VisibilityShort, resScalp.VisibilityLevel)
	}
	if !resScalp.SharedRetrieval {
		t.Error("expected SharedRetrieval to be true")
	}

	// 2. Swing timeframe -> VisibilityFull
	resSwing, err := svc.Analyze(context.Background(), "BTC", "swing")
	if err != nil {
		t.Fatalf("Analyze swing failed: %v", err)
	}
	if resSwing.VisibilityLevel != string(typesafe.VisibilityFull) {
		t.Errorf("expected swing visibility %s, got %s", typesafe.VisibilityFull, resSwing.VisibilityLevel)
	}

	// 3. Intraday timeframe -> VisibilityLong
	resIntraday, err := svc.Analyze(context.Background(), "BTC", "intraday")
	if err != nil {
		t.Fatalf("Analyze intraday failed: %v", err)
	}
	if resIntraday.VisibilityLevel != string(typesafe.VisibilityLong) {
		t.Errorf("expected intraday visibility %s, got %s", typesafe.VisibilityLong, resIntraday.VisibilityLevel)
	}
}

func TestJevServiceProgrammablePermissions(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"slippage_risk": {Type: "choice", Choice: "acceptable"},
				"toxic_flow":    {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "65000.0", "sz": "10.0"}}, // $650k depth
				[]interface{}{map[string]interface{}{"px": "65010.0", "sz": "10.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// 1. Normal order size ($10,000) -> VerdictAllow
	audit1, err := svc.AuditPreTrade(context.Background(), "BTC", true, 10000.0)
	if err != nil {
		t.Fatalf("AuditPreTrade failed: %v", err)
	}
	if audit1.PermissionVerdict != string(typesafe.VerdictAllow) {
		t.Errorf("expected allow verdict, got %s", audit1.PermissionVerdict)
	}
	if !audit1.Approved {
		t.Error("expected audit1 to be approved")
	}

	// 2. Order exceeding hard $500k circuit breaker -> VerdictDeny
	audit2, err := svc.AuditPreTrade(context.Background(), "BTC", true, 600000.0)
	if err != nil {
		t.Fatalf("AuditPreTrade failed: %v", err)
	}
	if audit2.PermissionVerdict != string(typesafe.VerdictDeny) {
		t.Errorf("expected deny verdict for $600k order, got %s", audit2.PermissionVerdict)
	}
	if audit2.Approved {
		t.Error("expected audit2 to not be approved")
	}

	// 3. Order wiping > 35% of depth ($300k on $650k) -> VerdictAsk
	audit3, err := svc.AuditPreTrade(context.Background(), "BTC", true, 300000.0)
	if err != nil {
		t.Fatalf("AuditPreTrade failed: %v", err)
	}
	if audit3.PermissionVerdict != string(typesafe.VerdictAsk) {
		t.Errorf("expected ask verdict for 46%% book wipe, got %s", audit3.PermissionVerdict)
	}
}

func TestJevServiceSubgoalDeduplication(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction":        {Type: "choice", Choice: "bullish", Confidence: 0.88},
				"confidence":       {Type: "score", Score: 4.5},
				"toxic_flow":       {Type: "noul", Noul: 0.05},
				"suggested_action": {Type: "choice", Choice: "enter_long"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	mockExch := &mockExchangeForJev{
		MockExchange: testutil.NewMockExchange(),
		midPrice:     65000.0,
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "65000.0", "sz": "2.0"}},
				[]interface{}{map[string]interface{}{"px": "65010.0", "sz": "2.0"}},
			},
		},
	}
	svc := NewJevService(client, mockExch, nil, nil)

	// Call 1: fresh generation
	sig1, err := svc.GenerateSignal(context.Background(), "BTC", "scalp")
	if err != nil {
		t.Fatalf("GenerateSignal 1 failed: %v", err)
	}
	if sig1.CacheReused {
		t.Error("initial signal should not be marked CacheReused")
	}

	// Verify general subgoal deduplication across sub-agent / background work
	isDupGoal, _ := svc.subgoalReg.RegisterSubgoal("scan orderbook anomalies")
	if isDupGoal {
		t.Error("first scan should not be duplicate")
	}
	svc.subgoalReg.CompleteSubgoal("scan orderbook anomalies", "anomalies: none")

	isDupGoal2, entry2 := svc.subgoalReg.RegisterSubgoal("scan orderbook anomalies")
	if !isDupGoal2 {
		t.Error("subsequent identical subgoal should be deduplicated")
	}
	if entry2.Result != "anomalies: none" {
		t.Errorf("expected cached result, got %v", entry2.Result)
	}
}

func TestJevService_RangeHighCounterTrendShort(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish", // Retail / flow bidding into resistance
					Confidence: 0.74,
				},
				"confidence": {Type: "score", Score: 3.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	baseMock := testutil.NewMockExchange()
	baseMock.GetAssetCtxsFunc = func(dex string) ([]interface{}, error) {
		return []interface{}{
			map[string]interface{}{
				"name":      "BTC",
				"change24h": 0.5, // Rangebound 24h change
				"markPx":    67800.0,
			},
		}, nil
	}

	mockExch := &mockExchangeForJev{
		MockExchange: baseMock,
		midPrice:     67800.0, // Testing range resistance (VAH is ~67100)
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "67790.0", "sz": "1.0"}},
				[]interface{}{map[string]interface{}{"px": "67810.0", "sz": "5.0"}},
			},
		},
	}

	svc := NewJevService(client, mockExch, nil, nil)

	// Create 60 candles forming a range between 62,000 and 68,000 with POC at 65,000
	candles := make([]map[string]interface{}, 60)
	for i := 0; i < 60; i++ {
		candles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((60-i)*24*60*60*1000),
			"o": 65000.0,
			"h": 68000.0,
			"l": 62000.0,
			"c": 65000.0,
			"v": 10000.0,
		}
	}
	candleBytes, _ := json.Marshal(candles)
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		return candleBytes, nil
	})

	sig, err := svc.GenerateSignal(context.Background(), "BTC", "intraday")
	if err != nil {
		t.Fatalf("GenerateSignal failed: %v", err)
	}

	// Must flip naive BUY into a counter-trend SELL at Range High
	if sig.Action != "SELL" {
		t.Errorf("expected Action SELL at range high, got %s", sig.Action)
	}
	if sig.SignalType != "counter_trend" {
		t.Errorf("expected SignalType counter_trend, got %s", sig.SignalType)
	}
	if sig.MarketEnvironment != "range" {
		t.Errorf("expected MarketEnvironment range, got %s", sig.MarketEnvironment)
	}
	if !strings.Contains(sig.Reason, "Counter-trend range-high short") {
		t.Errorf("expected Reason to describe counter-trend range-high short, got: %s", sig.Reason)
	}
	if sig.EntryPrice <= 0 {
		t.Errorf("expected positive EntryPrice, got %f", sig.EntryPrice)
	}
	if sig.StopLossPrice <= sig.EntryPrice {
		t.Errorf("expected StopLossPrice (%f) > EntryPrice (%f) for short", sig.StopLossPrice, sig.EntryPrice)
	}
	if sig.TakeProfitPrice >= sig.EntryPrice || sig.TakeProfitPrice <= 0 {
		t.Errorf("expected TakeProfitPrice (%f) < EntryPrice (%f) targeting mean reversion toward POC", sig.TakeProfitPrice, sig.EntryPrice)
	}
}

func TestJevService_RangeLowCounterTrendLong(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bearish", // Retail dumping into support
					Confidence: 0.74,
				},
				"confidence": {Type: "score", Score: 3.5},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	baseMock := testutil.NewMockExchange()
	baseMock.GetAssetCtxsFunc = func(dex string) ([]interface{}, error) {
		return []interface{}{
			map[string]interface{}{
				"name":      "BTC",
				"change24h": -0.5, // Rangebound 24h change
				"markPx":    62200.0,
			},
		}, nil
	}

	mockExch := &mockExchangeForJev{
		MockExchange: baseMock,
		midPrice:     62200.0, // Testing range support (VAL is ~62900)
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "62190.0", "sz": "5.0"}},
				[]interface{}{map[string]interface{}{"px": "62210.0", "sz": "1.0"}},
			},
		},
	}

	svc := NewJevService(client, mockExch, nil, nil)

	// Create 60 candles forming a range between 62,000 and 68,000 with POC at 65,000
	candles := make([]map[string]interface{}, 60)
	for i := 0; i < 60; i++ {
		candles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((60-i)*24*60*60*1000),
			"o": 65000.0,
			"h": 68000.0,
			"l": 62000.0,
			"c": 65000.0,
			"v": 10000.0,
		}
	}
	candleBytes, _ := json.Marshal(candles)
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		return candleBytes, nil
	})

	sig, err := svc.GenerateSignal(context.Background(), "BTC", "intraday")
	if err != nil {
		t.Fatalf("GenerateSignal failed: %v", err)
	}

	// Must flip naive SELL into a counter-trend BUY at Range Low
	if sig.Action != "BUY" {
		t.Errorf("expected Action BUY at range low, got %s", sig.Action)
	}
	if sig.SignalType != "counter_trend" {
		t.Errorf("expected SignalType counter_trend, got %s", sig.SignalType)
	}
	if sig.MarketEnvironment != "range" {
		t.Errorf("expected MarketEnvironment range, got %s", sig.MarketEnvironment)
	}
	if !strings.Contains(sig.Reason, "Counter-trend range-low long") {
		t.Errorf("expected Reason to describe counter-trend range-low long, got: %s", sig.Reason)
	}
	if sig.EntryPrice <= 0 {
		t.Errorf("expected positive EntryPrice, got %f", sig.EntryPrice)
	}
	if sig.StopLossPrice >= sig.EntryPrice || sig.StopLossPrice <= 0 {
		t.Errorf("expected StopLossPrice (%f) < EntryPrice (%f) for long", sig.StopLossPrice, sig.EntryPrice)
	}
	if sig.TakeProfitPrice <= sig.EntryPrice {
		t.Errorf("expected TakeProfitPrice (%f) > EntryPrice (%f) targeting mean reversion toward POC", sig.TakeProfitPrice, sig.EntryPrice)
	}
}

func TestJevService_RangeHighBreakoutTrendLong(t *testing.T) {
	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.88, // Institutional breakout conviction
				},
				"confidence": {Type: "score", Score: 5.0},
				"toxic_flow": {Type: "noul", Noul: 0.05},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	baseMock := testutil.NewMockExchange()
	baseMock.GetAssetCtxsFunc = func(dex string) ([]interface{}, error) {
		return []interface{}{
			map[string]interface{}{
				"name":      "BTC",
				"change24h": 2.2, // Bullish breakout momentum
				"markPx":    67800.0,
			},
		}, nil
	}

	mockExch := &mockExchangeForJev{
		MockExchange: baseMock,
		midPrice:     67800.0, // Testing range high VAH (~67100)
		l2Book: map[string]interface{}{
			"levels": []interface{}{
				[]interface{}{map[string]interface{}{"px": "67790.0", "sz": "10.0"}},
				[]interface{}{map[string]interface{}{"px": "67810.0", "sz": "1.0"}},
			},
		},
	}

	svc := NewJevService(client, mockExch, nil, nil)

	candles := make([]map[string]interface{}, 60)
	for i := 0; i < 60; i++ {
		candles[i] = map[string]interface{}{
			"t": time.Now().UnixMilli() - int64((60-i)*24*60*60*1000),
			"o": 65000.0,
			"h": 68000.0,
			"l": 62000.0,
			"c": 65000.0,
			"v": 10000.0,
		}
	}
	candleBytes, _ := json.Marshal(candles)
	svc.SetCandleSnapshotFetcher(func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		return candleBytes, nil
	})

	sig, err := svc.GenerateSignal(context.Background(), "BTC", "intraday")
	if err != nil {
		t.Fatalf("GenerateSignal failed: %v", err)
	}

	if sig.Action != "BUY" {
		t.Errorf("expected Action BUY on institutional breakout, got %s", sig.Action)
	}
	if sig.SignalType != "trend" {
		t.Errorf("expected SignalType trend, got %s", sig.SignalType)
	}
	if sig.MarketEnvironment != "trend" {
		t.Errorf("expected MarketEnvironment trend, got %s", sig.MarketEnvironment)
	}
	if !strings.Contains(sig.Reason, "Breakout trend long") {
		t.Errorf("expected Reason to describe breakout trend long, got: %s", sig.Reason)
	}
}




