package candlecache

import (
	"encoding/json"
	"sort"

	"hyperliquid-go/internal/chartrequirements"
)

// CVD composite enrichment lives here so store.go stays residency/warm/gap
// focused. ServeInfoRequest still calls ComputeCvdDeltas at the store boundary;
// product math for deltas is owned by these methods.

// sourceWindow is a health-gated snapshot of one CVD source series: the bars
// in a requested range plus the series' overall bounds (used for seam and
// coverage-edge decisions). ok is false when the series is cold, degraded,
// or carries an unverified gap — summing across a known hole would serve
// confidently wrong deltas, so callers must decline enrichment instead.
// A degraded live tail is omitted from the window; closed historical bars remain.
type sourceWindow struct {
	ok        bool
	firstOpen int64 // series' overall first bar open, not the window's
	lastOpen  int64 // series' overall last bar open, not the window's
	bars      []Candle
}

// snapshotSourceWindow copies just the [fromMs, toMs) bar range under the
// series' read lock (binary search, same pattern as getSlice) instead of the
// whole series — chart serves only pay for the range they actually sum.
func snapshotSourceWindow(ser *series, fromMs, toMs int64) sourceWindow {
	if ser == nil {
		return sourceWindow{}
	}
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if ser.coverageStartMs == 0 || len(ser.candles) == 0 || ser.unverifiedGapFromMs != 0 {
		return sourceWindow{}
	}
	lo := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= fromMs })
	hi := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= toMs })
	if ser.degraded {
		lastOpen := ser.candles[len(ser.candles)-1].OpenMs
		trustHi := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= lastOpen })
		if trustHi < hi {
			hi = trustHi
		}
	}
	if hi < lo {
		hi = lo
	}
	bars := make([]Candle, hi-lo)
	copy(bars, ser.candles[lo:hi])
	return sourceWindow{
		ok:        true,
		firstOpen: ser.candles[0].OpenMs,
		lastOpen:  ser.candles[len(ser.candles)-1].OpenMs,
		bars:      bars,
	}
}

// cvdSeam returns the 30m boundary at/above the recent (5m) series' first bar:
// the composite source uses 30m bars strictly before it and 5m bars at/after
// it. 30m bars are boundary-aligned, so this partition has no hole or overlap.
func cvdSeam(firstRecentOpen int64) int64 {
	deepIntervalMs := intervalMs(cvdDeepInterval) // 1800000
	return ((firstRecentOpen + deepIntervalMs - 1) / deepIntervalMs) * deepIntervalMs
}

// ComputeCvdDeltas enriches each candle in the slice with a server-computed
// cvdDelta — the directional volume delta from the 5m/30m composite source
// (mirroring the cross-timeframe-consistent CVD pipeline formerly in
// web/src/chart/cvd.js). Callers that own a display timeframe should also
// gate with chartrequirements.CvdEnabled; this function re-checks the candle
// interval as defense in depth so 1m/1w/1M never inherit composite deltas.
//
// A bar's delta is left nil — and the client falls back to its per-bar
// directional (close-open) delta — whenever the composite can't honestly
// vouch for the bucket: a source series missing/cold/gapped, the
// bucket outside source coverage (including one straddling the coverage
// start, whose sum would be silently truncated), a pre-seam bucket finer
// than the 30m deep source (whose 30m-boundary bucket would lump the whole
// half hour while its siblings fall back — double-counting on the client),
// or a traded bucket with no covering source bars (the stale-source
// signature; upstream skips empty buckets, so a bucket with volume must have
// source bars under it). Serving 0 in those cases would flatline the CVD
// instead of falling back.
//
// When the deep (30m) leg is unhealthy or absent, post-seam buckets still
// enrich from the 5m leg alone; only pre-seam coverage is withheld.
func (s *Store) ComputeCvdDeltas(coin string, candles []Candle) []Candle {
	if len(candles) == 0 || coin == "" {
		return candles
	}

	displayInterval := ""
	for i := range candles {
		if candles[i].Interval != "" {
			displayInterval = candles[i].Interval
			break
		}
	}
	if displayInterval != "" && !chartrequirements.CvdEnabled(displayInterval) {
		return candles
	}

	recentSer := s.getSeries(coin, cvdRecentInterval)
	if recentSer == nil {
		return candles
	}
	deepSer := s.getSeries(coin, cvdDeepInterval)

	// The chart range the sources must cover. candles come sorted from
	// getSlice, but scan defensively for the bounds.
	var chartFrom, chartTo int64
	for i := range candles {
		open := candles[i].OpenMs
		if open <= 0 {
			continue
		}
		if chartFrom == 0 || open < chartFrom {
			chartFrom = open
		}
		if end := bucketEndMs(candles, i); end > chartTo {
			chartTo = end
		}
	}
	if chartFrom == 0 || chartTo <= chartFrom {
		return candles
	}

	recent := snapshotSourceWindow(recentSer, chartFrom, chartTo)
	if !recent.ok {
		return candles
	}
	seam := cvdSeam(recent.firstOpen)

	// The deep (30m) source is only consulted for the pre-seam part of the
	// range. An unhealthy deep leg must not zero post-seam enrichment: those
	// buckets only need the 5m source.
	var deep sourceWindow
	if chartFrom < seam && deepSer != nil {
		deep = snapshotSourceWindow(deepSer, chartFrom, min(seam, chartTo))
	}

	// Composite source: 30m bars before the seam (when available), 5m bars
	// at/after. The window snapshots are range-clipped but may still straddle
	// the seam.
	source := make([]Candle, 0, len(deep.bars)+len(recent.bars))
	for _, c := range deep.bars {
		if c.OpenMs < seam {
			source = append(source, c)
		}
	}
	for _, c := range recent.bars {
		if c.OpenMs >= seam {
			source = append(source, c)
		}
	}

	// Composite coverage bounds: buckets outside them stay nil. Without a
	// healthy deep leg, coverage starts at the seam (5m-only).
	sourceStart := seam
	if deep.ok {
		sourceStart = deep.firstOpen
	}
	sourceEnd := recent.lastOpen + intervalMs(cvdRecentInterval)

	// Sources are sorted by OpenMs (guaranteed by mergeCandles). For each
	// output candle, sum the directional deltas of source bars in
	// [candle.OpenMs, bucket end).
	srcIdx := 0
	for i := range candles {
		open := candles[i].OpenMs
		if open <= 0 {
			continue
		}
		endMs := bucketEndMs(candles, i)
		if open < sourceStart || open >= sourceEnd {
			continue
		}
		barMs := intervalMs(candles[i].Interval)
		if barMs <= 0 {
			barMs = endMs - open
		}
		if open < seam && barMs < intervalMs(cvdDeepInterval) {
			continue
		}

		// Advance srcIdx past source bars before this bucket.
		for srcIdx < len(source) && source[srcIdx].OpenMs < open {
			srcIdx++
		}

		var delta float64
		covered := 0
		scan := srcIdx
		for scan < len(source) && source[scan].OpenMs < endMs {
			delta += directionalDelta(source[scan])
			covered++
			scan++
		}
		if covered == 0 && candleVolume(candles[i]) > 0 {
			continue
		}
		candles[i].CvdDelta = &delta
	}

	return candles
}

