package candlecache

import (
	"context"
	"fmt"
	"log"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

// PrepareChartRequirements registers a chart's complete dependency set before
// snapshot restore. Existing snapshot rows then hydrate these deterministic
// registrations instead of registration order deciding which dependencies
// exist.
func (s *Store) PrepareChartRequirements(coin, timeframe string) {
	if s == nil || coin == "" {
		return
	}
	for _, requirement := range chartrequirements.SeriesForChart(timeframe) {
		s.registerOnDemand(coin, requirement.Interval, requirement.LookbackMs)
	}
}

// PrepareStartupUniverse registers every market × startup timeframe dependency
// before snapshot decode so permanent-feed priority and restore targets are
// deterministic across the admit + remainder sets.
func (s *Store) PrepareStartupUniverse(coins []string) {
	if s == nil {
		return
	}
	// Fill the 64 permanent live-feed slots with landing-chart 2h + CVD
	// sources first. Remainder TFs (1h/4h/15m) register after so they cannot
	// spend the cap on the first ~10 pinned names.
	for _, coin := range coins {
		if coin == "" {
			continue
		}
		s.PrepareChartRequirements(coin, chartrequirements.DefaultTimeframe)
	}
	for _, coin := range coins {
		if coin == "" {
			continue
		}
		for _, tf := range chartrequirements.RemainderStartupTimeframes() {
			s.PrepareChartRequirements(coin, tf)
		}
	}
}

// EnsureChartReady resolves and verifies the display history and every
// indicator-source dependency declared for a chart. It is intentionally a
// blocking startup operation; request handlers must never call it.
//
// History readiness does not require live-tail trust (`degraded`). A restored
// series with full coverage and no unverified gap is ready without REST; the
// live edge heals via WS tick, passthrough, or a non-blocking tail repair.
func (s *Store) EnsureChartReady(ctx context.Context, coin, timeframe string) error {
	if s == nil || coin == "" {
		return nil
	}
	requirements := chartrequirements.SeriesForChart(timeframe)
	if len(requirements) == 0 {
		return fmt.Errorf("unsupported chart timeframe %q", timeframe)
	}
	s.PrepareChartRequirements(coin, timeframe)

	if err := s.waitMarketWS(ctx); err != nil {
		return err
	}

	// Source histories first: once the display series is ready, the complete
	// dependency set is immediately capable of enriching it.
	for i := 1; i < len(requirements); i++ {
		if err := s.ensureSeriesReady(ctx, coin, requirements[i]); err != nil {
			return err
		}
	}
	if err := s.ensureSeriesReady(ctx, coin, requirements[0]); err != nil {
		return err
	}
	return nil
}

func (s *Store) waitMarketWS(ctx context.Context) error {
	if s.isWSConnected() {
		return nil
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for !s.isWSConnected() {
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for market websocket: %w", ctx.Err())
		case <-ticker.C:
		}
	}
	return nil
}

func (s *Store) ensureSeriesReady(ctx context.Context, coin string, requirement chartrequirements.SeriesRequirement) error {
	ser := s.registerOnDemand(coin, requirement.Interval, requirement.LookbackMs)
	if ser == nil {
		return fmt.Errorf("register chart series %s|%s", coin, requirement.Interval)
	}
	ser.lastNeededMs.Store(time.Now().UnixMilli())

	// The websocket can advance a restored series while its REST repair is in
	// flight. That deliberately changes gapGen, causing applyVerifiedRange to
	// preserve the newer gap. Re-inspect and repair that range instead of
	// treating the conservative first apply as a fatal startup failure.
	const maxConvergenceAttempts = 4
	attempts := 0
	for attempt := 0; attempt < maxConvergenceAttempts; attempt++ {
		attempts++
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("hydrate chart series %s|%s: %w", coin, requirement.Interval, err)
		}

		nowMs := time.Now().UnixMilli()
		ser.mu.RLock()
		ready := seriesHistoryReadyLocked(ser, requirement.LookbackMs, nowMs)
		degraded := ser.degraded
		startMs := nowMs - chartrequirements.ReachableLookbackMs(requirement.Interval, requirement.LookbackMs)
		fullCoverageFetch := ser.coverageStartMs == 0 || ser.coverageStartMs > startMs
		genAtStart := ser.gapGen
		if !fullCoverageFetch {
			switch {
			case ser.unverifiedGapFromMs > 0:
				startMs = ser.unverifiedGapFromMs
			case len(ser.candles) > 0:
				startMs = ser.candles[len(ser.candles)-1].OpenMs - ser.intervalMs
			}
		}
		ser.mu.RUnlock()
		if ready {
			// History is complete. Live-tail distrust does not block readiness.
			// When the live edge is already fresh (recent verifiedThrough from a
			// snapshot save, or a recent last candle), skip work. Otherwise
			// schedule one non-blocking tail verify so live-edge serves soon.
			if degraded {
				nowMs := time.Now().UnixMilli()
				ser.mu.RLock()
				liveFresh := requestIsHistoricalOrTailFresh(ser.candles, ser.intervalMs, ser.verifiedThroughMs, nowMs, nowMs)
				ser.mu.RUnlock()
				if !liveFresh {
					go s.scheduleTailRepair(coin, requirement.Interval)
				}
			}
			return nil
		}
		if startMs <= 0 || startMs >= nowMs {
			startMs = nowMs - 3*ser.intervalMs
		}

		// Startup hydration uses the normal shared budget and fetch semaphore. It
		// may take longer, but it cannot burst the upstream merely because no chart
		// requests are admitted yet.
		candles, err := s.fetchChunked(ctx, coin, requirement.Interval, startMs, nowMs)
		if err != nil {
			return fmt.Errorf("hydrate chart series %s|%s: %w", coin, requirement.Interval, err)
		}
		s.applyVerifiedRange(ser, candles, startMs, nowMs, genAtStart, fullCoverageFetch)

		ser.mu.RLock()
		ready = seriesHistoryReadyLocked(ser, requirement.LookbackMs, time.Now().UnixMilli())
		currentGapGen := ser.gapGen
		ser.mu.RUnlock()
		if ready {
			return nil
		}
		if currentGapGen == genAtStart {
			// A stable REST result that is still unready (for example, a market
			// with no retained candles) will not improve by repeating the same
			// upstream request.
			break
		}
	}

	ser.mu.RLock()
	coverageStartMs := ser.coverageStartMs
	gapFromMs := ser.unverifiedGapFromMs
	gapGen := ser.gapGen
	degraded := ser.degraded
	candleCount := len(ser.candles)
	ser.mu.RUnlock()
	return fmt.Errorf(
		"chart series remains unready after %d hydration attempts: %s|%s coverageStart=%d candles=%d degraded=%t gapFrom=%d gapGen=%d",
		attempts, coin, requirement.Interval, coverageStartMs, candleCount, degraded, gapFromMs, gapGen,
	)
}

