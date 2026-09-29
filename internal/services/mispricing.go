package services

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	mispricingReferenceLookback = 2 * time.Hour
	mispricingRetryCooldown     = 5 * time.Minute
)

// MispricingEntry compares the current Hyperliquid mark with the final valid
// Hyperliquid 1m candle at the underlying venue's latest completed close.
type MispricingEntry struct {
	Coin           string  `json:"coin"`
	Dex            string  `json:"dex"`
	Exchange       string  `json:"exchange"`
	SessionState   string  `json:"sessionState"`
	SessionCloseMs int64   `json:"sessionCloseMs"`
	AsOfMs         int64   `json:"asOfMs"`
	MarkPx         float64 `json:"markPx"`
	ClosePx        float64 `json:"closePx"`
	DeviationPct   float64 `json:"deviationPct"`
	JevVerdict     string  `json:"jevVerdict,omitempty"`
	JevConfidence  float64 `json:"jevConfidence,omitempty"`
	JevAction      string  `json:"jevAction,omitempty"`
}

type mispricingCandidate struct {
	entry MispricingEntry
}

type mispricingReferenceKey struct {
	Coin           string
	SessionCloseMs int64
}

// MispricingReferenceCandle is the infrastructure-neutral candle shape used by
// the close resolver.
type MispricingReferenceCandle struct {
	OpenMs  int64
	CloseMs int64
	Close   string
}

// MispricingReferenceFetcher must use the server's budgeted background candle
// lane. The service adds per-key single-flight and a three-job cap.
type MispricingReferenceFetcher func(
	ctx context.Context,
	coin string,
	startMs, endMs int64,
) ([]MispricingReferenceCandle, error)

func (s *MarketDataService) SetMispricingReferenceFetcher(fetcher MispricingReferenceFetcher) {
	s.mispricingRefMu.Lock()
	s.mispricingRefFetcher = fetcher
	s.mispricingRefMu.Unlock()
}

// GetStockMispricings retains the established endpoint/service name for API
// compatibility. Its scope is every explicitly supported non-24/7 market.
func (s *MarketDataService) GetStockMispricings(ctx context.Context) ([]MispricingEntry, error) {
	return s.getStockMispricingsAt(ctx, s.mispricingNow())
}

// getStockMispricingsAt never waits for candle I/O. It serves only candidates
// whose keyed close reference has resolved and schedules all other references.
func (s *MarketDataService) getStockMispricingsAt(ctx context.Context, now time.Time) ([]MispricingEntry, error) {
	candidates, successfulDexes, err := s.collectMispricingCandidates(ctx, now)
	if err != nil && successfulDexes == 0 {
		if cached, ok := s.getCachedMispricings(); ok {
			return filterCachedMispricingsAt(cached, now), nil
		}
		return []MispricingEntry{}, nil
	}

	entries := make([]MispricingEntry, 0, len(candidates))
	for _, candidate := range candidates {
		key := referenceKey(candidate)
		if closePx, ok := s.getMispricingReference(key); ok {
			entry := candidate.entry
			entry.ClosePx = closePx
			entry.DeviationPct = (entry.MarkPx - closePx) / closePx * 100
			if math.Abs(entry.DeviationPct) >= 0.20 && s.jevService != nil && s.jevService.IsAvailable() {
				if v, vErr := s.jevService.EvaluateMispricing(ctx, entry.Coin, entry.MarkPx, closePx, entry.DeviationPct); vErr == nil && v != nil {
					entry.JevVerdict = v.Verdict
					entry.JevConfidence = v.Confidence
					entry.JevAction = v.Recommended
				}
			}
			entries = append(entries, entry)
			continue
		}
		s.scheduleMispricingReference(candidate, now)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return math.Abs(entries[i].DeviationPct) > math.Abs(entries[j].DeviationPct)
	})
	s.setCachedMispricings(entries)
	return entries, nil
}

func filterCachedMispricingsAt(entries []MispricingEntry, now time.Time) []MispricingEntry {
	filtered := make([]MispricingEntry, 0, len(entries))
	for _, entry := range entries {
		instrument, ok := MispricingInstrumentFor(entry.Coin)
		if !ok {
			continue
		}
		state, closeAt, covered := instrument.Session.StateAt(now)
		if !covered || state == SessionOpen || closeAt.UnixMilli() != entry.SessionCloseMs {
			continue
		}
		entry.SessionState = string(state)
		filtered = append(filtered, entry)
	}
	return filtered
}

