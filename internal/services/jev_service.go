package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/internal/infrastructure/typesafe"
	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

// JevAnalysisResult contains the real-time market metrics and Jev's structured decisions.
type JevAnalysisResult struct {
	Coin                   string             `json:"coin"`
	MidPrice               float64            `json:"midPrice"`
	BestBid                float64            `json:"bestBid"`
	BestAsk                float64            `json:"bestAsk"`
	Spread                 float64            `json:"spread"`
	SpreadBps              float64            `json:"spreadBps"`
	BookImbalance          float64            `json:"bookImbalance"` // -1.0 (all ask) to +1.0 (all bid)
	WeightedBookImbalance  float64            `json:"weightedBookImbalance"`
	TouchImbalance         float64            `json:"touchImbalance"`
	DeepImbalance          float64            `json:"deepImbalance"`
	MicroPrice             float64            `json:"microPrice"`
	MicroPriceDriftBps     float64            `json:"microPriceDriftBps"`
	BidDepthUSD            float64            `json:"bidDepthUsd"`
	AskDepthUSD            float64            `json:"askDepthUsd"`
	Direction              string             `json:"direction"` // "bullish", "bearish", "neutral"
	DirectionConfidence    float64            `json:"directionConfidence"`
	DirectionProbabilities map[string]float64 `json:"directionProbabilities"`
	ConfidenceScore        float64            `json:"confidenceScore"` // 1.0 to 5.0
	ToxicFlowRisk          float64            `json:"toxicFlowRisk"`   // 0.0 to 1.0 probability
	SuggestedAction        string             `json:"suggestedAction"` // "enter_long", "enter_short", "wait_range", "pull_quotes"
	SuggestedLimitPrice    float64            `json:"suggestedLimitPrice"`
	Timestamp              int64              `json:"timestamp"`
	Model                  string             `json:"model"`
	Change24h              float64            `json:"change24h,omitempty"`
	DayVolume              float64            `json:"dayVolume,omitempty"`
	FundingRate            float64            `json:"fundingRate,omitempty"`
	ATRPct                 float64            `json:"atrPct,omitempty"`
	MacroTrend             string             `json:"macroTrend,omitempty"`
	VisibilityLevel        string             `json:"visibilityLevel,omitempty"`
	SharedRetrieval        bool               `json:"sharedRetrieval,omitempty"`
}

type bookSnapshot struct {
	bestBid float64
	bestAsk float64
	bidSz   float64
	askSz   float64
	ts      time.Time
}

type macroCandleStats struct {
	twap          float64
	avgImpulsePct float64
	candleMinL7   float64
	candleMaxH7   float64
	hDays         int
	hType         string
}

type macroCacheEntry struct {
	monthlyVP      *VolumeProfile
	quarterlyVP    *VolumeProfile
	monthlyExt     *MacroExtension
	quarterlyExt   *MacroExtension
	monthlyStats   *macroCandleStats
	quarterlyStats *macroCandleStats
	candles        []map[string]interface{}
	expiresAt      time.Time
}

type atrCacheEntry struct {
	atr       float64
	expiresAt time.Time
}

// JevService integrates TypeSafe AI's Jev model with Hyperliquid real-time market data.
type JevService struct {
	client        *typesafe.Client
	exchange      exchange.Exchange
	priceCache    cache.PriceCache
	metadataCache cache.CoinMetadataCache

	stateMu               sync.RWMutex
	lastSignals           map[string]*TradeSignal
	toxicCooldowns        map[string]time.Time
	lastSnapshots         map[string]*bookSnapshot
	macroCache            map[string]macroCacheEntry
	atrCache              map[string]atrCacheEntry
	subgoalReg            *typesafe.SubgoalRegistry
	sharedRetrievalCache  *typesafe.SharedRetrievalCache
	candleSnapshotFetcher func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error)
}

func NewJevService(client *typesafe.Client, exch exchange.Exchange, priceCache cache.PriceCache, metadataCache cache.CoinMetadataCache) *JevService {
	return &JevService{
		client:               client,
		exchange:             exch,
		priceCache:           priceCache,
		metadataCache:        metadataCache,
		lastSignals:          make(map[string]*TradeSignal),
		toxicCooldowns:       make(map[string]time.Time),
		lastSnapshots:        make(map[string]*bookSnapshot),
		macroCache:           make(map[string]macroCacheEntry),
		atrCache:             make(map[string]atrCacheEntry),
		subgoalReg:           typesafe.NewSubgoalRegistry(),
		sharedRetrievalCache: typesafe.NewSharedRetrievalCache(500 * time.Millisecond),
	}
}

// SetCandleSnapshotFetcher injects the server's candle snapshot fetcher for dynamic volatility & ATR calculations.
func (s *JevService) SetCandleSnapshotFetcher(fetcher func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error)) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.candleSnapshotFetcher = fetcher
}

// ResetSignalState clears cached trade signals and cooldown timers (for testing or resets).
func (s *JevService) ResetSignalState(coin ...string) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if len(coin) == 0 {
		s.lastSignals = make(map[string]*TradeSignal)
		s.toxicCooldowns = make(map[string]time.Time)
		s.lastSnapshots = make(map[string]*bookSnapshot)
		s.macroCache = make(map[string]macroCacheEntry)
		s.atrCache = make(map[string]atrCacheEntry)
		s.sharedRetrievalCache = typesafe.NewSharedRetrievalCache(500 * time.Millisecond)
		s.subgoalReg = typesafe.NewSubgoalRegistry()
		return
	}
	c := strings.ToUpper(strings.TrimSpace(coin[0]))
	for k := range s.lastSignals {
		if strings.HasPrefix(k, c+":") {
			delete(s.lastSignals, k)
		}
	}
	for k := range s.toxicCooldowns {
		if strings.HasPrefix(k, c+":") {
			delete(s.toxicCooldowns, k)
		}
	}
	delete(s.lastSnapshots, c)
	delete(s.macroCache, c)
	for k := range s.atrCache {
		if strings.HasPrefix(k, c+":") {
			delete(s.atrCache, k)
		}
	}
}

// IsAvailable reports whether Jev is configured with an API key.
func (s *JevService) IsAvailable() bool {
	return s.client != nil && s.client.IsAvailable()
}

// Model returns the configured Jev model name.
func (s *JevService) Model() string {
	if s.client == nil {
		return ""
	}
	return s.client.Model()
}

