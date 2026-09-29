package candlecache

import (
	"context"
	"os"
	"sort"
	"strconv"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

const dayMs = int64(24 * 60 * 60 * 1000) // retained for package-local fetch tests

// SeriesSpec pairs an interval with how much history the dashboard needs.
// Lookbacks mirror web/src/chart/chart-history-requirements.js with margin.
// The dedicated 4h RVWAP source carries 600d: 495d for the 90D preset's
// deviation window plus the initial 90d viewport and 15d of state margin.
// Other 15m-8h and 1d display series retain the 190d indicator-stable
// chart-history contract (clamped to Hyperliquid retention per interval).
// CVD deltas are computed server-side from the 5m & 30m
// series; those lookbacks are covered by the same 190d/20d windows above.
// NOTE upstream retention: Hyperliquid keeps only ~5000 candles per
// interval, so the REAL obtainable depth is ~17.4d of 5m, ~52d of 15m, ~104d
// of 30m — requesting deeper ranges just returns what exists (which is why
// the deep CVD leg is 30m, the deepest sub-hour granularity that can cover
// 3+ months). The 15m series backs the 15m chart itself (declared 190d,
// clamped to the ~52d cap).
type SeriesSpec struct {
	Interval   string
	LookbackMs int64
}

// DefaultSeries order is the warm-up order for the long tail of coins:
// the 1h-8h price charts the user actually trades first, then the cheap 1d,
// then the heavy CVD-source series, and finally the cheap deep-history 1w/1M.
// The 1w/1M lookbacks are long but only ~100 candles each (≈20 weight), so they
// sit last as the lowest-priority warm — they back the long-horizon charts and
// the market-radar regime's 1w read.
var DefaultSeries = func() []SeriesSpec {
	requirements := chartrequirements.All()
	out := make([]SeriesSpec, 0, len(requirements))
	for _, requirement := range requirements {
		out = append(out, SeriesSpec{Interval: requirement.Timeframe, LookbackMs: requirement.LookbackMs})
	}
	return out
}()

// deepIntervals are the cheap long-history timeframes the warm coordinator
// warms last (Tier 2): ~100 candles each, backing the long-horizon charts and
// the market-radar regime's 1w read. Everything else in DefaultSeries is an
// interactive chart timeframe warmed first (Tier 1).
var deepIntervals = map[string]bool{"1w": true, "1M": true}

// CoreIntervals returns the interactive chart timeframes from DefaultSeries (the
// Tier-1 warm set), in warm order. DefaultSeries stays the single source of
// truth for which intervals and lookbacks the store carries.
func CoreIntervals() []string {
	out := make([]string, 0, len(DefaultSeries))
	for _, spec := range DefaultSeries {
		if !deepIntervals[spec.Interval] {
			out = append(out, spec.Interval)
		}
	}
	return out
}

// DeepIntervals returns the cheap long-history timeframes from DefaultSeries
// (the Tier-3 warm set), in warm order.
func DeepIntervals() []string {
	out := make([]string, 0, len(deepIntervals))
	for _, spec := range DefaultSeries {
		if deepIntervals[spec.Interval] {
			out = append(out, spec.Interval)
		}
	}
	return out
}

// Config tunes ticker selection and warm-up pacing.
type Config struct {
	Enabled          bool
	OIMinUSD         float64 // notional open-interest cutoff for non-pinned coins
	MaxCoins         int     // hard cap on selected coins (pinned always kept)
	WeightPerMin     int     // self-managed REST weight budget for warm-up/backfill
	SnapshotInterval time.Duration
	// SnapshotFile is where the store persists itself across restarts (see
	// persist.go). Empty disables persistence.
	SnapshotFile string
}

func ConfigFromEnv() Config {
	cfg := Config{
		Enabled:  os.Getenv("PEZ_CANDLE_PRELOAD") != "0" && os.Getenv("PEZ_CANDLE_PRELOAD") != "false",
		OIMinUSD: 30e6,
		MaxCoins: 60,
		// Background warm budget, under Hyperliquid's ~1200 weight/min per-IP
		// limit. Interactive chart loads that miss the warm store passthrough to
		// HL without waiting on this budget, so during the initial warm pass an
		// aggressive flip through still-cold tickers can briefly collide with the
		// coordinator and get 429'd. That is tolerated: both sides self-heal (a
		// 429'd passthrough still kicks a budget-paced WarmOnDemand so the retry
		// serves warm, and the client auto-retries a blank chart after a short
		// cooldown). Raising this warms faster but widens that collision window;
		// lower it if external IP-sharing causes sustained 429s past cold-start.
		// Slightly higher default than the historical 600 so the expanded
		// startup timeframe set (2h/1h/4h/15m + CVD sources) finishes sooner
		// while still leaving headroom under Hyperliquid's ~1200/min IP budget.
		WeightPerMin: 800,
		// Persist the store across restarts so a relaunch resumes warm (the
		// restored series heal through the same path as a WS outage) instead
		// of re-fetching the whole warm set — which is what made cold starts
		// collide with interactive chart loads. PEZ_CANDLE_SNAPSHOT=0
		// disables; PEZ_CANDLE_SNAPSHOT_FILE overrides the location.
		SnapshotFile:     "data/candle-snapshot.json.gz",
		SnapshotInterval: DefaultSnapshotInterval,
	}
	if os.Getenv("PEZ_CANDLE_SNAPSHOT") == "0" || os.Getenv("PEZ_CANDLE_SNAPSHOT") == "false" {
		cfg.SnapshotFile = ""
	} else if v := os.Getenv("PEZ_CANDLE_SNAPSHOT_FILE"); v != "" {
		cfg.SnapshotFile = v
	}
	if v, err := time.ParseDuration(os.Getenv("PEZ_CANDLE_SNAPSHOT_INTERVAL")); err == nil && v >= 5*time.Minute {
		cfg.SnapshotInterval = v
	}
	if v, err := strconv.ParseFloat(os.Getenv("PEZ_CANDLE_PRELOAD_OI_MIN"), 64); err == nil && v > 0 {
		cfg.OIMinUSD = v
	}
	if v, err := strconv.Atoi(os.Getenv("PEZ_CANDLE_PRELOAD_MAX_COINS")); err == nil && v > 0 {
		cfg.MaxCoins = v
	}
	if v, err := strconv.Atoi(os.Getenv("PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN")); err == nil && v > 0 {
		cfg.WeightPerMin = v
	}
	return cfg
}

// SelectCoins returns pinned coins (always, in order — several pinned xyz
// tabs sit below any sensible OI cutoff) followed by the remaining coins
// with OI notional >= oiMinUSD, highest first, capped at maxCoins.
func SelectCoins(rows []CoinLiquidity, pinned []string, oiMinUSD float64, maxCoins int) []string {
	selected := make([]string, 0, maxCoins)
	seen := make(map[string]bool, maxCoins)
	for _, coin := range pinned {
		if coin == "" || seen[coin] {
			continue
		}
		seen[coin] = true
		selected = append(selected, coin)
	}

	sorted := append([]CoinLiquidity(nil), rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].OINotional > sorted[j].OINotional })
	for _, row := range sorted {
		if len(selected) >= maxCoins {
			break
		}
		if row.OINotional < oiMinUSD || seen[row.Coin] {
			continue
		}
		seen[row.Coin] = true
		selected = append(selected, row.Coin)
	}
	return selected
}

