package websocket

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// coinFlowEntry owns independent bounded, timestamp-ordered rolling samples.
// ALL retains the latest flowSampleCapacity valid prints; WHALE runs the same
// algorithm over prints that meet whaleFlowThreshold.
type coinFlowEntry struct {
	all      rollingFlowWindow
	whale    rollingFlowWindow
	revision uint64
}

type rollingFlowWindow struct {
	buyVol         float64
	sellVol        float64
	regularBuyVol  float64
	regularSellVol float64
	trades         []flowTrade
	seen           tradeIdentityFIFO
	// live is the set of keys currently in trades. Arrival-order FIFO can wrap
	// while an out-of-order print is still in the time-ordered sample; live
	// prevents that identity from being forgotten or inserted twice.
	live map[string]struct{}
}

type flowTrade struct {
	key      string
	timeMs   int64
	notional float64
	isBuy    bool
	isWhale  bool
}

type coinFlowSnapshot struct {
	buyVol            float64
	sellVol           float64
	regularBuyVol     float64
	regularSellVol    float64
	whaleBuyVol       float64
	whaleSellVol      float64
	sampleCount       int
	oldestTimeMs      int64
	newestTimeMs      int64
	whaleSampleCount  int
	whaleOldestTimeMs int64
	whaleNewestTimeMs int64
	revision          uint64
}

type tradeIdentityFIFO struct {
	seen  map[string]struct{}
	order []string
}

const (
	whaleHaloHalfLifeMs = 180_000.0 // recent-whale DOM halo only
	flowThreshold       = 0.0       // ALL includes every valid public print
	whaleThreshold      = 100_000.0 // minimum trade USD value for DOM whale visuals
	whaleFlowThreshold  = 100_000.0 // minimum trade USD value for the top WHALE flow meter
	majorWhaleThreshold = 250_000.0 // visually distinct major-whale tier
	flowSampleCapacity  = 500       // rolling public-print sample behind FLOW only
	maxFlowSeenKeys     = 1200      // comfortably beyond the rolling sample and relay replay window
)

func (m *WebSocketManager) armCoinFlow(coin string) {
	if coin == "" {
		return
	}
	m.coinFlowMu.Lock()
	if _, exists := m.coinFlowCache[coin]; !exists {
		// A fresh empty window is a real transition. Stamp it so a subscribe
		// hydration cannot lose to a leftover browser revision from the last
		// time this coin was armed.
		m.flowRevision++
		m.coinFlowCache[coin] = &coinFlowEntry{revision: m.flowRevision}
	}
	m.coinFlowMu.Unlock()
}

func (m *WebSocketManager) clearCoinFlow(coin string) {
	m.coinFlowMu.Lock()
	if _, exists := m.coinFlowCache[coin]; exists {
		// The empty snapshot after final unsubscribe is a real state transition.
		// Give it a tombstone revision newer than the removed sample so a current
		// HTTP hydration can clear a browser cache without being rejected as old.
		m.flowRevision++
	}
	delete(m.coinFlowCache, coin)
	m.coinFlowMu.Unlock()
}

// annotateTradesMessage applies the batch to the rolling windows and splices
// the snapshot taken under the same lock, so a concurrent final-unsubscribe
// cannot publish an empty newer _flow for the prints this frame just inserted.
func (m *WebSocketManager) annotateTradesMessage(wsMsg map[string]interface{}, raw []byte) []byte {
	snapshot := m.updateFlowFromTrades(wsMsg)
	if snapshot == nil {
		return raw
	}
	return spliceTopLevelAnnotation(raw, map[string]interface{}{"_flow": flowPayload(snapshot)})
}

// spliceTopLevelAnnotation inserts the marshaled annotation map as extra
// top-level keys just before the closing '}' of raw, avoiding a full re-marshal.
func spliceTopLevelAnnotation(raw []byte, annotation map[string]interface{}) []byte {
	if len(annotation) == 0 {
		return raw
	}
	fragmentBytes, err := json.Marshal(annotation)
	if err != nil {
		return raw
	}
	// fragmentBytes is like {"_flow":{...}}; we need the inner content only.
	inner := fragmentBytes[1 : len(fragmentBytes)-1]

	lastBrace := len(raw) - 1
	for lastBrace >= 0 && raw[lastBrace] != '}' {
		lastBrace--
	}
	if lastBrace <= 0 {
		return raw
	}

	result := make([]byte, 0, len(raw)+len(inner)+1)
	result = append(result, raw[:lastBrace]...)
	result = append(result, ',')
	result = append(result, inner...)
	result = append(result, '}')
	return result
}