// Analyze extracts order book depth and metrics for coin, then requests structured decisions from Jev.
// Accepts optional timeframe horizon ("scalp", "intraday", "swing") to calibrate prompt instructions.
func (s *JevService) Analyze(ctx context.Context, coin string, tfOpt ...string) (*JevAnalysisResult, error) {
	coin = strings.TrimSpace(coin)
	if coin == "" {
		return nil, fmt.Errorf("coin is required")
	}
	if !s.IsAvailable() {
		return nil, fmt.Errorf("typesafe jev service is not available")
	}

	tf := "intraday"
	if len(tfOpt) > 0 && strings.TrimSpace(tfOpt[0]) != "" {
		tf = strings.ToLower(strings.TrimSpace(tfOpt[0]))
	}

	// 1. Fetch L2 Book Snapshot with spatial depth separation (Level 0 touch vs Levels 1-9 deep)
	var bestBid, bestAsk, bidDepthUSD, askDepthUSD float64
	var touchBidUSD, touchAskUSD, deepBidUSD, deepAskUSD float64
	var weightedBidUSD, weightedAskUSD, touchBidSz, touchAskSz float64
	if s.exchange != nil {
		rawBook, err := s.exchange.GetL2Snapshot(ctx, coin, 10, false)
		if err == nil && rawBook != nil {
			bestBid, bestAsk, bidDepthUSD, askDepthUSD, touchBidUSD, touchAskUSD, deepBidUSD, deepAskUSD, weightedBidUSD, weightedAskUSD, touchBidSz, touchAskSz = parseExtendedBookMetrics(rawBook)
		}
	}

	// 2. Resolve live mid price
	midPrice := 0.0
	if s.priceCache != nil {
		if entry, ok := s.priceCache.Get(coin); ok {
			if entry.Buy > 0 && entry.Sell > 0 {
				midPrice = (entry.Buy + entry.Sell) / 2.0
			} else if entry.Buy > 0 {
				midPrice = entry.Buy
			} else if entry.Sell > 0 {
				midPrice = entry.Sell
			}
		}
	}
	if midPrice <= 0 && s.exchange != nil {
		price, err := s.exchange.GetMidPrice(ctx, coin, false)
		if err == nil && price > 0 {
			midPrice = price
		}
	}
	if midPrice <= 0 && bestBid > 0 && bestAsk > 0 {
		midPrice = (bestBid + bestAsk) / 2.0
	}
	if midPrice <= 0 {
		return nil, fmt.Errorf("could not resolve market price for %s", coin)
	}

	spread := 0.0
	spreadBps := 0.0
	if bestBid > 0 && bestAsk > 0 {
		if bestAsk >= bestBid {
			spread = bestAsk - bestBid
			if midPrice > 0 {
				spreadBps = (spread / midPrice) * 10000.0
			}
		} else {
			// Crossed / inverted book
			spread = bestAsk - bestBid
			spreadBps = -1.0
		}
	}

	totalDepth := bidDepthUSD + askDepthUSD
	bookImbalance := 0.0
	if totalDepth > 0 {
		bookImbalance = (bidDepthUSD - askDepthUSD) / totalDepth
	}

	weightedTotal := weightedBidUSD + weightedAskUSD
	weightedBookImbalance := 0.0
	if weightedTotal > 0 {
		weightedBookImbalance = (weightedBidUSD - weightedAskUSD) / weightedTotal
	}

	touchTotal := touchBidUSD + touchAskUSD
	touchImbalance := 0.0
	if touchTotal > 0 {
		touchImbalance = (touchBidUSD - touchAskUSD) / touchTotal
	}

	deepTotal := deepBidUSD + deepAskUSD
	deepImbalance := 0.0
	if deepTotal > 0 {
		deepImbalance = (deepBidUSD - deepAskUSD) / deepTotal
	}

	// Micro-Price: volume-weighted touch price reflecting immediate queue pressure
	microPrice := midPrice
	microPriceDriftBps := 0.0
	if touchTotal > 0 && bestBid > 0 && bestAsk > 0 {
		microPrice = (touchBidUSD*bestAsk + touchAskUSD*bestBid) / touchTotal
		if midPrice > 0 {
			microPriceDriftBps = ((microPrice - midPrice) / midPrice) * 10000.0
		}
	}

	// Sequential snapshot tracking for dynamic Order Flow Imbalance (OFI)
	s.stateMu.Lock()
	if s.lastSnapshots == nil {
		s.lastSnapshots = make(map[string]*bookSnapshot)
	}
	prevSnap := s.lastSnapshots[coin]
	s.lastSnapshots[coin] = &bookSnapshot{
		bestBid: bestBid,
		bestAsk: bestAsk,
		bidSz:   touchBidSz,
		askSz:   touchAskSz,
		ts:      time.Now(),
	}
	s.stateMu.Unlock()

	ofi := weightedBookImbalance
	if prevSnap != nil && time.Since(prevSnap.ts) <= 15*time.Second && prevSnap.bestBid > 0 && prevSnap.bestAsk > 0 {
		var deltaBid float64
		if bestBid > prevSnap.bestBid {
			deltaBid = touchBidSz
		} else if bestBid == prevSnap.bestBid {
			deltaBid = touchBidSz - prevSnap.bidSz
		} else {
			deltaBid = -prevSnap.bidSz
		}

		var deltaAsk float64
		if bestAsk < prevSnap.bestAsk {
			deltaAsk = touchAskSz
		} else if bestAsk == prevSnap.bestAsk {
			deltaAsk = touchAskSz - prevSnap.askSz
		} else {
			deltaAsk = -prevSnap.askSz
		}

		rawOFI := deltaBid - deltaAsk
		normBase := touchBidSz + touchAskSz
		if normBase > 0 {
			normalizedOFI := rawOFI / normBase
			if normalizedOFI > 1.0 {
				normalizedOFI = 1.0
			} else if normalizedOFI < -1.0 {
				normalizedOFI = -1.0
			}
			ofi = 0.70*normalizedOFI + 0.30*weightedBookImbalance
		}
	}

	structureNote := "Structure: Balanced Depth"
	if touchTotal > 0 && deepTotal > 0 {
		if (touchImbalance > 0.25 && deepImbalance < -0.15) || (touchImbalance < -0.25 && deepImbalance > 0.15) {
			structureNote = "Structure: WARNING - Touch/Deep Divergence (Thin Touch vs Opposing Overhang)"
		} else if (touchImbalance > 0.20 && deepImbalance > 0.20) || (touchImbalance < -0.20 && deepImbalance < -0.20) {
			structureNote = "Structure: Solid Multi-Level Depth Confluence"
		}
	}

	// 3. Format state for Jev System One with macro context, volatility, and spatial depth metrics
	change24h, dayVol, fundingRate, _, _ := s.getAssetContext(ctx, coin)
	atrPct := s.computeATR(ctx, coin, tf, midPrice, change24h)
	macroTrend := "neutral"
	if change24h >= 2.0 {
		macroTrend = "bullish"
	} else if change24h <= -2.0 {
		macroTrend = "bearish"
	}

	visLevel := typesafe.VisibilityLong
	switch tf {
	case "scalp":
		visLevel = typesafe.VisibilityShort
	case "swing":
		visLevel = typesafe.VisibilityFull
	default:
		visLevel = typesafe.VisibilityLong
	}

	var stateStr string
	switch visLevel {
	case typesafe.VisibilityShort:
		stateStr = fmt.Sprintf(
			"[VISIBILITY: SHORT / SCALP HORIZON] Coin: %s | MidPrice: %.4f | BestBid: %.4f | BestAsk: %.4f | Spread: %.4f (%.2f bps) | Touch: Bid $%.0f / Ask $%.0f | TouchImbalance: %+.2f | MicroPriceDrift: %+.1f bps | OrderFlowImbalance: %+.3f | ATR: %.2f%% | %s",
			coin, midPrice, bestBid, bestAsk, spread, spreadBps, touchBidUSD, touchAskUSD, touchImbalance, microPriceDriftBps, ofi, atrPct, structureNote,
		)
	case typesafe.VisibilityFull:
		stateStr = fmt.Sprintf(
			"[VISIBILITY: FULL / SWING HORIZON] Coin: %s | MidPrice: %.4f | BestBid: %.4f | BestAsk: %.4f | Spread: %.4f (%.2f bps) | 24hChange: %+.2f%% | 24hVol: $%.0fM | Funding: %+.4f%% | ATR: %.2f%% | MacroTrend: %s | Top10 BidDepth: $%.0f | Top10 AskDepth: $%.0f | RawImbalance: %+.3f | OrderFlowImbalance: %+.3f | WeightedImbalance: %+.3f | TouchImbalance: %+.2f | DeepImbalance: %+.2f | MicroPriceDrift: %+.1f bps | %s",
			coin, midPrice, bestBid, bestAsk, spread, spreadBps, change24h, dayVol/1000000.0, fundingRate, atrPct, strings.ToUpper(macroTrend), bidDepthUSD, askDepthUSD, bookImbalance, ofi, weightedBookImbalance, touchImbalance, deepImbalance, microPriceDriftBps, structureNote,
		)
	default:
		stateStr = fmt.Sprintf(
			"[VISIBILITY: LONG / INTRADAY HORIZON] Coin: %s | MidPrice: %.4f | BestBid: %.4f | BestAsk: %.4f | Spread: %.4f (%.2f bps) | 24hChange: %+.2f%% | 24hVol: $%.0fM | Funding: %+.4f%% | ATR: %.2f%% | MacroTrend: %s | Top10 BidDepth: $%.0f | Top10 AskDepth: $%.0f | RawImbalance: %+.3f | OrderFlowImbalance: %+.3f | WeightedImbalance: %+.3f | TouchImbalance: %+.2f | DeepImbalance: %+.2f | MicroPriceDrift: %+.1f bps | %s",
			coin, midPrice, bestBid, bestAsk, spread, spreadBps, change24h, dayVol/1000000.0, fundingRate, atrPct, strings.ToUpper(macroTrend), bidDepthUSD, askDepthUSD, bookImbalance, ofi, weightedBookImbalance, touchImbalance, deepImbalance, microPriceDriftBps, structureNote,
		)
	}

	directionInstructions := "Evaluate cumulative orderbook depth asymmetry and session momentum to determine price direction over the next 2-8 hours."
	switch tf {
	case "scalp":
		directionInstructions = "Evaluate immediate touch depth, queue priority, and short-term micro-tape flow over the next 5-15 minutes."
	case "swing":
		directionInstructions = "Evaluate multi-day structural orderbook support, macro supply/demand walls, and accumulation vs distribution over 1-5 days."
	}

	questions := map[string]typesafe.QuestionSpec{
		"direction": {
			Type:         "choice",
			Instructions: directionInstructions,
			Criteria: map[string]string{
				"bullish": "Bid depth outbids asks with deep structural support, spread tight, net upward pressure.",
				"bearish": "Ask depth overhangs bids with deep structural resistance, aggressive selling, net downward pressure.",
				"neutral": "Balanced two-sided liquidity or rangebound consolidation.",
			},
		},
		"confidence": {
			Type:         "score",
			Instructions: "Rate signal clarity and order flow conviction from 1 to 5.",
			Criteria: []string{
				"1: Extremely low confidence, conflicted depth or thin book",
				"2: Weak directional tilt",
				"3: Moderate order flow imbalance",
				"4: Strong multi-level depth asymmetry",
				"5: High conviction one-sided institutional liquidity wall",
			},
		},
		"toxic_flow": {
			Type:         "noul",
			Instructions: "Is there high risk of adverse toxic flow or sharp cascade against a market maker quoting at the touch?",
		},
		"suggested_action": {
			Type:         "choice",
			Instructions: "What is the optimal execution tactic given current book structure?",
			Criteria: map[string]string{
				"enter_long":   "Place buy order inside or at touch to capture upside.",
				"enter_short":  "Place sell order inside or at touch to capture downside.",
				"wait_range":   "Wait for spread contraction or clear directional breakout.",
				"pull_quotes":  "High volatility or adverse selection risk; stay flat.",
			},
		},
	}

	jevResp, err := s.client.Decide(ctx, stateStr, questions)
	if err != nil {
		return nil, fmt.Errorf("jev decision failed: %w", err)
	}

	// 4. Map Jev answers to result
	direction := "neutral"
	dirConf := 0.0
	dirProbs := make(map[string]float64)
	if ans, ok := jevResp.Answers["direction"]; ok {
		direction = ans.Choice
		dirConf = ans.Confidence
		dirProbs = ans.Probabilities
	}

	confScore := 3.0
	if ans, ok := jevResp.Answers["confidence"]; ok {
		confScore = ans.Score
	}

	toxicRisk := 0.0
	if ans, ok := jevResp.Answers["toxic_flow"]; ok {
		toxicRisk = ans.Noul
	}

	suggestedAction := "wait_range"
	if ans, ok := jevResp.Answers["suggested_action"]; ok && ans.Choice != "" {
		suggestedAction = ans.Choice
	}

	suggestedLimitPrice := midPrice
	if direction == "bullish" && bestBid > 0 {
		suggestedLimitPrice = bestBid
	} else if direction == "bearish" && bestAsk > 0 {
		suggestedLimitPrice = bestAsk
	}

	return &JevAnalysisResult{
		Coin:                   coin,
		MidPrice:               midPrice,
		BestBid:                bestBid,
		BestAsk:                bestAsk,
		Spread:                 spread,
		SpreadBps:              spreadBps,
		BookImbalance:          ofi,
		WeightedBookImbalance:  weightedBookImbalance,
		TouchImbalance:         touchImbalance,
		DeepImbalance:          deepImbalance,
		MicroPrice:             microPrice,
		MicroPriceDriftBps:     microPriceDriftBps,
		BidDepthUSD:            bidDepthUSD,
		AskDepthUSD:            askDepthUSD,
		Direction:              direction,
		DirectionConfidence:    dirConf,
		DirectionProbabilities: dirProbs,
		ConfidenceScore:        confScore,
		ToxicFlowRisk:          toxicRisk,
		SuggestedAction:        suggestedAction,
		SuggestedLimitPrice:    suggestedLimitPrice,
		Timestamp:              time.Now().UTC().UnixMilli(),
		Model:                  jevResp.Model,
		Change24h:              change24h,
		DayVolume:              dayVol,
		FundingRate:            fundingRate,
		ATRPct:                 atrPct,
		MacroTrend:             macroTrend,
		VisibilityLevel:        string(visLevel),
		SharedRetrieval:        true,
	}, nil
}

// normalizePrice quantizes limit, TP, and SL prices according to Hyperliquid significant figure and decimal rules.
func (s *JevService) normalizePrice(coin string, price float64) float64 {
	if price <= 0 {
		return price
	}
	szDecimals := 2
	if s.metadataCache != nil {
		if dec := s.metadataCache.GetDecimals(coin); dec > 0 {
			szDecimals = dec
		}
	}
	maxDecimals := 6 - szDecimals
	if maxDecimals < 0 {
		maxDecimals = 0
	}
	if price == math.Trunc(price) {
		return price
	}
	sigDecimals := 4 - int(math.Floor(math.Log10(math.Abs(price))))
	if sigDecimals < 0 {
		sigDecimals = 0
	}
	decimals := maxDecimals
	if sigDecimals < decimals {
		decimals = sigDecimals
	}
	scale := math.Pow10(decimals)
	return math.Round(price*scale) / scale
}

// parseBookMetrics calculates best bid/ask and top-level depth from Hyperliquid l2Book.
func parseBookMetrics(raw interface{}) (bestBid, bestAsk, bidDepthUSD, askDepthUSD float64) {
	bestBid, bestAsk, bidDepthUSD, askDepthUSD, _, _, _, _ = parseDetailedBookMetrics(raw)
	return
}

// parseDetailedBookMetrics calculates best bid/ask, total depth, and separates Level 0 (touch) from Levels 1-9 (deep).
func parseDetailedBookMetrics(raw interface{}) (bestBid, bestAsk, bidDepthUSD, askDepthUSD, touchBidUSD, touchAskUSD, deepBidUSD, deepAskUSD float64) {
	bestBid, bestAsk, bidDepthUSD, askDepthUSD, touchBidUSD, touchAskUSD, deepBidUSD, deepAskUSD, _, _, _, _ = parseExtendedBookMetrics(raw)
	return
}

// parseExtendedBookMetrics calculates best bid/ask, total depth, touch vs deep, level-weighted depth, and touch sizes.
func parseExtendedBookMetrics(raw interface{}) (bestBid, bestAsk, bidDepthUSD, askDepthUSD, touchBidUSD, touchAskUSD, deepBidUSD, deepAskUSD, weightedBidUSD, weightedAskUSD, touchBidSz, touchAskSz float64) {
	bookMap, ok := raw.(map[string]interface{})
	if !ok || bookMap == nil {
		return
	}
	levelsRaw, ok := bookMap["levels"].([]interface{})
	if !ok || len(levelsRaw) < 2 {
		return
	}

	// Levels[0] is bids, Levels[1] is asks
	bidsSlice, _ := levelsRaw[0].([]interface{})
	asksSlice, _ := levelsRaw[1].([]interface{})

	for i, item := range bidsSlice {
		entry, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		px := parseFloat(entry["px"])
		sz := parseFloat(entry["sz"])
		w := 1.0 / (1.0 + float64(i))
		if px > 0 && sz > 0 {
			notional := px * sz
			weightedBidUSD += notional * w
			bidDepthUSD += notional
			if i == 0 {
				bestBid = px
				touchBidUSD = notional
				touchBidSz = sz
			} else {
				deepBidUSD += notional
			}
		}
		if i >= 9 {
			break
		}
	}

	for i, item := range asksSlice {
		entry, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		px := parseFloat(entry["px"])
		sz := parseFloat(entry["sz"])
		w := 1.0 / (1.0 + float64(i))
		if px > 0 && sz > 0 {
			notional := px * sz
			weightedAskUSD += notional * w
			askDepthUSD += notional
			if i == 0 {
				bestAsk = px
				touchAskUSD = notional
				touchAskSz = sz
			} else {
				deepAskUSD += notional
			}
		}
		if i >= 9 {
			break
		}
	}

	return
}