// CvdDeltaForBucket returns the composite-source CVD delta for a single
// bucket [openMs, endMs). It is the WS-broadcast enrichment path — called on
// the market-WS read goroutine for every forwarded candle tick — so it sums
// directly under the 5m source's read lock without copying. Only buckets
// at/after the 5m/30m seam are served (always true for live buckets); for
// anything else, or when the source is unhealthy or doesn't cover the bucket,
// it reports ok=false and the caller forwards the message unenriched.
func (s *Store) CvdDeltaForBucket(coin string, openMs, endMs int64) (float64, bool) {
	if coin == "" || openMs <= 0 || endMs <= openMs {
		return 0, false
	}
	ser := s.getSeries(coin, cvdRecentInterval)
	if ser == nil {
		return 0, false
	}
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if ser.coverageStartMs == 0 || len(ser.candles) == 0 || ser.unverifiedGapFromMs != 0 {
		return 0, false
	}
	if ser.degraded {
		lastOpen := ser.candles[len(ser.candles)-1].OpenMs
		if openMs >= lastOpen {
			return 0, false
		}
	}
	if openMs < cvdSeam(ser.candles[0].OpenMs) {
		return 0, false
	}
	lo := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= openMs })
	var delta float64
	covered := 0
	for i := lo; i < len(ser.candles) && ser.candles[i].OpenMs < endMs; i++ {
		delta += directionalDelta(ser.candles[i])
		covered++
	}
	if covered == 0 {
		return 0, false
	}
	return delta, true
}

// AnnotateWSCandle splices a server-computed cvdDelta into a forwarded
// candle-WS message so the client's live tail bar keeps the same composite
// delta the snapshot path serves, instead of flipping to its directional
// fallback between snapshot fetches. Returns raw unchanged whenever the delta
// isn't cleanly computable. Call after ApplyWSCandle so a 5m tick's own bar
// is already merged and contributes to itself.
func (s *Store) AnnotateWSCandle(wsMsg map[string]interface{}, raw []byte) []byte {
	data, ok := wsMsg["data"].(map[string]interface{})
	if !ok {
		return raw
	}
	c, ok := candleFromMap(data)
	if !ok {
		return raw
	}
	// Same gate as ServeInfoRequest / ComputeCvdDeltas: 1m would otherwise
	// inherit a full 5m directional volume on 5m-aligned opens; 1w/1M skip CVD.
	if !chartrequirements.CvdEnabled(c.Interval) {
		return raw
	}
	ms := intervalMs(c.Interval)
	if ms <= 0 {
		return raw
	}
	delta, ok := s.CvdDeltaForBucket(c.Symbol, c.OpenMs, c.OpenMs+ms)
	if !ok {
		return raw
	}
	target := data
	if inner, isWrapped := data["candle"].(map[string]interface{}); isWrapped {
		target = inner
	}
	target["cvdDelta"] = delta
	out, err := json.Marshal(wsMsg)
	if err != nil {
		delete(target, "cvdDelta")
		return raw
	}
	return out
}