// defaultLookbackByInterval mirrors DefaultSeries so on-demand registration of
// off-list coins picks the same history depth the preloader uses.
var defaultLookbackByInterval = func() map[string]int64 {
	m := make(map[string]int64, len(DefaultSeries))
	for _, spec := range DefaultSeries {
		m[spec.Interval] = spec.LookbackMs
	}
	return m
}()

// lookbackForInterval returns the post-admit background depth for an interval,
// or 0 for intervals outside DefaultSeries (the caller falls back to the
// request's own span). Display readiness still uses the shorter chart
// requirement; this is what WarmOnDemand / new registrations fill toward.
func lookbackForInterval(interval string) int64 {
	if ext := chartrequirements.ExtendedLookbackMs(interval); ext > 0 {
		return ext
	}
	return defaultLookbackByInterval[interval]
}

// displayLookbackForInterval is the first-paint chart window. Coordinator
// fills this for movers/watchlist before any post-admit deepen.
func displayLookbackForInterval(interval string) int64 {
	if req, ok := chartrequirements.ForTimeframe(interval); ok && req.LookbackMs > 0 {
		return chartrequirements.ReachableLookbackMs(interval, req.LookbackMs)
	}
	return lookbackForInterval(interval)
}

func (s *Store) preloadSeries(ctx context.Context, coin, interval string) error {
	return s.preloadSeriesDepth(ctx, coin, interval, 0)
}