func parseFloat(val interface{}) float64 {
	switch v := val.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && !math.IsNaN(f) {
			return f
		}
	}
	return 0.0
}

func (s *JevService) getAssetContext(ctx context.Context, coin string) (change24h, dayVol, funding, markPx float64, ok bool) {
	if s.exchange == nil {
		return 0, 0, 0, 0, false
	}
	dex := utils.GetDexName(coin)
	rawCtxs, err := s.exchange.GetAssetCtxs(ctx, dex)
	if err != nil || len(rawCtxs) == 0 {
		return 0, 0, 0, 0, false
	}

	targetCoin := strings.TrimSpace(coin)
	for _, item := range rawCtxs {
		ctxMap, isMap := item.(map[string]interface{})
		if !isMap {
			continue
		}
		cName, _ := ctxMap["coin"].(string)
		if cName == "" {
			cName, _ = ctxMap["name"].(string)
		}
		if dex != "" && !strings.HasPrefix(cName, dex+":") {
			cName = dex + ":" + cName
		}
		if strings.EqualFold(cName, targetCoin) {
			for _, key := range []string{"change24h", "priceChange24h", "priceChange", "pctChange", "dayPxChange"} {
				if v := parseFloat(ctxMap[key]); v != 0 {
					change24h = v
					break
				}
			}
			mark := parseFloat(ctxMap["markPx"])
			prevDay := parseFloat(ctxMap["prevDayPx"])
			if change24h == 0 && mark > 0 && prevDay > 0 {
				change24h = ((mark - prevDay) / prevDay) * 100.0
			}
			markPx = mark
			dayVol = parseFloat(ctxMap["dayNtlVlm"])
			funding = parseFloat(ctxMap["funding"]) * 100.0 // percent points
			return change24h, dayVol, funding, markPx, true
		}
	}
	return 0, 0, 0, 0, false
}

func (s *JevService) computeATR(ctx context.Context, coin, timeframe string, midPrice float64, change24h float64) float64 {
	cacheKey := strings.ToUpper(coin) + ":" + timeframe
	s.stateMu.RLock()
	entry, hasCached := s.atrCache[cacheKey]
	fetcher := s.candleSnapshotFetcher
	s.stateMu.RUnlock()

	if hasCached && time.Now().Before(entry.expiresAt) {
		return entry.atr
	}

	if fetcher != nil && midPrice > 0 {
		interval := "1h"
		lookbackBars := 14
		var barDurationMs int64 = 60 * 60 * 1000
		switch timeframe {
		case "scalp":
			interval = "15m"
			barDurationMs = 15 * 60 * 1000
		case "swing":
			interval = "1d"
			barDurationMs = 24 * 60 * 60 * 1000
		}
		nowMs := time.Now().UnixMilli()
		startMs := nowMs - (int64(lookbackBars+4) * barDurationMs)

		fetchCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		defer cancel()

		payload, err := fetcher(fetchCtx, coin, interval, startMs, nowMs)
		if err == nil && len(payload) > 0 {
			var rawCandles []map[string]interface{}
			if jErr := json.Unmarshal(payload, &rawCandles); jErr == nil && len(rawCandles) >= 2 {
				var trSum float64
				var count int
				for i := 1; i < len(rawCandles); i++ {
					h := parseFloat(rawCandles[i]["h"])
					l := parseFloat(rawCandles[i]["l"])
					prevC := parseFloat(rawCandles[i-1]["c"])
					if h > 0 && l > 0 && prevC > 0 {
						tr := math.Max(h-l, math.Max(math.Abs(h-prevC), math.Abs(l-prevC)))
						trSum += tr
						count++
					}
				}
				if count > 0 {
					avgTR := trSum / float64(count)
					atrVal := math.Round((avgTR/midPrice)*10000.0) / 100.0 // e.g. 1.25%
					s.stateMu.Lock()
					s.atrCache[cacheKey] = atrCacheEntry{
						atr:       atrVal,
						expiresAt: time.Now().Add(60 * time.Second),
					}
					s.stateMu.Unlock()
					return atrVal
				}
			}
		}
	}

	// Fallback to expired cached value if upstream fetch timed out or failed
	if hasCached && entry.atr > 0 {
		return entry.atr
	}

	// Fallback to in-memory macro daily candles (ticker-adaptive, zero-latency)
	s.stateMu.RLock()
	cEntry, hasMacro := s.macroCache[strings.ToUpper(coin)]
	s.stateMu.RUnlock()
	if hasMacro && cEntry.monthlyStats != nil && cEntry.monthlyStats.avgImpulsePct > 0 {
		dailyATR := cEntry.monthlyStats.avgImpulsePct
		switch timeframe {
		case "scalp":
			return math.Max(0.35, math.Min(2.50, dailyATR*0.22))
		case "swing":
			return math.Max(2.50, math.Min(15.00, dailyATR*1.00))
		default: // intraday
			return math.Max(1.00, math.Min(6.00, dailyATR*0.48))
		}
	}

	// Fallback ATR approximation derived from 24h momentum range if candles are cold
	if change24h != 0 {
		absChange := math.Abs(change24h)
		switch timeframe {
		case "scalp":
			return math.Max(0.35, math.Min(2.50, absChange*0.20))
		case "swing":
			return math.Max(2.50, math.Min(15.00, absChange*1.20))
		default: // intraday
			return math.Max(1.00, math.Min(6.00, absChange*0.50))
		}
	}

	switch timeframe {
	case "scalp":
		return 0.50
	case "swing":
		return 3.50
	default: // intraday
		return 1.50
	}
}

// VolumeProfile contains Auction Market Theory distribution parameters.
type VolumeProfile struct {
	POC         float64 `json:"poc"`
	VAH         float64 `json:"vah"`
	VAL         float64 `json:"val"`
	ProfileLow  float64 `json:"profileLow"`
	ProfileHigh float64 `json:"profileHigh"`
	TotalVolume float64 `json:"totalVolume"`
	HorizonType string  `json:"horizonType,omitempty"` // "monthly" (30D) or "quarterly" (90D)
	HorizonDays int     `json:"horizonDays,omitempty"` // 30 or 90
}

// MacroExtension contains high-timeframe distance and impulse exhaustion metrics.
type MacroExtension struct {
	TWAP                  float64 `json:"twap"`
	DistFromTWAPPct       float64 `json:"distFromTwapPct"`
	TWAP365D              float64 `json:"twap365d"`        // backwards compat alias
	DistFrom365DPct       float64 `json:"distFrom365dPct"` // backwards compat alias
	QuarterlyTWAP         float64 `json:"quarterlyTwap,omitempty"`
	QuarterlyDistPct      float64 `json:"quarterlyDistPct,omitempty"`
	HorizonDays           int     `json:"horizonDays"`     // 30 (monthly) or 90 (quarterly)
	HorizonType           string  `json:"horizonType"`     // "monthly" or "quarterly"
	AvgImpulsePct         float64 `json:"avgImpulsePct"`
	ImpulseExpansionPct   float64 `json:"impulseExpansionPct"`
	ImpulseConsumedRatio  float64 `json:"impulseConsumedRatio"`
	IsResistanceExhausted bool    `json:"isResistanceExhausted"`
	IsSupportExhausted    bool    `json:"isSupportExhausted"`
}

func computeVolumeProfile(rawCandles []map[string]interface{}, bins int, valueAreaPct float64) *VolumeProfile {
	if len(rawCandles) < 2 {
		return nil
	}
	if bins <= 0 {
		bins = 70
	}
	if valueAreaPct <= 0 {
		valueAreaPct = 0.70
	}

	lo := math.MaxFloat64
	hi := -math.MaxFloat64
	for _, c := range rawCandles {
		h := parseFloat(c["h"])
		l := parseFloat(c["l"])
		if h > 0 && l > 0 {
			if l < lo {
				lo = l
			}
			if h > hi {
				hi = h
			}
		}
	}
	if hi <= lo || math.IsInf(lo, 0) || math.IsInf(hi, 0) {
		return nil
	}

	binH := (hi - lo) / float64(bins)
	vols := make([]float64, bins)

	for _, c := range rawCandles {
		v := parseFloat(c["v"])
		h := parseFloat(c["h"])
		l := parseFloat(c["l"])
		if v <= 0 || h <= 0 || l <= 0 {
			continue
		}
		b0 := int((l - lo) / binH)
		if b0 < 0 {
			b0 = 0
		} else if b0 >= bins {
			b0 = bins - 1
		}
		b1 := int((h - lo) / binH)
		if b1 < 0 {
			b1 = 0
		} else if b1 >= bins {
			b1 = bins - 1
		}
		per := v / float64(b1-b0+1)
		for b := b0; b <= b1; b++ {
			vols[b] += per
		}
	}

	maxVol := 0.0
	pocIdx := 0
	totalVol := 0.0
	for b := 0; b < bins; b++ {
		totalVol += vols[b]
		if vols[b] > maxVol {
			maxVol = vols[b]
			pocIdx = b
		}
	}
	if maxVol <= 0 || totalVol <= 0 {
		return nil
	}

	targetVaVol := valueAreaPct * totalVol
	vaVol := vols[pocIdx]
	vaUpper := pocIdx
	vaLower := pocIdx

	for vaVol < targetVaVol && (vaUpper < bins-1 || vaLower > 0) {
		nextUp := -1.0
		if vaUpper+1 < bins {
			nextUp = vols[vaUpper+1]
		}
		nextDown := -1.0
		if vaLower-1 >= 0 {
			nextDown = vols[vaLower-1]
		}
		if nextUp >= nextDown {
			vaUpper++
			vaVol += nextUp
		} else {
			vaLower--
			vaVol += nextDown
		}
	}

	poc := lo + (float64(pocIdx)+0.5)*binH
	vah := lo + float64(vaUpper+1)*binH
	val := lo + float64(vaLower)*binH

	return &VolumeProfile{
		POC:         math.Round(poc*100.0) / 100.0,
		VAH:         math.Round(vah*100.0) / 100.0,
		VAL:         math.Round(val*100.0) / 100.0,
		ProfileLow:  math.Round(lo*100.0) / 100.0,
		ProfileHigh: math.Round(hi*100.0) / 100.0,
		TotalVolume: math.Round(totalVol*100.0) / 100.0,
	}
}

func extractMacroCandleStats(rawCandles []map[string]interface{}, horizonOpt ...string) *macroCandleStats {
	if len(rawCandles) == 0 {
		return nil
	}
	hType := "monthly"
	hDays := 30
	if len(horizonOpt) > 0 && strings.ToLower(horizonOpt[0]) == "quarterly" {
		hType = "quarterly"
		hDays = 90
	}
	closeSum := 0.0
	for _, c := range rawCandles {
		closeSum += parseFloat(c["c"])
	}
	twap := closeSum / float64(len(rawCandles))

	start14 := len(rawCandles) - 14
	if start14 < 0 {
		start14 = 0
	}
	recent14 := rawCandles[start14:]
	trPctSum := 0.0
	for _, c := range recent14 {
		h := parseFloat(c["h"])
		l := parseFloat(c["l"])
		if l > 0 {
			trPctSum += ((h - l) / l) * 100.0
		}
	}
	avgImpulsePct := 3.0
	if len(recent14) > 0 {
		avgImpulsePct = trPctSum / float64(len(recent14))
	}

	start7 := len(rawCandles) - 7
	if start7 < 0 {
		start7 = 0
	}
	recent7 := rawCandles[start7:]
	minL7 := math.MaxFloat64
	maxH7 := -math.MaxFloat64
	for _, c := range recent7 {
		l := parseFloat(c["l"])
		h := parseFloat(c["h"])
		if l > 0 && l < minL7 {
			minL7 = l
		}
		if h > 0 && h > maxH7 {
			maxH7 = h
		}
	}

	return &macroCandleStats{
		twap:          twap,
		avgImpulsePct: avgImpulsePct,
		candleMinL7:   minL7,
		candleMaxH7:   maxH7,
		hDays:         hDays,
		hType:         hType,
	}
}