// scheduleTailRepair issues one budget-paced present-reaching fetch for a
// history-ready but live-untrusted series. Non-blocking; single-flighted via
// the warm map when possible through repairOnDemand.
func (s *Store) scheduleTailRepair(coin, interval string) {
	if s == nil || s.lifecycleCtx == nil {
		return
	}
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return
	}
	ser.mu.RLock()
	if !ser.degraded || ser.unverifiedGapFromMs != 0 || len(ser.candles) == 0 {
		ser.mu.RUnlock()
		return
	}
	fromMs := ser.candles[len(ser.candles)-1].OpenMs - ser.intervalMs
	if ser.verifiedThroughMs > 0 && ser.verifiedThroughMs-ser.intervalMs < fromMs {
		fromMs = ser.verifiedThroughMs - ser.intervalMs
	}
	ser.mu.RUnlock()
	if fromMs <= 0 {
		return
	}
	s.repairOnDemand(coin, interval, fromMs)
}

// applyVerifiedRange differs from passthrough bookkeeping: fetchChunked has
// explicitly queried every chunk in the requested range, so an empty old chunk
// proves the exchange's retention boundary instead of indicating head
// truncation. It is therefore safe to record the requested coverage start.
func (s *Store) applyVerifiedRange(ser *series, candles []Candle, startMs, endMs int64, genAtStart uint64, fullCoverageFetch bool) {
	s.applyRange(ser, candles, startMs, endMs, genAtStart, fullCoverageFetch, false)
}