func copyFlowSnapshot(entry *coinFlowEntry, tombstoneRevision uint64) coinFlowSnapshot {
	if entry == nil {
		return coinFlowSnapshot{revision: tombstoneRevision}
	}
	snapshot := coinFlowSnapshot{
		buyVol:           entry.all.buyVol,
		sellVol:          entry.all.sellVol,
		regularBuyVol:    entry.all.regularBuyVol,
		regularSellVol:   entry.all.regularSellVol,
		whaleBuyVol:      entry.whale.buyVol,
		whaleSellVol:     entry.whale.sellVol,
		sampleCount:      len(entry.all.trades),
		whaleSampleCount: len(entry.whale.trades),
		revision:         entry.revision,
	}
	if n := len(entry.all.trades); n > 0 {
		snapshot.oldestTimeMs = entry.all.trades[0].timeMs
		snapshot.newestTimeMs = entry.all.trades[n-1].timeMs
	}
	if n := len(entry.whale.trades); n > 0 {
		snapshot.whaleOldestTimeMs = entry.whale.trades[0].timeMs
		snapshot.whaleNewestTimeMs = entry.whale.trades[n-1].timeMs
	}
	return snapshot
}

// flowSnapshot returns a value copy under the flow lock. Callers never retain
// a pointer that final-unsubscribe can concurrently invalidate.
func (m *WebSocketManager) flowSnapshot(coin string) *coinFlowSnapshot {
	m.coinFlowMu.Lock()
	defer m.coinFlowMu.Unlock()
	snapshot := copyFlowSnapshot(m.coinFlowCache[coin], m.flowRevision)
	return &snapshot
}

func flowPayload(snapshot *coinFlowSnapshot) map[string]interface{} {
	if snapshot == nil {
		snapshot = &coinFlowSnapshot{}
	}
	return map[string]interface{}{
		"whaleHaloHalfLifeMs":    whaleHaloHalfLifeMs,
		"flowThresholdUsd":       flowThreshold,
		"whaleThresholdUsd":      whaleThreshold,
		"whaleFlowThresholdUsd":  whaleFlowThreshold,
		"majorWhaleThresholdUsd": majorWhaleThreshold,
		"sampleCount":            snapshot.sampleCount,
		"sampleCapacity":         flowSampleCapacity,
		"oldestTimeMs":           snapshot.oldestTimeMs,
		"newestTimeMs":           snapshot.newestTimeMs,
		"whaleSampleCount":       snapshot.whaleSampleCount,
		"whaleSampleCapacity":    flowSampleCapacity,
		"whaleOldestTimeMs":      snapshot.whaleOldestTimeMs,
		"whaleNewestTimeMs":      snapshot.whaleNewestTimeMs,
		"revision":               snapshot.revision,
		"regularBuyVol":          snapshot.regularBuyVol,
		"regularSellVol":         snapshot.regularSellVol,
		"buyVol":                 snapshot.buyVol,
		"sellVol":                snapshot.sellVol,
		"whaleBuyVol":            snapshot.whaleBuyVol,
		"whaleSellVol":           snapshot.whaleSellVol,
	}
}

func (m *WebSocketManager) flowSnapshotPayload(coin string) map[string]interface{} {
	return flowPayload(m.flowSnapshot(coin))
}

func (window *rollingFlowWindow) rememberTrade(key string) bool {
	if window.seen.seen == nil {
		window.seen.seen = make(map[string]struct{})
	}
	if _, exists := window.seen.seen[key]; exists {
		return false
	}
	window.seen.seen[key] = struct{}{}
	window.seen.order = append(window.seen.order, key)
	window.forgetExpiredIdentities()
	return true
}

func (window *rollingFlowWindow) forgetExpiredIdentities() {
	overflow := len(window.seen.order) - maxFlowSeenKeys
	if overflow <= 0 {
		return
	}
	dst := 0
	dropped := 0
	for _, key := range window.seen.order {
		if dropped < overflow {
			if _, still := window.live[key]; !still {
				delete(window.seen.seen, key)
				dropped++
				continue
			}
		}
		window.seen.order[dst] = key
		dst++
	}
	window.seen.order = window.seen.order[:dst]
}