func computeExtensionFromStats(stats *macroCandleStats, currentPrice float64) *MacroExtension {
	if stats == nil || currentPrice <= 0 {
		return nil
	}
	twap := stats.twap
	distFromTwap := 0.0
	if twap > 0 {
		distFromTwap = ((currentPrice - twap) / twap) * 100.0
	}

	minL7 := currentPrice
	if stats.candleMinL7 != math.MaxFloat64 && stats.candleMinL7 < minL7 {
		minL7 = stats.candleMinL7
	}
	maxH7 := currentPrice
	if stats.candleMaxH7 != -math.MaxFloat64 && stats.candleMaxH7 > maxH7 {
		maxH7 = stats.candleMaxH7
	}

	upExpansionPct := 0.0
	if minL7 > 0 {
		upExpansionPct = ((currentPrice - minL7) / minL7) * 100.0
	}
	downExpansionPct := 0.0
	if maxH7 > 0 {
		downExpansionPct = ((currentPrice - maxH7) / maxH7) * 100.0
	}

	expectedImpulseRange := math.Max(1.0, stats.avgImpulsePct*2.5)
	consumedRatio := upExpansionPct / expectedImpulseRange
	if downExpansionPct < 0 && math.Abs(downExpansionPct) > upExpansionPct {
		consumedRatio = downExpansionPct / expectedImpulseRange
	}

	isResExhausted := (distFromTwap >= 6.0 && consumedRatio >= 0.85)
	isSupExhausted := (distFromTwap <= -6.0 && consumedRatio <= -0.85)

	return &MacroExtension{
		TWAP:                  math.Round(twap*100.0) / 100.0,
		DistFromTWAPPct:       math.Round(distFromTwap*100.0) / 100.0,
		TWAP365D:              math.Round(twap*100.0) / 100.0,
		DistFrom365DPct:       math.Round(distFromTwap*100.0) / 100.0,
		HorizonDays:           stats.hDays,
		HorizonType:           stats.hType,
		AvgImpulsePct:         math.Round(stats.avgImpulsePct*100.0) / 100.0,
		ImpulseExpansionPct:   math.Round(upExpansionPct*100.0) / 100.0,
		ImpulseConsumedRatio:  math.Round(consumedRatio*100.0) / 100.0,
		IsResistanceExhausted: isResExhausted,
		IsSupportExhausted:    isSupExhausted,
	}
}

func computeMacroExtension(rawCandles []map[string]interface{}, currentPrice float64, horizonOpt ...string) *MacroExtension {
	stats := extractMacroCandleStats(rawCandles, horizonOpt...)
	return computeExtensionFromStats(stats, currentPrice)
}

func (s *JevService) computeMacroStructure(ctx context.Context, coin string, midPrice float64, tfOpt ...string) (*VolumeProfile, *MacroExtension) {
	if midPrice <= 0 {
		return nil, nil
	}

	requestedHz := "monthly"
	if len(tfOpt) > 0 {
		cleanTf := strings.ToLower(strings.TrimSpace(tfOpt[0]))
		if cleanTf == "swing" || cleanTf == "quarterly" {
			requestedHz = "quarterly"
		}
	}

	c := strings.ToUpper(coin)
	s.stateMu.RLock()
	entry, hasCached := s.macroCache[c]
	fetcher := s.candleSnapshotFetcher
	s.stateMu.RUnlock()

	sliceCandles := func(candles []map[string]interface{}) (monthly []map[string]interface{}, quarterly []map[string]interface{}) {
		quarterly = candles
		if len(quarterly) > 90 {
			quarterly = quarterly[len(quarterly)-90:]
		}
		monthly = candles
		if len(monthly) > 30 {
			monthly = monthly[len(monthly)-30:]
		}
		return monthly, quarterly
	}

	attachQuarterly := func(mExt, qExt *MacroExtension) {
		if mExt != nil && qExt != nil {
			mExt.QuarterlyTWAP = qExt.TWAP
			mExt.QuarterlyDistPct = qExt.DistFromTWAPPct
		}
	}

	if hasCached && time.Now().Before(entry.expiresAt) && (entry.monthlyStats != nil || len(entry.candles) >= 30) {
		if entry.monthlyStats != nil && entry.quarterlyStats != nil {
			if requestedHz == "quarterly" {
				return entry.quarterlyVP, computeExtensionFromStats(entry.quarterlyStats, midPrice)
			}
			ext := computeExtensionFromStats(entry.monthlyStats, midPrice)
			qExt := computeExtensionFromStats(entry.quarterlyStats, midPrice)
			attachQuarterly(ext, qExt)
			return entry.monthlyVP, ext
		}
		mCandles, qCandles := sliceCandles(entry.candles)
		if requestedHz == "quarterly" {
			ext := computeMacroExtension(qCandles, midPrice, "quarterly")
			return entry.quarterlyVP, ext
		}
		ext := computeMacroExtension(mCandles, midPrice, "monthly")
		qExt := computeMacroExtension(qCandles, midPrice, "quarterly")
		attachQuarterly(ext, qExt)
		return entry.monthlyVP, ext
	}

	if fetcher == nil {
		if hasCached && len(entry.candles) >= 30 {
			mCandles, qCandles := sliceCandles(entry.candles)
			if requestedHz == "quarterly" {
				return entry.quarterlyVP, computeMacroExtension(qCandles, midPrice, "quarterly")
			}
			ext := computeMacroExtension(mCandles, midPrice, "monthly")
			qExt := computeMacroExtension(qCandles, midPrice, "quarterly")
			attachQuarterly(ext, qExt)
			return entry.monthlyVP, ext
		}
		return nil, nil
	}

	nowMs := time.Now().UnixMilli()
	// Fetch up to 90 daily candles (Quarterly macro profile covering 90D and Monthly 30D)
	startMs := nowMs - (90 * 24 * 60 * 60 * 1000)

	fetchCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()

	payload, err := fetcher(fetchCtx, coin, "1d", startMs, nowMs)
	if err != nil || len(payload) == 0 {
		// Fallback to 4h lookback (90 days = 540 candles, or 30 days = 180 candles)
		startMs = nowMs - (90 * 24 * 60 * 60 * 1000)
		payload, err = fetcher(fetchCtx, coin, "4h", startMs, nowMs)
	}

	if err != nil || len(payload) == 0 {
		if hasCached && len(entry.candles) >= 30 {
			mCandles, qCandles := sliceCandles(entry.candles)
			if requestedHz == "quarterly" {
				return entry.quarterlyVP, computeMacroExtension(qCandles, midPrice, "quarterly")
			}
			ext := computeMacroExtension(mCandles, midPrice, "monthly")
			qExt := computeMacroExtension(qCandles, midPrice, "quarterly")
			attachQuarterly(ext, qExt)
			return entry.monthlyVP, ext
		}
		return nil, nil
	}

	var rawCandles []map[string]interface{}
	if err := json.Unmarshal(payload, &rawCandles); err != nil || len(rawCandles) < 30 {
		if hasCached && len(entry.candles) >= 30 {
			mCandles, qCandles := sliceCandles(entry.candles)
			if requestedHz == "quarterly" {
				return entry.quarterlyVP, computeMacroExtension(qCandles, midPrice, "quarterly")
			}
			ext := computeMacroExtension(mCandles, midPrice, "monthly")
			qExt := computeMacroExtension(qCandles, midPrice, "quarterly")
			attachQuarterly(ext, qExt)
			return entry.monthlyVP, ext
		}
		return nil, nil
	}

	mCandles, qCandles := sliceCandles(rawCandles)

	monthlyVP := computeVolumeProfile(mCandles, 70, 0.70)
	if monthlyVP != nil {
		monthlyVP.HorizonType = "monthly"
		monthlyVP.HorizonDays = 30
	}
	quarterlyVP := computeVolumeProfile(qCandles, 70, 0.70)
	if quarterlyVP != nil {
		quarterlyVP.HorizonType = "quarterly"
		quarterlyVP.HorizonDays = 90
	}

	monthlyExt := computeMacroExtension(mCandles, midPrice, "monthly")
	quarterlyExt := computeMacroExtension(qCandles, midPrice, "quarterly")
	attachQuarterly(monthlyExt, quarterlyExt)

	monthlyStats := extractMacroCandleStats(mCandles, "monthly")
	quarterlyStats := extractMacroCandleStats(qCandles, "quarterly")

	s.stateMu.Lock()
	s.macroCache[c] = macroCacheEntry{
		monthlyVP:      monthlyVP,
		quarterlyVP:    quarterlyVP,
		monthlyExt:     monthlyExt,
		quarterlyExt:   quarterlyExt,
		monthlyStats:   monthlyStats,
		quarterlyStats: quarterlyStats,
		candles:        rawCandles,
		expiresAt:      time.Now().Add(15 * time.Minute),
	}
	s.stateMu.Unlock()

	if requestedHz == "quarterly" {
		return quarterlyVP, quarterlyExt
	}
	return monthlyVP, monthlyExt
}

// NewsClassificationResult represents Jev's semantic analysis of a financial news headline.
type NewsClassificationResult struct {
	Headline   string  `json:"headline"`
	Direction  string  `json:"direction"` // "bullish", "bearish", "neutral"
	Sentiment  float64 `json:"sentiment"` // -1.0 to +1.0
	Impact     float64 `json:"impact"`    // 0.0 to 1.0
	IsCatalyst bool    `json:"isCatalyst"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model"`
}

// ClassifyNewsHeadline uses Jev System One to analyze headline sentiment and catalyst impact without regex bias.
func (s *JevService) ClassifyNewsHeadline(ctx context.Context, headline string) (*NewsClassificationResult, error) {
	headline = strings.TrimSpace(headline)
	if headline == "" {
		return nil, fmt.Errorf("headline is required")
	}
	if !s.IsAvailable() {
		return nil, fmt.Errorf("typesafe jev service is not available")
	}

	stateStr := fmt.Sprintf("Headline: %q", headline)
	questions := map[string]typesafe.QuestionSpec{
		"sentiment": {
			Type:         "choice",
			Instructions: "Classify the true market sentiment and price impact of this news headline for the relevant crypto asset.",
			Criteria: map[string]string{
				"bullish": "Positive catalyst, adoption, approval, net inflows, or regulatory relief.",
				"bearish": "Negative catalyst, exploit, lawsuit, rejection, insolvency, or net outflows.",
				"neutral": "Routine reporting, editorial commentary, or conflicting/unclear impact.",
			},
		},
		"impact_score": {
			Type:         "score",
			Instructions: "Rate the concrete market-moving magnitude from 1 (minor noise) to 5 (major systemic catalyst).",
			Criteria: []string{
				"1: Trivial mention, price speculation, or general commentary",
				"2: Minor product update or routine announcement",
				"3: Moderate ecosystem development, listing, or regional regulatory action",
				"4: Significant institutional flow, major protocol exploit, or federal action",
				"5: Historic macro event (ETF approval, major insolvency, federal reserve shift)",
			},
		},
		"is_catalyst": {
			Type:         "noul",
			Instructions: "Does this headline report a verified, concrete catalyst rather than speculation or clickbait?",
		},
	}

	resp, err := s.client.Decide(ctx, stateStr, questions)
	if err != nil {
		return nil, err
	}

	direction := "neutral"
	sentiment := 0.0
	confidence := 0.5
	if ans, ok := resp.Answers["sentiment"]; ok {
		direction = ans.Choice
		confidence = ans.Confidence
		if direction == "bullish" {
			sentiment = math.Max(0.3, ans.Confidence)
		} else if direction == "bearish" {
			sentiment = -math.Max(0.3, ans.Confidence)
		}
	}

	impact := 0.2
	if ans, ok := resp.Answers["impact_score"]; ok && ans.Score > 0 {
		impact = math.Min(1.0, ans.Score/5.0)
	}

	isCatalyst := false
	if ans, ok := resp.Answers["is_catalyst"]; ok {
		isCatalyst = ans.Noul > 0.5
	}

	return &NewsClassificationResult{
		Headline:   headline,
		Direction:  direction,
		Sentiment:  sentiment,
		Impact:     impact,
		IsCatalyst: isCatalyst,
		Confidence: confidence,
		Model:      resp.Model,
	}, nil
}

