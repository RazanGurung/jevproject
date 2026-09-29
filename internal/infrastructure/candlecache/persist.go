package candlecache

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Candle-store disk persistence: the store snapshots itself periodically and
// on shutdown, and restores on boot. Restored series load `degraded` (live-edge
// distrust). Immutable historical ranges remain servable when coverage/gap are
// sound; the live edge heals via the first contiguous WS tick, present-reaching
// REST, or a non-blocking tail repair — same machinery as a market-WS outage.
//
// History-ready startup does not re-fetch complete restored series. So a warm
// relaunch avoids re-fetching the display window × every warmed coin × every interval.

const (
	// snapshotVersion is the format written by SaveSnapshot (columnar v2).
	snapshotVersion = 2
	// snapshotVersionLegacy is the pre-columnar row format still accepted on load.
	snapshotVersionLegacy = 1
	// snapshotMaxAge drops a snapshot old enough that warming from scratch
	// costs about the same as backfilling every series' gap.
	snapshotMaxAge = 7 * 24 * time.Hour
	// DefaultSnapshotInterval is the periodic save cadence; the shutdown save
	// is the primary path, so this is only the crash-safety checkpoint.
	DefaultSnapshotInterval = 30 * time.Minute
)

// snapshotHeader is the first JSON value in the (gzipped) snapshot stream;
// each subsequent value is one series record. Concatenated JSON values, so
// both sides stream one series at a time — no full-store buffer in memory and
// no lock held across file IO.
type snapshotHeader struct {
	Version   int   `json:"version"`
	SavedAtMs int64 `json:"savedAtMs"`
}

// snapshotSeriesV1 is the legacy row format (version 1): full Candle objects
// with repeated symbol/interval strings on every row.
type snapshotSeriesV1 struct {
	Coin                string   `json:"coin"`
	Interval            string   `json:"interval"`
	LookbackMs          int64    `json:"lookbackMs"`
	CoverageStartMs     int64    `json:"coverageStartMs"`
	GapStateKnown       bool     `json:"gapStateKnown,omitempty"`
	UnverifiedGapFromMs int64    `json:"unverifiedGapFromMs,omitempty"`
	VerifiedThroughMs   int64    `json:"verifiedThroughMs,omitempty"`
	LastNeededMs        int64    `json:"lastNeededMs,omitempty"`
	Candles             []Candle `json:"candles"`
}

// snapshotSeriesV2 is the denser columnar format (version 2). Per-series
// coin/interval are not repeated on every candle; cvdDelta is never persisted
// (recomputed at serve time).
type snapshotSeriesV2 struct {
	Coin                string   `json:"coin"`
	Interval            string   `json:"interval"`
	LookbackMs          int64    `json:"lookbackMs"`
	CoverageStartMs     int64    `json:"coverageStartMs"`
	GapStateKnown       bool     `json:"gapStateKnown,omitempty"`
	UnverifiedGapFromMs int64    `json:"unverifiedGapFromMs,omitempty"`
	VerifiedThroughMs   int64    `json:"verifiedThroughMs,omitempty"`
	LastNeededMs        int64    `json:"lastNeededMs,omitempty"`
	OpenMs              []int64  `json:"t"`
	CloseMs             []int64  `json:"T,omitempty"`
	Open                []string `json:"o"`
	High                []string `json:"h"`
	Low                 []string `json:"l"`
	Close               []string `json:"c"`
	Volume              []string `json:"v"`
	Trades              []int64  `json:"n"`
}

// snapshotSeriesMeta is the shared identity/health fields used after decode.
type snapshotSeriesMeta struct {
	Coin                string
	Interval            string
	LookbackMs          int64
	CoverageStartMs     int64
	GapStateKnown       bool
	UnverifiedGapFromMs int64
	VerifiedThroughMs   int64
	LastNeededMs        int64
	Candles             []Candle
}

// removeSnapshotTmps deletes atomic-write temp files next to path (a crash
// between CreateTemp and Rename leaves them behind, and they are
// snapshot-sized). minAge > 0 skips temps newer than that so an in-flight
// save is not deleted — e.g. the shutdown save overlapping the periodic
// loop's final tick. Boot uses minAge 0: this process has not started a
// save, so every leftover temp is an orphan from a previous writer.
func removeSnapshotTmps(path string, minAge time.Duration) {
	matches, err := filepath.Glob(path + ".tmp-*")
	if err != nil {
		return
	}
	for _, tmp := range matches {
		info, err := os.Stat(tmp)
		if err != nil {
			continue
		}
		if minAge > 0 && time.Since(info.ModTime()) < minAge {
			continue
		}
		if err := os.Remove(tmp); err == nil {
			log.Printf("candlecache: removed stale snapshot temp %s", tmp)
		}
	}
}