func (s *Store) preloadSeriesDepth(ctx context.Context, coin, interval string, fetchLookbackMs int64) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return nil
	}
	endMs := time.Now().UnixMilli()
	ser.mu.RLock()
	lookbackMs := fetchLookbackMs
	if lookbackMs <= 0 {
		lookbackMs = ser.lookbackMs
	}
	genAtStart := ser.gapGen
	ser.mu.RUnlock()
	if lookbackMs <= 0 {
		return nil
	}
	startMs := endMs - lookbackMs
	candles, err := s.fetchChunked(ctx, coin, interval, startMs, endMs)
	if err != nil {
		return err
	}
	s.applyFetchedRange(ser, candles, startMs, endMs, genAtStart)
	return nil
}

// maxCandlesPerFetch stays below the API's 5000-candle response cap so a
// single request never silently truncates the range.
const maxCandlesPerFetch = 4500

// fetchChunked fetches [startMs, endMs], splitting ranges that would exceed
// the response cap, and pays the estimated request weight (20 base + 1 per
// 60 candles, mirroring infoRequestWeight) before each upstream call. Every
// caller — preload, backfill, and on-demand warm — paces on the same budget so
// background fetching stays well under Hyperliquid's per-IP allowance, and the
// actual HTTP call is serialized via fetchSem so independent callers (e.g. two
// WarmOnDemand goroutines for different tickers clicked seconds apart) never
// fire concurrently — see the fetchSem field doc for why that matters.
func (s *Store) fetchChunked(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
	ms := intervalMs(interval)
	if ms <= 0 || endMs <= startMs {
		return nil, nil
	}
	chunkMs := int64(maxCandlesPerFetch) * ms
	var all []Candle
	for chunkStart := startMs; chunkStart < endMs; chunkStart += chunkMs {
		chunkEnd := chunkStart + chunkMs
		if chunkEnd > endMs {
			chunkEnd = endMs
		}
		estCount := int((chunkEnd - chunkStart) / ms)
		if err := s.budget.wait(ctx, 20+estCount/60); err != nil {
			return nil, err
		}
		select {
		case s.fetchSem <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		candles, err := func() ([]Candle, error) {
			defer func() { <-s.fetchSem }()
			return s.fetch(ctx, coin, interval, chunkStart, chunkEnd)
		}()
		if err != nil {
			return nil, err
		}
		all = mergeCandles(all, candles)
	}
	return all, nil
}

// FetchBackgroundRange exposes a bounded historical read to backend consumers
// such as the closed-session reference resolver. It uses the same weight budget
// and serialized HTTP lane as preload, heal, and on-demand warm work, and does
// not register a permanent live series.
func (s *Store) FetchBackgroundRange(
	ctx context.Context,
	coin, interval string,
	startMs, endMs int64,
) ([]Candle, error) {
	if s == nil {
		return nil, nil
	}
	return s.fetchChunked(ctx, coin, interval, startMs, endMs)
}