func (s *MarketDataService) collectMispricingCandidates(
	ctx context.Context,
	now time.Time,
) ([]mispricingCandidate, int, error) {
	dexes := RegisteredMispricingDexes()
	out := make([]mispricingCandidate, 0, len(MispricingInstrumentRegistry()))
	successful := 0
	var firstErr error

	for _, dex := range dexes {
		if ctx.Err() != nil {
			return out, successful, ctx.Err()
		}
		ctxs, err := s.exchange.GetAssetCtxs(ctx, dex)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%s asset contexts: %w", dexLabel(dex), err)
			}
			continue
		}
		successful++
		for _, raw := range ctxs {
			ctxMap, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			coin := canonicalDexCoin(getStringField(ctxMap, "coin", "name"), dex)
			instrument, ok := MispricingInstrumentFor(coin)
			if !ok || !s.isRenderableMispricingCoin(coin) || !meetsLiquidityFloor(ctxMap) {
				continue
			}
			markPx, ok := parseInterfaceFloat(ctxMap["markPx"])
			if !ok || markPx <= 0 || math.IsNaN(markPx) || math.IsInf(markPx, 0) {
				continue
			}
			state, closeAt, covered := instrument.Session.StateAt(now)
			if !covered || state == SessionOpen {
				continue
			}
			out = append(out, mispricingCandidate{entry: MispricingEntry{
				Coin:           coin,
				Dex:            dex,
				Exchange:       instrument.Session.Exchange,
				SessionState:   string(state),
				SessionCloseMs: closeAt.UnixMilli(),
				AsOfMs:         now.UnixMilli(),
				MarkPx:         markPx,
			}})
		}
	}
	return out, successful, firstErr
}

// MispricingCandidateCoins returns eligible rows for ordinary clickable-chart
// warming without depending on whether a close reference has resolved.
func (s *MarketDataService) MispricingCandidateCoins(ctx context.Context) []string {
	candidates, _, _ := s.collectMispricingCandidates(ctx, s.mispricingNow())
	coins := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		coins = append(coins, candidate.entry.Coin)
	}
	return coins
}

// WarmMispricingReferences discovers eligible candidates independently, then
// schedules missing close references without waiting.
func (s *MarketDataService) WarmMispricingReferences(ctx context.Context) {
	now := s.mispricingNow()
	candidates, _, _ := s.collectMispricingCandidates(ctx, now)
	for _, candidate := range candidates {
		s.scheduleMispricingReference(candidate, now)
	}
}

func referenceKey(candidate mispricingCandidate) mispricingReferenceKey {
	return mispricingReferenceKey{
		Coin: candidate.entry.Coin, SessionCloseMs: candidate.entry.SessionCloseMs,
	}
}

func (s *MarketDataService) getMispricingReference(key mispricingReferenceKey) (float64, bool) {
	s.mispricingRefMu.Lock()
	defer s.mispricingRefMu.Unlock()
	v, ok := s.mispricingRefs[key]
	return v, ok
}

func (s *MarketDataService) scheduleMispricingReference(candidate mispricingCandidate, now time.Time) {
	key := referenceKey(candidate)
	s.mispricingRefMu.Lock()
	fetcher := s.mispricingRefFetcher
	_, resolved := s.mispricingRefs[key]
	inFlight := s.mispricingRefFlight[key]
	retryAfter := s.mispricingRetryAfter[key]
	if fetcher == nil || resolved || inFlight || (!retryAfter.IsZero() && now.Before(retryAfter)) {
		s.mispricingRefMu.Unlock()
		return
	}
	s.mispricingRefFlight[key] = true
	s.mispricingRefMu.Unlock()

	go s.resolveMispricingReference(s.backgroundContext(), key, fetcher)
}