// PreTradeAuditResult contains Jev's pre-flight evaluation of order slippage and adverse flow.
type PreTradeAuditResult struct {
	Coin         string  `json:"coin"`
	IsBuy        bool    `json:"isBuy"`
	SizeUSD      float64 `json:"sizeUsd"`
	MidPrice     float64 `json:"midPrice"`
	SpreadBps    float64 `json:"spreadBps"`
	Depth50Bps   float64 `json:"depth50Bps"`
	BookWipePct  float64 `json:"bookWipePct"`
	SlippageRisk string  `json:"slippageRisk"` // "acceptable", "moderate", "severe"
	ToxicRisk    float64 `json:"toxicRisk"`
	Approved          bool    `json:"approved"`
	Advice            string  `json:"advice"`
	Model             string  `json:"model"`
	PermissionVerdict string  `json:"permissionVerdict,omitempty"` // "allow", "ask", "deny"
	PolicyRule        string  `json:"policyRule,omitempty"`
}

// AuditPreTrade evaluates order size against order book depth and spread to protect against adverse selection.
func (s *JevService) AuditPreTrade(ctx context.Context, coin string, isBuy bool, sizeUSD float64) (*PreTradeAuditResult, error) {
	coin = strings.TrimSpace(coin)
	if coin == "" {
		return nil, fmt.Errorf("coin is required")
	}
	if sizeUSD <= 0 {
		return nil, fmt.Errorf("sizeUsd must be positive")
	}
	if !s.IsAvailable() {
		return nil, fmt.Errorf("typesafe jev service is not available")
	}

	// Fetch live book and mid
	midPrice := 0.0
	if s.priceCache != nil {
		if entry, ok := s.priceCache.Get(coin); ok && (entry.Buy > 0 || entry.Sell > 0) {
			if entry.Buy > 0 && entry.Sell > 0 {
				midPrice = (entry.Buy + entry.Sell) / 2.0
			} else if entry.Buy > 0 {
				midPrice = entry.Buy
			} else {
				midPrice = entry.Sell
			}
		}
	}
	if midPrice <= 0 && s.exchange != nil {
		p, err := s.exchange.GetMidPrice(ctx, coin, false)
		if err == nil && p > 0 {
			midPrice = p
		}
	}

	var bestBid, bestAsk, bidDepthUSD, askDepthUSD float64
	if s.exchange != nil {
		if raw, err := s.exchange.GetL2Snapshot(ctx, coin, 10, false); err == nil && raw != nil {
			bestBid, bestAsk, bidDepthUSD, askDepthUSD = parseBookMetrics(raw)
		}
	}
	if midPrice <= 0 && bestBid > 0 && bestAsk > 0 {
		midPrice = (bestBid + bestAsk) / 2.0
	}
	if midPrice <= 0 {
		return nil, fmt.Errorf("could not resolve price for %s", coin)
	}

	spreadBps := 0.0
	if bestBid > 0 && bestAsk > 0 && midPrice > 0 {
		spreadBps = ((bestAsk - bestBid) / midPrice) * 10000.0
	}

	relevantDepth := askDepthUSD
	sideStr := "BUY"
	if !isBuy {
		relevantDepth = bidDepthUSD
		sideStr = "SELL"
	}

	bookWipePct := 0.0
	if relevantDepth > 0 {
		bookWipePct = (sizeUSD / relevantDepth) * 100.0
	}

	stateStr := fmt.Sprintf(
		"Coin: %s | Action: %s | OrderSize: $%.0f | Relevant Top10 Depth: $%.0f | BookWipe: %.1f%% | Spread: %.1f bps",
		coin, sideStr, sizeUSD, relevantDepth, bookWipePct, spreadBps,
	)

	questions := map[string]typesafe.QuestionSpec{
		"slippage_risk": {
			Type:         "choice",
			Instructions: "Evaluate the slippage and market-impact risk of placing this market/aggressive order given available depth.",
			Criteria: map[string]string{
				"acceptable": "Order size is well-supported by top levels with negligible slippage (< 10 bps).",
				"moderate":   "Order size consumes a noticeable fraction of top depth; moderate slippage expected.",
				"severe":     "Order size exhausts top-level depth; high risk of substantial slippage or liquidity vacuum.",
			},
		},
		"toxic_flow": {
			Type:         "noul",
			Instructions: "Is the market currently experiencing sharp adverse momentum against this trade direction?",
		},
	}

	resp, err := s.client.Decide(ctx, stateStr, questions)
	if err != nil {
		return nil, err
	}

	slippageRisk := "acceptable"
	if ans, ok := resp.Answers["slippage_risk"]; ok && ans.Choice != "" {
		slippageRisk = ans.Choice
	}

	toxicRisk := 0.0
	if ans, ok := resp.Answers["toxic_flow"]; ok {
		toxicRisk = ans.Noul
	}

	verdict := typesafe.VerdictAllow
	policy := "allow if slippage acceptable and book wipe <= 35%"
	approved := slippageRisk != "severe" && toxicRisk < 0.70
	advice := "Order structure safe to execute."

	if sizeUSD > 500000.0 {
		verdict = typesafe.VerdictDeny
		policy = "deny if single order size > $500,000 (circuit breaker limit)"
		approved = false
		advice = "Order exceeds hard max notional safety threshold ($500,000)."
	} else if bookWipePct > 80.0 || slippageRisk == "severe" {
		verdict = typesafe.VerdictDeny
		policy = "deny if book wipe > 80% or slippage risk severe"
		approved = false
		advice = "Order exceeds top-book liquidity; switch to passive limit order or slice via TWAP/Scale."
	} else if bookWipePct > 35.0 || toxicRisk >= 0.70 || slippageRisk == "moderate" {
		verdict = typesafe.VerdictAsk
		policy = "ask if book wipe > 35% or adverse momentum detected"
		if toxicRisk >= 0.70 {
			advice = "Adverse momentum detected; consider waiting for order flow stabilization."
		} else {
			advice = "Moderate slippage expected; consider using limit order inside the touch."
		}
	}

	return &PreTradeAuditResult{
		Coin:              coin,
		IsBuy:             isBuy,
		SizeUSD:           sizeUSD,
		MidPrice:          midPrice,
		SpreadBps:         spreadBps,
		Depth50Bps:        relevantDepth,
		BookWipePct:       bookWipePct,
		SlippageRisk:      slippageRisk,
		ToxicRisk:         toxicRisk,
		Approved:          approved,
		Advice:            advice,
		Model:             resp.Model,
		PermissionVerdict: string(verdict),
		PolicyRule:        policy,
	}, nil
}

// MispricingVerdict evaluates synthetic asset dislocation on Hyperliquid.
type MispricingVerdict struct {
	Coin           string  `json:"coin"`
	MarkPrice      float64 `json:"markPrice"`
	ReferenceClose float64 `json:"referenceClose"`
	DeviationPct   float64 `json:"deviationPct"`
	Verdict        string  `json:"verdict"` // "mean_reverting_noise", "informed_macro_repricing"
	Confidence     float64 `json:"confidence"`
	Recommended    string  `json:"recommended"` // "fade_arbitrage", "follow_momentum", "stand_aside"
	Model          string  `json:"model"`
}

// EvaluateMispricing evaluates synthetic asset deviation against market regime to classify arbitrage vs informed move.
func (s *JevService) EvaluateMispricing(ctx context.Context, coin string, markPx, closePx, deviationPct float64) (*MispricingVerdict, error) {
	coin = strings.TrimSpace(coin)
	if coin == "" {
		return nil, fmt.Errorf("coin is required")
	}
	if !s.IsAvailable() {
		return nil, fmt.Errorf("typesafe jev service is not available")
	}

	stateStr := fmt.Sprintf(
		"Synthetic Asset: %s | Current Mark: %.4f | Reference Close: %.4f | Deviation: %+.2f%%",
		coin, markPx, closePx, deviationPct,
	)

	questions := map[string]typesafe.QuestionSpec{
		"dislocation_type": {
			Type:         "choice",
			Instructions: "Classify whether this off-hours synthetic deviation is temporary retail noise or informed macro repricing.",
			Criteria: map[string]string{
				"mean_reverting_noise":     "Illiquid off-hours drift or retail imbalance likely to revert when cash markets open.",
				"informed_macro_repricing": "Fundamental weekend/overnight repricing driven by macro catalyst or earnings.",
			},
		},
		"recommendation": {
			Type:         "choice",
			Instructions: "What is the optimal trading strategy for this synthetic dislocation?",
			Criteria: map[string]string{
				"fade_arbitrage":  "Fade the deviation by quoting limit orders back toward the reference close.",
				"follow_momentum": "Trade with the momentum of the dislocation; do not fade.",
				"stand_aside":     "Excessive uncertainty or wide bid/ask spread; avoid participation.",
			},
		},
	}

	resp, err := s.client.Decide(ctx, stateStr, questions)
	if err != nil {
		return nil, err
	}

	verdict := "mean_reverting_noise"
	conf := 0.5
	if ans, ok := resp.Answers["dislocation_type"]; ok && ans.Choice != "" {
		verdict = ans.Choice
		conf = ans.Confidence
	}

	recommended := "fade_arbitrage"
	if ans, ok := resp.Answers["recommendation"]; ok && ans.Choice != "" {
		recommended = ans.Choice
	}

	return &MispricingVerdict{
		Coin:           coin,
		MarkPrice:      markPx,
		ReferenceClose: closePx,
		DeviationPct:   deviationPct,
		Verdict:        verdict,
		Confidence:     conf,
		Recommended:    recommended,
		Model:          resp.Model,
	}, nil
}