func (window *rollingFlowWindow) addTrade(trade flowTrade) bool {
	if window.live == nil {
		window.live = make(map[string]struct{}, flowSampleCapacity)
	}
	if _, exists := window.live[trade.key]; exists {
		return false
	}
	if !window.rememberTrade(trade.key) {
		return false
	}
	index := sort.Search(len(window.trades), func(index int) bool {
		candidate := window.trades[index]
		return candidate.timeMs > trade.timeMs ||
			(candidate.timeMs == trade.timeMs && candidate.key >= trade.key)
	})
	window.trades = append(window.trades, flowTrade{})
	copy(window.trades[index+1:], window.trades[index:])
	window.trades[index] = trade
	window.live[trade.key] = struct{}{}
	if trade.isBuy {
		window.buyVol += trade.notional
	} else {
		window.sellVol += trade.notional
	}
	if !trade.isWhale {
		if trade.isBuy {
			window.regularBuyVol += trade.notional
		} else {
			window.regularSellVol += trade.notional
		}
	}
	if len(window.trades) > flowSampleCapacity {
		evicted := window.trades[0]
		window.trades = window.trades[1:]
		delete(window.live, evicted.key)
		if evicted.isBuy {
			window.buyVol -= evicted.notional
		} else {
			window.sellVol -= evicted.notional
		}
		if !evicted.isWhale {
			if evicted.isBuy {
				window.regularBuyVol -= evicted.notional
			} else {
				window.regularSellVol -= evicted.notional
			}
		}
	}
	return true
}

func jsonScalarString(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(typed)
	}
}

// updateFlowFromTrades maintains the latest flowSampleCapacity public prints
// by exchange timestamp, with O(1) totals and bounded O(n) ordered insertion.
// The snapshot is taken under the same lock as the mutation so annotate cannot
// observe a concurrent tombstone for this batch. A coin with no armed cache
// (final unsubscribe) is ignored so in-flight frames cannot resurrect it.
func (m *WebSocketManager) updateFlowFromTrades(wsMsg map[string]interface{}) *coinFlowSnapshot {
	trades, ok := wsMsg["data"].([]interface{})
	if !ok || len(trades) == 0 {
		return nil
	}

	coin := ""
	if first, ok := trades[0].(map[string]interface{}); ok {
		coin, _ = first["coin"].(string)
		if coin == "" {
			coin, _ = first["s"].(string)
		}
	}
	if coin == "" {
		return nil
	}

	m.coinFlowMu.Lock()
	defer m.coinFlowMu.Unlock()
	entry := m.coinFlowCache[coin]
	if entry == nil {
		snapshot := copyFlowSnapshot(nil, m.flowRevision)
		return &snapshot
	}
	occurrences := make(map[string]int, len(trades))
	changed := false

	for _, t := range trades {
		trade, ok := t.(map[string]interface{})
		if !ok {
			continue
		}
		pxStr, _ := trade["px"].(string)
		szStr, _ := trade["sz"].(string)
		timeKey := jsonScalarString(trade["time"])
		sideKey := jsonScalarString(trade["side"])
		fingerprint := timeKey + ":" + pxStr + ":" + szStr + ":" + sideKey
		tid := jsonScalarString(trade["tid"])
		key := ""
		if tid != "" {
			key = "tid:" + tid
		} else if hash := strings.TrimSpace(jsonScalarString(trade["hash"])); hash != "" {
			key = "hash:" + hash + ":" + fingerprint
		} else {
			occurrence := occurrences[fingerprint]
			occurrences[fingerprint] = occurrence + 1
			key = fmt.Sprintf("fallback:%s:%d", fingerprint, occurrence)
		}
		px, err1 := strconv.ParseFloat(pxStr, 64)
		sz, err2 := strconv.ParseFloat(szStr, 64)
		if err1 != nil || err2 != nil || px <= 0 || sz <= 0 {
			continue
		}
		timeValue, _ := strconv.ParseFloat(timeKey, 64)
		val := px * sz
		side, _ := trade["side"].(string)
		flow := flowTrade{
			key: key, timeMs: int64(timeValue), notional: val,
			isBuy: side == "B", isWhale: val >= whaleFlowThreshold,
		}
		if val >= flowThreshold && entry.all.addTrade(flow) {
			changed = true
		}
		if val >= whaleFlowThreshold && entry.whale.addTrade(flow) {
			changed = true
		}
	}
	if changed {
		m.flowRevision++
		entry.revision = m.flowRevision
	}
	snapshot := copyFlowSnapshot(entry, m.flowRevision)
	return &snapshot
}