func (s *MarketDataService) resolveMispricingReference(
	ctx context.Context,
	key mispricingReferenceKey,
	fetcher MispricingReferenceFetcher,
) {
	select {
	case s.mispricingRefSem <- struct{}{}:
	case <-ctx.Done():
		s.finishMispricingReference(key, 0, ctx.Err())
		return
	}
	defer func() { <-s.mispricingRefSem }()

	startMs := key.SessionCloseMs - mispricingReferenceLookback.Milliseconds()
	candles, err := fetcher(ctx, key.Coin, startMs, key.SessionCloseMs)
	if err == nil {
		var closePx float64
		closePx, err = selectSessionClosePrice(candles, key.SessionCloseMs)
		if err == nil {
			s.finishMispricingReference(key, closePx, nil)
			return
		}
	}
	s.finishMispricingReference(key, 0, err)
}

func (s *MarketDataService) finishMispricingReference(
	key mispricingReferenceKey,
	closePx float64,
	err error,
) {
	s.mispricingRefMu.Lock()
	defer s.mispricingRefMu.Unlock()
	delete(s.mispricingRefFlight, key)
	if err != nil {
		s.mispricingRetryAfter[key] = time.Now().Add(mispricingRetryCooldown)
		return
	}
	delete(s.mispricingRetryAfter, key)
	s.mispricingRefs[key] = closePx
	// One close per coin bounds the cache. The key still ensures a new session
	// can never reuse the prior session's reference.
	for cachedKey := range s.mispricingRefs {
		if cachedKey.Coin == key.Coin && cachedKey != key {
			delete(s.mispricingRefs, cachedKey)
		}
	}
}

// selectSessionClosePrice selects the latest valid 1m close whose candle ends
// at or before the venue boundary. A later candle is never a fallback.
func selectSessionClosePrice(
	candles []MispricingReferenceCandle,
	sessionCloseMs int64,
) (float64, error) {
	var (
		bestEnd int64
		bestPx  float64
	)
	for _, candle := range candles {
		endMs := candle.CloseMs
		if endMs <= 0 && candle.OpenMs > 0 {
			endMs = candle.OpenMs + time.Minute.Milliseconds()
		}
		if candle.OpenMs <= 0 || endMs <= candle.OpenMs || endMs > sessionCloseMs || endMs < bestEnd {
			continue
		}
		closePx, err := strconv.ParseFloat(strings.TrimSpace(candle.Close), 64)
		if err != nil || closePx <= 0 || math.IsNaN(closePx) || math.IsInf(closePx, 0) {
			continue
		}
		bestEnd, bestPx = endMs, closePx
	}
	if bestEnd == 0 {
		return 0, fmt.Errorf("no valid 1m candle ending at or before session close %d", sessionCloseMs)
	}
	return bestPx, nil
}

// isRenderableMispricingCoin uses the canonical metadata cache as the backend
// rendering contract. Tests and specialized service construction may omit it.
func (s *MarketDataService) isRenderableMispricingCoin(coin string) bool {
	if s.metadataCache == nil {
		return true
	}
	if membership, ok := s.metadataCache.(interface{ Has(string) bool }); ok && !membership.Has(coin) {
		return false
	}
	return s.metadataCache.GetMaxLeverage(coin) > 0
}

func canonicalDexCoin(coin, dex string) string {
	coin = strings.TrimSpace(coin)
	dex = strings.ToLower(strings.TrimSpace(dex))
	if coin == "" {
		return ""
	}
	if strings.Contains(coin, ":") || dex == "" {
		return coin
	}
	return dex + ":" + coin
}

func dexLabel(dex string) string {
	if dex == "" {
		return "default"
	}
	return dex
}

func (s *MarketDataService) getCachedMispricings() ([]MispricingEntry, bool) {
	s.mispricingMu.RLock()
	defer s.mispricingMu.RUnlock()
	if s.mispricingAt.IsZero() || time.Since(s.mispricingAt) > 10*time.Minute {
		return nil, false
	}
	cached := make([]MispricingEntry, len(s.mispricingCache))
	copy(cached, s.mispricingCache)
	return cached, true
}

func (s *MarketDataService) setCachedMispricings(entries []MispricingEntry) {
	cp := make([]MispricingEntry, len(entries))
	copy(cp, entries)
	s.mispricingMu.Lock()
	s.mispricingCache = cp
	s.mispricingAt = time.Now()
	s.mispricingMu.Unlock()
}