func removeStaleSnapshotTmps(path string) {
	removeSnapshotTmps(path, time.Hour)
}

func removeOrphanSnapshotTmps(path string) {
	removeSnapshotTmps(path, 0)
}

// SaveSnapshot writes every non-empty series to path atomically (tmp +
// rename) in columnar v2 format. Each series is copied under its own read
// lock and encoded outside it, so the market-WS write path is never blocked
// on disk. Series idle past seriesIdleTTL are dropped from the snapshot so it
// shrinks with eviction instead of ratcheting up with every coin ever touched.
func (s *Store) SaveSnapshot(path string) error {
	if s == nil || path == "" {
		return nil
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	removeStaleSnapshotTmps(path)
	s.mu.RLock()
	sers := make([]*series, 0, len(s.series))
	for _, ser := range s.series {
		sers = append(sers, ser)
	}
	s.mu.RUnlock()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())

	gz := gzip.NewWriter(tmp)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(snapshotHeader{Version: snapshotVersion, SavedAtMs: time.Now().UnixMilli()}); err != nil {
		tmp.Close()
		return err
	}
	saved := 0
	nowMs := time.Now().UnixMilli()
	idleCutoffMs := nowMs - seriesIdleTTL.Milliseconds()
	coinMax := coinNeededMax(sers, nowMs)
	for _, ser := range sers {
		ser.mu.RLock()
		gapStateKnown := ser.verifiedThroughMs > 0 || ser.unverifiedGapFromMs != 0
		candles := append([]Candle(nil), ser.candles...)
		neededMs := effectiveLastNeededMs(ser, coinMax, nowMs)
		meta := snapshotSeriesMeta{
			Coin:                ser.coin,
			Interval:            ser.interval,
			LookbackMs:          ser.lookbackMs,
			CoverageStartMs:     ser.coverageStartMs,
			GapStateKnown:       gapStateKnown,
			UnverifiedGapFromMs: ser.unverifiedGapFromMs,
			VerifiedThroughMs:   ser.verifiedThroughMs,
			LastNeededMs:        neededMs,
		}
		ser.mu.RUnlock()
		if len(candles) == 0 || meta.CoverageStartMs == 0 {
			continue
		}
		// A series already past the idle TTL is about to be evicted (or would
		// be skipped by LoadSnapshot anyway) — the shutdown save can land
		// before the next hourly eviction tick, so filter here too.
		// CVD sources inherit the coin's freshest stamp (same clock as evict).
		if neededMs < idleCutoffMs {
			continue
		}
		if err := enc.Encode(encodeSeriesV2(meta, candles)); err != nil {
			tmp.Close()
			return err
		}
		saved++
	}
	if err := gz.Close(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	log.Printf("candlecache: snapshot saved: series=%d file=%s version=%d", saved, path, snapshotVersion)
	return nil
}

func encodeSeriesV2(meta snapshotSeriesMeta, candles []Candle) snapshotSeriesV2 {
	n := len(candles)
	out := snapshotSeriesV2{
		Coin:                meta.Coin,
		Interval:            meta.Interval,
		LookbackMs:          meta.LookbackMs,
		CoverageStartMs:     meta.CoverageStartMs,
		GapStateKnown:       meta.GapStateKnown,
		UnverifiedGapFromMs: meta.UnverifiedGapFromMs,
		VerifiedThroughMs:   meta.VerifiedThroughMs,
		LastNeededMs:        meta.LastNeededMs,
		OpenMs:              make([]int64, n),
		CloseMs:             make([]int64, n),
		Open:                make([]string, n),
		High:                make([]string, n),
		Low:                 make([]string, n),
		Close:               make([]string, n),
		Volume:              make([]string, n),
		Trades:              make([]int64, n),
	}
	for i, c := range candles {
		out.OpenMs[i] = c.OpenMs
		out.CloseMs[i] = c.CloseMs
		out.Open[i] = c.Open
		out.High[i] = c.High
		out.Low[i] = c.Low
		out.Close[i] = c.Close
		out.Volume[i] = c.Volume
		out.Trades[i] = c.Trades
	}
	return out
}

func expandSeriesV2(snap snapshotSeriesV2) ([]Candle, error) {
	n := len(snap.OpenMs)
	if n == 0 {
		return nil, nil
	}
	if len(snap.Open) != n || len(snap.High) != n || len(snap.Low) != n ||
		len(snap.Close) != n || len(snap.Volume) != n || len(snap.Trades) != n {
		return nil, fmt.Errorf("column length mismatch coin=%s interval=%s", snap.Coin, snap.Interval)
	}
	// CloseMs is optional in older experimental writers; derive when absent.
	closeMs := snap.CloseMs
	if len(closeMs) == 0 {
		ms := intervalMs(snap.Interval)
		closeMs = make([]int64, n)
		for i := 0; i < n; i++ {
			if ms > 0 {
				closeMs[i] = snap.OpenMs[i] + ms - 1
			}
		}
	} else if len(closeMs) != n {
		return nil, fmt.Errorf("closeMs length mismatch coin=%s interval=%s", snap.Coin, snap.Interval)
	}
	candles := make([]Candle, n)
	for i := 0; i < n; i++ {
		candles[i] = Candle{
			OpenMs:   snap.OpenMs[i],
			CloseMs:  closeMs[i],
			Symbol:   snap.Coin,
			Interval: snap.Interval,
			Open:     snap.Open[i],
			High:     snap.High[i],
			Low:      snap.Low[i],
			Close:    snap.Close[i],
			Volume:   snap.Volume[i],
			Trades:   snap.Trades[i],
		}
	}
	return candles, nil
}

// LoadSnapshot restores series from path, returning how many were loaded.
// Accepts version 1 (row) and version 2 (columnar). Every restored series is
// marked degraded (live-edge distrust). Immutable historical ranges remain
// servable when coverage/gap are sound. Call after SetOnRegister and before
// the market WS starts. A missing file is a clean no-op; a stale or unsupported
// version is skipped (the normal cold-start warm takes over).
func (s *Store) LoadSnapshot(path string) (int, error) {
	if s == nil || path == "" {
		return 0, nil
	}
	removeOrphanSnapshotTmps(path)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, fmt.Errorf("snapshot unreadable: %w", err)
	}
	defer gz.Close()
	dec := json.NewDecoder(gz)

	var header snapshotHeader
	if err := dec.Decode(&header); err != nil {
		return 0, fmt.Errorf("snapshot header: %w", err)
	}
	if header.Version != snapshotVersion && header.Version != snapshotVersionLegacy {
		log.Printf("candlecache: snapshot version %d unsupported (want %d or %d), ignoring %s",
			header.Version, snapshotVersionLegacy, snapshotVersion, path)
		return 0, nil
	}
	if age := time.Since(time.UnixMilli(header.SavedAtMs)); age > snapshotMaxAge {
		log.Printf("candlecache: snapshot too old (%s), ignoring %s", age.Round(time.Minute), path)
		return 0, nil
	}

	loaded := 0
	idleCutoffMs := time.Now().UnixMilli() - seriesIdleTTL.Milliseconds()
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err == io.EOF {
			break
		} else if err != nil {
			// Partial load is fine: everything restored so far is valid and
			// degraded; the warm coordinator fills whatever is missing.
			return loaded, fmt.Errorf("snapshot truncated after %d series: %w", loaded, err)
		}
		meta, err := decodeSnapshotSeries(header.Version, raw)
		if err != nil {
			return loaded, fmt.Errorf("snapshot series after %d: %w", loaded, err)
		}
		if meta.Coin == "" || intervalMs(meta.Interval) <= 0 || meta.LookbackMs <= 0 ||
			len(meta.Candles) == 0 || meta.CoverageStartMs == 0 {
			continue
		}
		// Skip series already past the idle TTL BEFORE registering: restoring
		// them would resurrect every coin ever touched on each restart (and
		// create a permanent WS subscription eviction would tear down an hour
		// later). Pre-tracking snapshots carry no stamp; treat those series as
		// last needed when the snapshot was saved.
		//
		// Exception: PrepareStartupUniverse already registered the admit set.
		// Those rows must restore even with a stale idle stamp, or /readyz
		// REST-hydrates markets the snapshot still holds.
		lastNeededMs := meta.LastNeededMs
		if lastNeededMs == 0 {
			lastNeededMs = header.SavedAtMs
		}
		existing := s.getSeries(meta.Coin, meta.Interval)
		if existing == nil && lastNeededMs < idleCutoffMs {
			continue
		}
		ser := s.registerOnDemand(meta.Coin, meta.Interval, meta.LookbackMs)
		if ser == nil {
			continue
		}
		// restoreCandles skips map+sort when the writer left rows sorted/unique
		// (the common path for ~millions of candles on warm relaunch).
		candles := restoreCandles(meta.Candles)
		ser.mu.Lock()
		if len(ser.candles) == 0 { // boot path; never clobber live data
			ser.candles = candles
			ser.coverageStartMs = meta.CoverageStartMs
			// Snapshot lookback is the requirement at save time (often the 190d
			// display window). Resident rows can be deeper (HL-cap passthrough
			// or a previous extend). Promote so hourly prune cannot throw that
			// history away on the first tick after restore.
			if len(candles) > 0 {
				span := time.Now().UnixMilli() - candles[0].OpenMs
				if span > ser.lookbackMs {
					ser.lookbackMs = span
				}
			}
			ser.verifiedThroughMs = meta.VerifiedThroughMs
			// Restored series decline live-edge serving until a tick or present-
			// reaching REST verifies the tail. Historical ranges remain
			// servable once coverage/gap are sound (see ServeInfoRequest).
			ser.degraded = true
			// A snapshot preserves candle rows but not the live gap marker. Do
			// not let the first same-bucket post-restart tick vouch for older
			// holes already present in the snapshot: it can only replace the
			// current bucket. Treat the earliest discontinuity as unverified so
			// ServeInfoRequest falls through to a covering REST snapshot.
			gapFrom := meta.UnverifiedGapFromMs
			if !meta.GapStateKnown {
				gapFrom = snapshotGapFrom(candles, ser.interval)
			}
			if gapFrom != 0 {
				ser.unverifiedGapFromMs = gapFrom
				ser.gapGen++
			}
			// Carry the idle clock across the restart for series the snapshot
			// introduced. Registration stamped "now", which would otherwise
			// reset the TTL on every relaunch. Series already registered by
			// PrepareStartupUniverse are the startup pin set: restamp now so
			// the next gzip cannot drop the admit/remainder rows.
			if existing == nil {
				ser.lastNeededMs.Store(lastNeededMs)
			} else {
				ser.lastNeededMs.Store(time.Now().UnixMilli())
			}
		}
		ser.mu.Unlock()
		loaded++
	}
	return loaded, nil
}