// TradeSignal represents a real-time actionable trade recommendation from Jev System One.
type TradeSignal struct {
	Coin                  string  `json:"coin"`
	Timeframe             string  `json:"timeframe"`         // "scalp", "intraday", "swing"
	EstimatedDuration     string  `json:"estimatedDuration"` // e.g. "15m – 45m (Quick Scalp)", "2h – 8h (Session Intraday)", "1d – 5d (Intra-Month Swing)"
	Action                string  `json:"action"`            // "BUY", "SELL", or "HOLD"
	SignalType            string  `json:"signalType"`        // "trend", "counter_trend", or "neutral"
	MarketEnvironment     string  `json:"marketEnvironment"` // "range" or "trend"
	Conviction            float64 `json:"conviction"`        // 0.0 to 1.0
	Score                 float64 `json:"score"`             // 1.0 to 5.0
	MidPrice              float64 `json:"midPrice"`
	EntryPrice            float64 `json:"entryPrice"`
	TakeProfitPrice       float64 `json:"takeProfitPrice"`
	StopLossPrice         float64 `json:"stopLossPrice"`
	TakeProfitPct         float64 `json:"takeProfitPct"`
	StopLossPct           float64 `json:"stopLossPct"`
	RiskRewardRatio       float64 `json:"riskRewardRatio"`
	ToxicRisk             float64 `json:"toxicRisk"`
	SpreadBps             float64 `json:"spreadBps"`
	BookImbalance         float64 `json:"bookImbalance"`
	WeightedBookImbalance float64 `json:"weightedBookImbalance,omitempty"`
	MicroPriceDriftBps    float64 `json:"microPriceDriftBps,omitempty"`
	Reason                string  `json:"reason"`
	Timestamp             int64   `json:"timestamp"`
	Model                 string  `json:"model"`
	ATRPct                float64 `json:"atrPct,omitempty"`
	MacroTrend            string  `json:"macroTrend,omitempty"`
	Change24h             float64 `json:"change24h,omitempty"`
	VAH                   float64 `json:"vah,omitempty"`
	VAL                   float64 `json:"val,omitempty"`
	POC                   float64 `json:"poc,omitempty"`
	ProfileHorizon        string  `json:"profileHorizon,omitempty"` // "monthly" (30D) or "quarterly" (90D)
	MonthlyVAH            float64 `json:"monthlyVah,omitempty"`
	MonthlyVAL            float64 `json:"monthlyVal,omitempty"`
	MonthlyPOC            float64 `json:"monthlyPoc,omitempty"`
	QuarterlyVAH          float64 `json:"quarterlyVah,omitempty"`
	QuarterlyVAL          float64 `json:"quarterlyVal,omitempty"`
	QuarterlyPOC          float64 `json:"quarterlyPoc,omitempty"`
	DistFromTWAPPct       float64 `json:"distFromTwapPct,omitempty"`
	DistFrom365DPct       float64 `json:"distFrom365dPct,omitempty"` // backwards compat alias (maps to DistFromTWAPPct)
	VisibilityLevel       string  `json:"visibilityLevel,omitempty"`
	SharedRetrieval           bool    `json:"sharedRetrieval,omitempty"`
	CacheReused               bool    `json:"cacheReused,omitempty"`
	IsToxicHalted             bool    `json:"isToxicHalted,omitempty"`
	ToxicHaltRemainingSeconds int     `json:"toxicHaltRemainingSeconds,omitempty"`
}