// seriesHistoryReadyLocked reports that lookback coverage is present and there
// is no unverified hole. It deliberately ignores `degraded`: live-tail trust is
// a serve-path concern (historical ranges serve; live edge waits for tick/REST).
//
// Declared lookbacks that exceed Hyperliquid's 5000-candle retention (15m/30m
// 190d, 5m 20d) are satisfied once coverage reaches that cap. Restored cap-complete
// CVD sources must not force another universe REST pass on every boot.
func seriesHistoryReadyLocked(ser *series, lookbackMs, nowMs int64) bool {
	if ser == nil || ser.coverageStartMs == 0 || len(ser.candles) == 0 || ser.unverifiedGapFromMs != 0 {
		return false
	}
	return coverageReachesLookback(ser.coverageStartMs, ser.interval, lookbackMs, nowMs)
}

// seriesRequirementReadyLocked is retained for tests and call sites that want
// the stricter post-heal predicate (history + live trust).
func seriesRequirementReadyLocked(ser *series, lookbackMs, nowMs int64) bool {
	if !seriesHistoryReadyLocked(ser, lookbackMs, nowMs) {
		return false
	}
	return !ser.degraded
}

// EnsureChartUniverse blocks until the given display charts and their indicator
// dependencies are history-ready for every supplied market.
//
// Timeframe selection:
//   - "" or chartrequirements.DefaultTimeframe → admit set: default TF only
//     (landing chart + CVD sources). Used for /readyz.
//   - "startup" → full chartrequirements.StartupTimeframes (2h/1h/4h/15m)
//   - any other non-empty value → that single timeframe
//
// Caller coin order is retained so liquidity/pinned priority is not lost.
func (s *Store) EnsureChartUniverse(ctx context.Context, coins []string, timeframe string) error {
	unique := make(map[string]struct{}, len(coins))
	ordered := make([]string, 0, len(coins))
	for _, coin := range coins {
		if coin == "" {
			continue
		}
		if _, exists := unique[coin]; exists {
			continue
		}
		unique[coin] = struct{}{}
		ordered = append(ordered, coin)
	}
	timeframes := admitTimeframes(timeframe)
	if err := s.waitMarketWS(ctx); err != nil {
		return err
	}
	started := time.Now()
	succeeded := 0
	var lastErr error
	for i, coin := range ordered {
		coinReady := true
		for _, tf := range timeframes {
			if err := s.EnsureChartReady(ctx, coin, tf); err != nil {
				log.Printf("candlecache: startup chart readiness skipped %d/%d %s %s: %v", i+1, len(ordered), coin, tf, err)
				lastErr = err
				coinReady = false
				continue
			}
		}
		if coinReady {
			succeeded++
		}
		if (i+1)%10 == 0 || i+1 == len(ordered) {
			log.Printf("candlecache: startup chart readiness %d/%d markets (tfs=%v ready=%d)", i+1, len(ordered), timeframes, succeeded)
		}
	}
	if succeeded == 0 && lastErr != nil {
		return fmt.Errorf("startup chart readiness failed for every market: %w", lastErr)
	}
	log.Printf("candlecache: startup chart histories ready markets=%d/%d timeframes=%v duration=%s", succeeded, len(ordered), timeframes, time.Since(started).Round(time.Second))
	return nil
}



func admitTimeframes(timeframe string) []string {
	switch timeframe {
	case "", chartrequirements.DefaultTimeframe:
		return []string{chartrequirements.DefaultTimeframe}
	case "startup":
		return append([]string(nil), chartrequirements.StartupTimeframes...)
	default:
		return []string{timeframe}
	}
}