func decodeSnapshotSeries(version int, raw json.RawMessage) (snapshotSeriesMeta, error) {
	switch version {
	case snapshotVersionLegacy:
		var snap snapshotSeriesV1
		if err := json.Unmarshal(raw, &snap); err != nil {
			return snapshotSeriesMeta{}, err
		}
		return snapshotSeriesMeta{
			Coin:                snap.Coin,
			Interval:            snap.Interval,
			LookbackMs:          snap.LookbackMs,
			CoverageStartMs:     snap.CoverageStartMs,
			GapStateKnown:       snap.GapStateKnown,
			UnverifiedGapFromMs: snap.UnverifiedGapFromMs,
			VerifiedThroughMs:   snap.VerifiedThroughMs,
			LastNeededMs:        snap.LastNeededMs,
			Candles:             snap.Candles,
		}, nil
	case snapshotVersion:
		var snap snapshotSeriesV2
		if err := json.Unmarshal(raw, &snap); err != nil {
			return snapshotSeriesMeta{}, err
		}
		candles, err := expandSeriesV2(snap)
		if err != nil {
			return snapshotSeriesMeta{}, err
		}
		return snapshotSeriesMeta{
			Coin:                snap.Coin,
			Interval:            snap.Interval,
			LookbackMs:          snap.LookbackMs,
			CoverageStartMs:     snap.CoverageStartMs,
			GapStateKnown:       snap.GapStateKnown,
			UnverifiedGapFromMs: snap.UnverifiedGapFromMs,
			VerifiedThroughMs:   snap.VerifiedThroughMs,
			LastNeededMs:        snap.LastNeededMs,
			Candles:             candles,
		}, nil
	default:
		return snapshotSeriesMeta{}, fmt.Errorf("unsupported series version %d", version)
	}
}

// snapshotGapFrom returns the candle immediately before the first missing
// interval in a restored snapshot. Upstream can legitimately omit thin-market
// buckets, but serving a known discontinuity as complete history is worse than
// a temporary passthrough; the normal backfill/merge path verifies either case.
func snapshotGapFrom(candles []Candle, interval string) int64 {
	if intervalMs(interval) <= 0 {
		return 0
	}
	for i := 1; i < len(candles); i++ {
		expected := nextOpenMs(candles[i-1].OpenMs, interval)
		if expected > 0 && candles[i].OpenMs > expected {
			return candles[i-1].OpenMs
		}
	}
	return 0
}

// RunSnapshotLoop saves periodically until ctx is canceled. The shutdown path
// should call SaveSnapshot once more for the freshest tail; this loop is the
// safety net for non-graceful exits.
func (s *Store) RunSnapshotLoop(ctx context.Context, path string, interval time.Duration) {
	if s == nil || path == "" {
		return
	}
	if interval <= 0 {
		interval = DefaultSnapshotInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.SaveSnapshot(path); err != nil {
				log.Printf("candlecache: periodic snapshot failed: %v", err)
			}
		}
	}
}