// GenerateSignal synthesizes orderbook structure, OFI, and Jev System One decisions into an actionable trade signal
// calibrated for the requested holding horizon ("scalp", "intraday", or "swing").
// Employs a dual-threshold Schmitt trigger hysteresis engine, instant toxic flow tripwire,
// and spatial multi-depth spoof defense to eliminate boundary chatter without adding lag.
func (s *JevService) GenerateSignal(ctx context.Context, coin string, tfOpt ...string) (*TradeSignal, error) {
	tf := "intraday"
	if len(tfOpt) > 0 && strings.TrimSpace(tfOpt[0]) != "" {
		tf = strings.ToLower(strings.TrimSpace(tfOpt[0]))
	}

	stateKey := strings.ToUpper(coin) + ":" + tf
	subgoalKey := fmt.Sprintf("signal:%s:%s", strings.ToUpper(coin), tf)

	if s.subgoalReg != nil {
		isDup, entry := s.subgoalReg.RegisterInFlight(subgoalKey)
		if isDup && entry != nil && entry.Result != nil {
			if existingSig, ok := entry.Result.(*TradeSignal); ok && existingSig != nil {
				sigCopy := *existingSig
				sigCopy.CacheReused = true
				return &sigCopy, nil
			}
		}
	}

	s.stateMu.Lock()
	if s.lastSignals == nil {
		s.lastSignals = make(map[string]*TradeSignal)
	}
	if s.toxicCooldowns == nil {
		s.toxicCooldowns = make(map[string]time.Time)
	}
	prevSig := s.lastSignals[stateKey]
	cooldownUntil, inCooldown := s.toxicCooldowns[stateKey]
	s.stateMu.Unlock()

	analysis, err := s.Analyze(ctx, coin, tf)
	if err != nil {
		return nil, err
	}

	action := "HOLD"
	reason := "Balanced order flow; no directional edge."
	signalType := "neutral"
	marketEnv := "range"
	var slPct, tpPct float64
	var estimatedDuration string
	var toxicThreshold float64 = 0.45
	var minActivationConviction float64 = 0.65
	var retentionConviction float64 = 0.50
	var maxSpreadBps float64 = 25.0

	if analysis.ATRPct > 0 {
		switch tf {
		case "scalp":
			estimatedDuration = "15m – 45m (Quick Scalp)"
			toxicThreshold = 0.35 // Scalps are highly vulnerable to adverse liquidity sweeps
			minActivationConviction = 0.65
			retentionConviction = 0.50
			maxSpreadBps = 8.0
			// Scalp ATR bracket: 0.60x 15m ATR for SL (min 0.30%, max 1.50%), 2:1 TP
			slPct = math.Max(0.30, math.Min(1.50, analysis.ATRPct*0.60))
			tpPct = slPct * 2.0

		case "swing":
			estimatedDuration = "1d – 5d (Intra-Month Swing)"
			toxicThreshold = 0.55 // High timeframe swing filters out micro sweeps
			minActivationConviction = 0.60
			retentionConviction = 0.48
			maxSpreadBps = 40.0
			// Swing ATR bracket: 2.20x daily ATR for SL (min 2.50%, max 12.00%), 2.1:1 TP
			slPct = math.Max(2.50, math.Min(12.00, analysis.ATRPct*2.20))
			tpPct = slPct * 2.1

		default: // "intraday"
			tf = "intraday"
			estimatedDuration = "2h – 8h (Session Intraday)"
			toxicThreshold = 0.45
			minActivationConviction = 0.65
			retentionConviction = 0.50
			maxSpreadBps = 25.0
			// Intraday ATR bracket: 1.20x 1h ATR for SL (min 1.00%, max 4.50%), 2:1 TP
			slPct = math.Max(1.00, math.Min(4.50, analysis.ATRPct*1.20))
			tpPct = slPct * 2.0
		}
	} else {
		switch tf {
		case "scalp":
			estimatedDuration = "15m – 45m (Quick Scalp)"
			toxicThreshold = 0.35
			minActivationConviction = 0.65
			retentionConviction = 0.50
			maxSpreadBps = 8.0
			slPct = 0.40
			tpPct = 0.80

		case "swing":
			estimatedDuration = "1d – 5d (Intra-Month Swing)"
			toxicThreshold = 0.55
			minActivationConviction = 0.60
			retentionConviction = 0.48
			maxSpreadBps = 40.0
			slPct = 3.50
			tpPct = 7.35

		default: // "intraday"
			tf = "intraday"
			estimatedDuration = "2h – 8h (Session Intraday)"
			toxicThreshold = 0.45
			minActivationConviction = 0.65
			retentionConviction = 0.50
			maxSpreadBps = 25.0
			slPct = 1.50
			tpPct = 3.00
		}
	}

	spreadPct := 0.0
	var isToxicHalted bool
	var toxicHaltRemainingSeconds int
	if analysis.SpreadBps > 0 {
		spreadPct = analysis.SpreadBps / 100.0
	}
	if spreadPct > 0 && slPct < spreadPct*2.0 {
		slPct = spreadPct * 2.0
		tpPct = math.Max(tpPct, slPct*2.0)
	}
	// Macro Volume Profile & TWAP anchor (serves from 15-minute RAM cache in < 1µs)
	profileHz := "monthly"
	if tf == "swing" {
		profileHz = "quarterly"
	}
	vp, ext := s.computeMacroStructure(ctx, coin, analysis.MidPrice, profileHz)
	vahVal := 0.0
	valVal := 0.0
	pocVal := 0.0
	distTwapVal := 0.0
	if vp != nil {
		vahVal = vp.VAH
		valVal = vp.VAL
		pocVal = vp.POC
	}
	if ext != nil {
		distTwapVal = ext.DistFromTWAPPct
	}

	isCrossed := analysis.SpreadBps < 0 || (analysis.BestBid > 0 && analysis.BestAsk > 0 && analysis.BestBid >= analysis.BestAsk)

	if isCrossed {
		action = "HOLD"
		reason = fmt.Sprintf("[%s] Orderbook crossed or unquoted (bid %.4f >= ask %.4f); market paused.", strings.ToUpper(tf), analysis.BestBid, analysis.BestAsk)
	} else if analysis.ToxicFlowRisk > toxicThreshold {
		// 2. Instant Toxic Flow Tripwire (0ms delay to protect capital)
		action = "HOLD"
		reason = fmt.Sprintf("[%s] Toxic flow tripwire active (%.0f%% > %.0f%% limit); adverse sweep detected.", strings.ToUpper(tf), analysis.ToxicFlowRisk*100, toxicThreshold*100)
		s.stateMu.Lock()
		s.toxicCooldowns[stateKey] = time.Now().Add(15 * time.Second)
		s.stateMu.Unlock()
		isToxicHalted = true
		toxicHaltRemainingSeconds = 15
	} else if inCooldown && time.Now().Before(cooldownUntil) && analysis.ToxicFlowRisk > (toxicThreshold*0.8) {
		action = "HOLD"
		remaining := time.Until(cooldownUntil).Round(time.Second)
		reason = fmt.Sprintf("[%s] Toxic flow stabilizing (%s cooldown); waiting for orderbook replenishment.", strings.ToUpper(tf), remaining)
		isToxicHalted = true
		remSec := int(math.Ceil(time.Until(cooldownUntil).Seconds()))
		if remSec < 1 {
			remSec = 1
		}
		toxicHaltRemainingSeconds = remSec
	} else if analysis.SpreadBps > maxSpreadBps || (slPct > 0 && spreadPct >= slPct*0.75) {
		// 3. Spread Friction Gating: Reject trades where bid/ask spread eats into risk budget
		action = "HOLD"
		reason = fmt.Sprintf("[%s] Spread too wide (%.1f bps); friction exceeds strategy tolerance.", strings.ToUpper(tf), analysis.SpreadBps)
	} else {
		// 4. Dual-Threshold State Hysteresis (Schmitt Trigger)
		hasValidPriorState := prevSig != nil && prevSig.Action != "HOLD" && (time.Now().UnixMilli()-prevSig.Timestamp) < 180000 // 3 min memory window

		if hasValidPriorState && prevSig.Action == "BUY" {
			// Instant regime reversal if sellers take aggressive control
			if analysis.Direction == "bearish" && analysis.DirectionConfidence >= minActivationConviction {
				action = "SELL"
				reason = fmt.Sprintf("[%s] Regime reversal: aggressive ask overhang detected (%.0f%% conviction).", strings.ToUpper(tf), analysis.DirectionConfidence*100)
			} else if analysis.Direction == "bullish" && analysis.DirectionConfidence >= retentionConviction {
				action = "BUY"
				if analysis.DirectionConfidence < minActivationConviction {
					reason = fmt.Sprintf("[%s] BUY state retained via hysteresis (%.0f%% conviction holding above %.0f%% floor).", strings.ToUpper(tf), analysis.DirectionConfidence*100, retentionConviction*100)
				} else {
					switch tf {
					case "scalp":
						reason = fmt.Sprintf("[SCALP] Immediate OFI surge (+%.2f) at touch with $%.0fK bid buffer.", analysis.BookImbalance, analysis.BidDepthUSD/1000.0)
					case "swing":
						reason = fmt.Sprintf("[SWING] Macro orderbook support and multi-day accumulation ($%.0fK bid depth).", analysis.BidDepthUSD/1000.0)
					default:
						reason = fmt.Sprintf("[INTRADAY] OFI positive (+%.2f) with strong session bid support ($%.0fK depth).", analysis.BookImbalance, analysis.BidDepthUSD/1000.0)
					}
				}
			} else if analysis.Direction == "neutral" {
				bullishProb := analysis.DirectionProbabilities["bullish"]
				if (bullishProb >= retentionConviction || analysis.BookImbalance > 0.12) && analysis.DirectionConfidence < 0.75 {
					action = "BUY"
					reason = fmt.Sprintf("[%s] BUY state retained during consolidation (order flow imbalance %+.2f).", strings.ToUpper(tf), analysis.BookImbalance)
				} else {
					action = "HOLD"
					reason = fmt.Sprintf("[%s] Long conviction faded; order flow consolidated into neutral.", strings.ToUpper(tf))
				}
			} else {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Long conviction faded below retention floor (%.0f%% < %.0f%%).", strings.ToUpper(tf), analysis.DirectionConfidence*100, retentionConviction*100)
			}
		} else if hasValidPriorState && prevSig.Action == "SELL" {
			// Instant regime reversal if buyers take aggressive control
			if analysis.Direction == "bullish" && analysis.DirectionConfidence >= minActivationConviction {
				action = "BUY"
				reason = fmt.Sprintf("[%s] Regime reversal: aggressive bid support detected (%.0f%% conviction).", strings.ToUpper(tf), analysis.DirectionConfidence*100)
			} else if analysis.Direction == "bearish" && analysis.DirectionConfidence >= retentionConviction {
				action = "SELL"
				if analysis.DirectionConfidence < minActivationConviction {
					reason = fmt.Sprintf("[%s] SELL state retained via hysteresis (%.0f%% conviction holding above %.0f%% floor).", strings.ToUpper(tf), analysis.DirectionConfidence*100, retentionConviction*100)
				} else {
					switch tf {
					case "scalp":
						reason = fmt.Sprintf("[SCALP] Immediate ask sweep pressure (%.2f OFI) against $%.0fK ask wall.", analysis.BookImbalance, analysis.AskDepthUSD/1000.0)
					case "swing":
						reason = fmt.Sprintf("[SWING] Macro ask overhang and multi-day distribution ($%.0fK ask depth).", analysis.AskDepthUSD/1000.0)
					default:
						reason = fmt.Sprintf("[INTRADAY] OFI negative (%.2f) with heavy session ask overhang ($%.0fK depth).", analysis.BookImbalance, analysis.AskDepthUSD/1000.0)
					}
				}
			} else if analysis.Direction == "neutral" {
				bearishProb := analysis.DirectionProbabilities["bearish"]
				if (bearishProb >= retentionConviction || analysis.BookImbalance < -0.12) && analysis.DirectionConfidence < 0.75 {
					action = "SELL"
					reason = fmt.Sprintf("[%s] SELL state retained during consolidation (order flow imbalance %+.2f).", strings.ToUpper(tf), analysis.BookImbalance)
				} else {
					action = "HOLD"
					reason = fmt.Sprintf("[%s] Short conviction faded; order flow consolidated into neutral.", strings.ToUpper(tf))
				}
			} else {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Short conviction faded below retention floor (%.0f%% < %.0f%%).", strings.ToUpper(tf), analysis.DirectionConfidence*100, retentionConviction*100)
			}
		} else {
			// Standard Activation from HOLD
			if analysis.DirectionConfidence < minActivationConviction {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Directional conviction insufficient (%.0f%% < %.0f%% activation threshold).", strings.ToUpper(tf), analysis.DirectionConfidence*100, minActivationConviction*100)
			} else if analysis.Direction == "bullish" {
				action = "BUY"
				switch tf {
				case "scalp":
					reason = fmt.Sprintf("[SCALP] Immediate OFI surge (+%.2f) at touch with $%.0fK bid buffer.", analysis.BookImbalance, analysis.BidDepthUSD/1000.0)
				case "swing":
					reason = fmt.Sprintf("[SWING] Macro orderbook support and multi-day accumulation ($%.0fK bid depth).", analysis.BidDepthUSD/1000.0)
				default:
					reason = fmt.Sprintf("[INTRADAY] OFI positive (+%.2f) with strong session bid support ($%.0fK depth).", analysis.BookImbalance, analysis.BidDepthUSD/1000.0)
				}
			} else if analysis.Direction == "bearish" {
				action = "SELL"
				switch tf {
				case "scalp":
					reason = fmt.Sprintf("[SCALP] Immediate ask sweep pressure (%.2f OFI) against $%.0fK ask wall.", analysis.BookImbalance, analysis.AskDepthUSD/1000.0)
				case "swing":
					reason = fmt.Sprintf("[SWING] Macro ask overhang and multi-day distribution ($%.0fK ask depth).", analysis.AskDepthUSD/1000.0)
				default:
					reason = fmt.Sprintf("[INTRADAY] OFI negative (%.2f) with heavy session ask overhang ($%.0fK depth).", analysis.BookImbalance, analysis.AskDepthUSD/1000.0)
				}
			}
		}

		// 5. Spatial Multi-Depth Divergence Defense (Zero-Lag Spoof Protection)
		if action == "BUY" && analysis.TouchImbalance > 0.25 && analysis.DeepImbalance < -0.20 {
			action = "HOLD"
			reason = fmt.Sprintf("[%s] Spoof trap defense: touch/deep depth divergence (%+.2f touch vs %+.2f deep overhang).", strings.ToUpper(tf), analysis.TouchImbalance, analysis.DeepImbalance)
		} else if action == "SELL" && analysis.TouchImbalance < -0.25 && analysis.DeepImbalance > 0.20 {
			action = "HOLD"
			reason = fmt.Sprintf("[%s] Spoof trap defense: touch/deep depth divergence (%+.2f touch vs %+.2f deep support).", strings.ToUpper(tf), analysis.TouchImbalance, analysis.DeepImbalance)
		}

		// 6. Macro Trend Confluence Filter (Anti-Fading Protection)
		// Suppresses counter-trend signals during strong 24h momentum unless conviction is institutional (>= 78%)
		if action == "BUY" && analysis.Change24h <= -3.5 && analysis.DirectionConfidence < 0.78 {
			action = "HOLD"
			reason = fmt.Sprintf("[%s] Macro trend filter: counter-trend BUY suppressed during 24h dump (%+.1f%%; requires 78%% conviction).", strings.ToUpper(tf), analysis.Change24h)
		} else if action == "SELL" && analysis.Change24h >= 3.5 && analysis.DirectionConfidence < 0.78 {
			action = "HOLD"
			reason = fmt.Sprintf("[%s] Macro trend filter: counter-trend SELL suppressed during 24h surge (%+.1f%%; requires 78%% conviction).", strings.ToUpper(tf), analysis.Change24h)
		}

		profileTitle := "Monthly"
		twapTitle := "30D"
		if profileHz == "quarterly" {
			profileTitle = "Quarterly"
			twapTitle = "90D"
		}

		// Macro Extension metrics for Gate 7
		isLongExtended := false
		isShortExtended := false
		displayDist := distTwapVal
		displayTwapTitle := twapTitle
		if ext != nil {
			isLongExtended = ext.IsResistanceExhausted || distTwapVal >= 6.0 || ext.QuarterlyDistPct >= 6.0
			isShortExtended = ext.IsSupportExhausted || distTwapVal <= -6.0 || ext.QuarterlyDistPct <= -6.0
			if profileHz != "quarterly" && ext.QuarterlyDistPct >= 6.0 && distTwapVal < 6.0 {
				displayDist = ext.QuarterlyDistPct
				displayTwapTitle = "90D"
			} else if profileHz != "quarterly" && ext.QuarterlyDistPct <= -6.0 && distTwapVal > -6.0 {
				displayDist = ext.QuarterlyDistPct
				displayTwapTitle = "90D"
			}
		}

		// Environment & Signal Type Classification (Range vs Trend)
		signalType = "neutral"
		marketEnv = "range"
		c24 := analysis.Change24h
		rangeHigh := vahVal
		rangeLow := valVal
		rangeMid := pocVal
		hasRangeBounds := rangeHigh > 0 && rangeLow > 0 && rangeHigh > rangeLow

		if math.Abs(c24) >= 3.0 {
			marketEnv = "trend"
		} else if hasRangeBounds {
			if analysis.MidPrice > rangeHigh*1.020 && c24 >= 2.0 {
				marketEnv = "trend"
			} else if analysis.MidPrice < rangeLow*0.980 && c24 <= -2.0 {
				marketEnv = "trend"
			} else {
				marketEnv = "range"
			}
		} else {
			if math.Abs(c24) < 2.0 {
				marketEnv = "range"
			} else {
				marketEnv = "trend"
			}
		}

		atRangeHigh := hasRangeBounds && (analysis.MidPrice >= 0.990*rangeHigh && analysis.MidPrice <= 1.025*rangeHigh)
		atRangeLow := hasRangeBounds && (analysis.MidPrice <= 1.010*rangeLow && analysis.MidPrice >= 0.975*rangeLow)
		profileLabel := "monthly"
		if profileHz == "quarterly" {
			profileLabel = "quarterly"
		}

		if atRangeHigh {
			if action == "BUY" && analysis.DirectionConfidence >= 0.82 {
				// Institutional breakout trend long
				action = "BUY"
				signalType = "trend"
				marketEnv = "trend"
				reason = fmt.Sprintf("[%s] Breakout trend long: institutional conviction (%.0f%%) clearing %s range high resistance (VAH $%.2f); momentum continuation.", strings.ToUpper(tf), analysis.DirectionConfidence*100, profileLabel, rangeHigh)
			} else {
				// Counter-trend range-high short: fade long exhaustion at resistance
				isRejection := analysis.Direction == "bearish"
				isAbsorption := analysis.DirectionConfidence >= 0.70 && analysis.BookImbalance <= 0.10
				if isRejection || isAbsorption {
					action = "SELL"
					signalType = "counter_trend"
					marketEnv = "range"
					if isRejection {
						reason = fmt.Sprintf("[%s] Counter-trend range-high short: resistance rejection confirmed at %s VAH ($%.2f); fading toward POC ($%.2f).", strings.ToUpper(tf), profileLabel, rangeHigh, rangeMid)
					} else {
						reason = fmt.Sprintf("[%s] Counter-trend range-high short: testing %s resistance ($%.2f vs VAH $%.2f) with orderflow absorption; fading long exhaustion for mean-reversion toward POC ($%.2f).", strings.ToUpper(tf), profileLabel, analysis.MidPrice, rangeHigh, rangeMid)
					}
				} else {
					action = "HOLD"
					signalType = "neutral"
					marketEnv = "range"
					if isLongExtended {
						reason = fmt.Sprintf("[%s] Gate 7: Long suppressed at %s Volume Profile resistance ($%.1f testing VAH $%.1f; %+.1f%% above %s TWAP); asymmetric downside risk.", strings.ToUpper(tf), profileTitle, analysis.MidPrice, vahVal, displayDist, displayTwapTitle)
					} else {
						reason = fmt.Sprintf("[%s] Range high resistance test ($%.2f vs VAH $%.2f): awaiting order flow absorption/rejection before fading.", strings.ToUpper(tf), analysis.MidPrice, rangeHigh)
					}
				}
			}
		} else if atRangeLow {
			if action == "SELL" && analysis.DirectionConfidence >= 0.82 {
				// Institutional breakdown trend short
				action = "SELL"
				signalType = "trend"
				marketEnv = "trend"
				reason = fmt.Sprintf("[%s] Breakdown trend short: institutional conviction (%.0f%%) clearing %s range low support (VAL $%.2f); momentum continuation.", strings.ToUpper(tf), analysis.DirectionConfidence*100, profileLabel, rangeLow)
			} else {
				// Counter-trend range-low long: fade short exhaustion at support
				isBounce := analysis.Direction == "bullish"
				isAbsorption := analysis.DirectionConfidence >= 0.70 && analysis.BookImbalance >= -0.10
				if isBounce || isAbsorption {
					action = "BUY"
					signalType = "counter_trend"
					marketEnv = "range"
					if isBounce {
						reason = fmt.Sprintf("[%s] Counter-trend range-low long: support bounce confirmed at %s VAL ($%.2f); mean-reversion bounce toward POC ($%.2f).", strings.ToUpper(tf), profileLabel, rangeLow, rangeMid)
					} else {
						reason = fmt.Sprintf("[%s] Counter-trend range-low long: testing %s support ($%.2f vs VAL $%.2f) with orderflow absorption; mean-reversion bounce toward POC ($%.2f).", strings.ToUpper(tf), profileLabel, analysis.MidPrice, rangeLow, rangeMid)
					}
				} else {
					action = "HOLD"
					signalType = "neutral"
					marketEnv = "range"
					if isShortExtended {
						reason = fmt.Sprintf("[%s] Gate 7: Short suppressed at %s Volume Profile support ($%.1f testing VAL $%.1f; %+.1f%% below %s TWAP); asymmetric bounce risk.", strings.ToUpper(tf), profileTitle, analysis.MidPrice, valVal, displayDist, displayTwapTitle)
					} else {
						reason = fmt.Sprintf("[%s] Range low support test ($%.2f vs VAL $%.2f): awaiting order flow absorption/bounce before longing.", strings.ToUpper(tf), analysis.MidPrice, rangeLow)
					}
				}
			}
		} else {
			// NOT at range high or range low: strictly enforce Gate 6 and Gate 7 against open-water momentum
			if action == "BUY" && c24 <= -3.5 && analysis.DirectionConfidence < 0.78 {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Macro trend filter: counter-trend BUY suppressed during 24h dump (%+.1f%%; requires 78%% conviction).", strings.ToUpper(tf), c24)
			} else if action == "SELL" && c24 >= 3.5 && analysis.DirectionConfidence < 0.78 {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Macro trend filter: counter-trend SELL suppressed during 24h surge (%+.1f%%; requires 78%% conviction).", strings.ToUpper(tf), c24)
			} else if action == "BUY" && isLongExtended && analysis.DirectionConfidence < 0.82 {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Gate 7: Long suppressed at %s Volume Profile resistance ($%.1f; %+.1f%% above %s TWAP); asymmetric downside risk.", strings.ToUpper(tf), profileTitle, analysis.MidPrice, displayDist, displayTwapTitle)
			} else if action == "SELL" && isShortExtended && analysis.DirectionConfidence < 0.82 {
				action = "HOLD"
				reason = fmt.Sprintf("[%s] Gate 7: Short suppressed at %s Volume Profile support ($%.1f; %+.1f%% below %s TWAP); asymmetric bounce risk.", strings.ToUpper(tf), profileTitle, analysis.MidPrice, displayDist, displayTwapTitle)
			} else if action != "HOLD" {
				if marketEnv == "range" {
					if rangeMid > 0 && math.Abs(analysis.MidPrice-rangeMid)/rangeMid <= 0.005 && analysis.DirectionConfidence < 0.70 {
						action = "HOLD"
						signalType = "neutral"
						reason = fmt.Sprintf("[%s] Range equilibrium: price oscillating near POC ($%.2f); awaiting test of range boundaries (VAH/VAL).", strings.ToUpper(tf), rangeMid)
					} else {
						signalType = "trend"
						if !hasValidPriorState {
							if action == "BUY" {
								reason = fmt.Sprintf("[%s] Range rotation BUY: upward momentum from POC ($%.2f) toward range high (VAH $%.2f).", strings.ToUpper(tf), rangeMid, rangeHigh)
							} else if action == "SELL" {
								reason = fmt.Sprintf("[%s] Range rotation SELL: downward momentum from POC ($%.2f) toward range low (VAL $%.2f).", strings.ToUpper(tf), rangeMid, rangeLow)
							}
						}
					}
				} else {
					if c24 >= 2.0 {
						if action == "BUY" {
							signalType = "trend"
							if !hasValidPriorState {
								reason = fmt.Sprintf("[%s] Trend following BUY: aligned with macro bull trend (%+.1f%% 24h); upside continuation.", strings.ToUpper(tf), c24)
							}
						} else if action == "SELL" {
							signalType = "counter_trend"
							if !hasValidPriorState {
								reason = fmt.Sprintf("[%s] Counter-trend pull-back SELL: institutional conviction (%.0f%%) fading overextended bull trend (%+.1f%% 24h).", strings.ToUpper(tf), analysis.DirectionConfidence*100, c24)
							}
						}
					} else if c24 <= -2.0 {
						if action == "SELL" {
							signalType = "trend"
							if !hasValidPriorState {
								reason = fmt.Sprintf("[%s] Trend following SELL: aligned with macro bear trend (%+.1f%% 24h); downside continuation.", strings.ToUpper(tf), c24)
							}
						} else if action == "BUY" {
							signalType = "counter_trend"
							if !hasValidPriorState {
								reason = fmt.Sprintf("[%s] Counter-trend relief BUY: institutional conviction (%.0f%%) fading oversold bear trend (%+.1f%% 24h).", strings.ToUpper(tf), analysis.DirectionConfidence*100, c24)
							}
						}
					} else {
						signalType = "trend"
						if !hasValidPriorState {
							reason = fmt.Sprintf("[%s] Trend following %s: directional momentum confirmed (%.0f%% conviction).", strings.ToUpper(tf), action, analysis.DirectionConfidence*100)
						}
					}
				}
			}
		}
	}

	// 8. Horizon-Calibrated Execution Pricing and Brackets
	entryPrice := 0.0
	tpPrice := 0.0
	slPrice := 0.0

	if action == "BUY" {
		rawEntry := analysis.MidPrice
		switch tf {
		case "scalp":
			if analysis.BestBid > 0 {
				rawEntry = analysis.BestBid
			}
		case "swing":
			if analysis.MidPrice > 0 {
				rawEntry = analysis.MidPrice * 0.9975 // -0.25% pullback limit entry
			}
		default: // intraday
			if analysis.SuggestedLimitPrice > 0 && analysis.BestAsk > 0 && analysis.SuggestedLimitPrice <= analysis.BestAsk {
				rawEntry = analysis.SuggestedLimitPrice
			} else if analysis.BestBid > 0 {
				rawEntry = analysis.BestBid
			}
		}
		entryPrice = s.normalizePrice(coin, rawEntry)

		if signalType == "counter_trend" && valVal > 0 && pocVal > 0 && entryPrice > 0 {
			targetSL := entryPrice * (1.0 - (slPct / 100.0))
			if valVal*0.992 < entryPrice {
				targetSL = math.Min(targetSL, valVal*0.992)
			}
			slPrice = s.normalizePrice(coin, targetSL)
			if slPrice > 0 && slPrice < entryPrice {
				slPct = math.Round(((entryPrice-slPrice)/entryPrice)*10000.0) / 100.0
			}
			targetTP := entryPrice * (1.0 + (tpPct / 100.0))
			if pocVal > entryPrice {
				targetTP = math.Max(targetTP, pocVal)
			}
			tpPrice = s.normalizePrice(coin, targetTP)
			if tpPrice > entryPrice {
				tpPct = math.Round(((tpPrice-entryPrice)/entryPrice)*10000.0) / 100.0
			}
		} else {
			tpPrice = s.normalizePrice(coin, entryPrice*(1.0+(tpPct/100.0)))
			slPrice = s.normalizePrice(coin, entryPrice*(1.0-(slPct/100.0)))
		}
	} else if action == "SELL" {
		rawEntry := analysis.MidPrice
		switch tf {
		case "scalp":
			if analysis.BestAsk > 0 {
				rawEntry = analysis.BestAsk
			}
		case "swing":
			if analysis.MidPrice > 0 {
				rawEntry = analysis.MidPrice * 1.0025 // +0.25% bounce limit entry
			}
		default: // intraday
			if analysis.SuggestedLimitPrice > 0 && analysis.BestBid > 0 && analysis.SuggestedLimitPrice >= analysis.BestBid {
				rawEntry = analysis.SuggestedLimitPrice
			} else if analysis.BestAsk > 0 {
				rawEntry = analysis.BestAsk
			}
		}
		entryPrice = s.normalizePrice(coin, rawEntry)

		if signalType == "counter_trend" && vahVal > 0 && pocVal > 0 && entryPrice > 0 {
			targetSL := entryPrice * (1.0 + (slPct / 100.0))
			if vahVal*1.008 > entryPrice {
				targetSL = math.Max(targetSL, vahVal*1.008)
			}
			slPrice = s.normalizePrice(coin, targetSL)
			if slPrice > entryPrice {
				slPct = math.Round(((slPrice-entryPrice)/entryPrice)*10000.0) / 100.0
			}
			targetTP := entryPrice * (1.0 - (tpPct / 100.0))
			if pocVal > 0 && pocVal < entryPrice {
				targetTP = math.Min(targetTP, pocVal)
			}
			tpPrice = s.normalizePrice(coin, targetTP)
			if tpPrice > 0 && tpPrice < entryPrice {
				tpPct = math.Round(((entryPrice-tpPrice)/entryPrice)*10000.0) / 100.0
			}
		} else {
			tpPrice = s.normalizePrice(coin, entryPrice*(1.0-(tpPct/100.0)))
			slPrice = s.normalizePrice(coin, entryPrice*(1.0+(slPct/100.0)))
		}
	} else {
		// action == "HOLD"
		entryPrice = 0.0
		tpPrice = 0.0
		slPrice = 0.0
		tpPct = 0.0
		slPct = 0.0
		signalType = "neutral"
	}

	riskReward := 2.0
	if slPct > 0 {
		riskReward = math.Round((tpPct/slPct)*100.0) / 100.0
	}

	monthlyVah := 0.0
	monthlyVal := 0.0
	monthlyPoc := 0.0
	quarterlyVah := 0.0
	quarterlyVal := 0.0
	quarterlyPoc := 0.0

	s.stateMu.RLock()
	if cEntry, ok := s.macroCache[strings.ToUpper(coin)]; ok {
		if cEntry.monthlyVP != nil {
			monthlyVah = cEntry.monthlyVP.VAH
			monthlyVal = cEntry.monthlyVP.VAL
			monthlyPoc = cEntry.monthlyVP.POC
		}
		if cEntry.quarterlyVP != nil {
			quarterlyVah = cEntry.quarterlyVP.VAH
			quarterlyVal = cEntry.quarterlyVP.VAL
			quarterlyPoc = cEntry.quarterlyVP.POC
		}
	}
	s.stateMu.RUnlock()

	sig := &TradeSignal{
		Coin:                  analysis.Coin,
		Timeframe:             tf,
		EstimatedDuration:     estimatedDuration,
		Action:                action,
		SignalType:            signalType,
		MarketEnvironment:     marketEnv,
		Conviction:            analysis.DirectionConfidence,
		Score:                 analysis.ConfidenceScore,
		MidPrice:              analysis.MidPrice,
		EntryPrice:            entryPrice,
		TakeProfitPrice:       tpPrice,
		StopLossPrice:         slPrice,
		TakeProfitPct:         tpPct,
		StopLossPct:           slPct,
		RiskRewardRatio:       riskReward,
		ToxicRisk:             analysis.ToxicFlowRisk,
		SpreadBps:             analysis.SpreadBps,
		BookImbalance:         analysis.BookImbalance,
		WeightedBookImbalance: analysis.WeightedBookImbalance,
		MicroPriceDriftBps:    analysis.MicroPriceDriftBps,
		Reason:                reason,
		Timestamp:             time.Now().UTC().UnixMilli(),
		Model:                 analysis.Model,
		ATRPct:                analysis.ATRPct,
		MacroTrend:            analysis.MacroTrend,
		Change24h:             analysis.Change24h,
		VAH:                   vahVal,
		VAL:                   valVal,
		POC:                   pocVal,
		ProfileHorizon:        profileHz,
		MonthlyVAH:            monthlyVah,
		MonthlyVAL:            monthlyVal,
		MonthlyPOC:            monthlyPoc,
		QuarterlyVAH:          quarterlyVah,
		QuarterlyVAL:          quarterlyVal,
		QuarterlyPOC:          quarterlyPoc,
		DistFromTWAPPct:       distTwapVal,
		DistFrom365DPct:       distTwapVal,
		VisibilityLevel:       analysis.VisibilityLevel,
		SharedRetrieval:           analysis.SharedRetrieval,
		CacheReused:               false,
		IsToxicHalted:             isToxicHalted,
		ToxicHaltRemainingSeconds: toxicHaltRemainingSeconds,
	}

	if s.subgoalReg != nil {
		s.subgoalReg.CompleteSubgoal(subgoalKey, sig)
	}

	s.stateMu.Lock()
	s.lastSignals[stateKey] = sig
	s.stateMu.Unlock()

	return sig, nil
}

