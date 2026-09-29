// Package candlecache holds a server-side store of historical candles for
// liquid tickers, preloaded at startup and kept fresh from the upstream
// market WebSocket, so chart loads are served from memory instead of paying
// a Hyperliquid REST round trip (whose body-keyed proxy cache never hits —
// the frontend stamps every request with endTime=Date.now()).
package candlecache

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

// CVD source interval constants (mirror web/src/chart/cvd-source.js).
const (
	cvdRecentInterval = "5m"
	cvdDeepInterval   = "30m"
)

const (
	backfillCooldown = 60 * time.Second
	pruneInterval    = time.Hour
	// pruneSlack keeps a margin beyond the registered lookback so a request
	// issued just before pruning still finds its full range.
	pruneSlack = 7 * 24 * time.Hour
	// seriesIdleTTL is how long a series may go entirely un-needed (no chart
	// serve, no warm, no passthrough merge, no warm-coordinator interest)
	// before the prune loop evicts it whole — data, WS subscription, snapshot
	// entry. Matches pruneSlack/snapshotMaxAge: past a week, re-fetching costs
	// about the same as keeping it warm did.
	seriesIdleTTL = 7 * 24 * time.Hour
)

type series struct {
	mu         sync.RWMutex
	coin       string
	interval   string
	intervalMs int64
	lookbackMs int64
	candles    []Candle // sorted by OpenMs, deduped
	// coverageStartMs is the start of the requested fetch range (not the
	// first candle's open — short-history coins return less than asked).
	// Zero until the first successful preload or passthrough merge.
	coverageStartMs int64
	// verifiedThroughMs is the end of the latest complete REST range. It keeps
	// sparse/closed markets honestly fresh even when no candle exists near the
	// range end and their cache-owned websocket feed was shed. A successful
	// empty tail is still proof that no trades occurred through this instant.
	verifiedThroughMs int64
	// degraded declines serving while the upstream WS is down: with no live
	// updates the tail would silently age. Cleared by the first post-reconnect
	// tick — safe because the cumulative bucket replace covers everything the
	// outage could have missed within that bucket, and a crossed bucket
	// boundary surfaces as a jump that sets unverifiedGapFromMs instead.
	degraded bool
	// feedUnavailable is set when the websocket manager sheds this series'
	// permanent upstream candle subscription. A REST merge may refresh one
	// request but cannot prove the tail will stay live, so only a real WS tick
	// clears it.
	feedUnavailable bool
	// unverifiedGapFromMs is the open of the last candle before a detected
	// multi-bucket jump (thin markets legitimately skip empty buckets, but a
	// missed-candle gap looks identical). While set, serving declines —
	// regardless of degraded — until a backfill or a covering passthrough
	// verifies the range. Ticks must never clear it: that window is exactly
	// when the store would serve the hole as real data.
	unverifiedGapFromMs int64
	// gapGen increments on every detected jump. Verification fetches can be
	// in flight for minutes behind the weight budget; one may only clear the
	// gap marker if no new jump happened since it started (a newer jump's
	// hole lies beyond the fetched range).
	gapGen         uint64
	lastBackfillAt time.Time
	// lastNeededMs is when something last needed this series: a chart serve,
	// a warm, a passthrough merge, or warm-coordinator interest (MarkNeeded).
	// Atomic so touch points never take mu. Live WS ticks deliberately do NOT
	// touch it — the subscription would keep the series "needed" and the
	// series would keep the subscription, and nothing would ever age out.
	lastNeededMs atomic.Int64
}

type backfillReq struct {
	coin     string
	interval string
	fromMs   int64
}

// FetchFunc fetches candles for [startMs, endMs] from upstream. Injectable
// for tests; production uses NewHTTPFetcher.
type FetchFunc func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error)

type warmFlight struct {
	startedMs int64
	wantMs    int64
}

type Store struct {
	mu           sync.RWMutex
	series       map[string]*series // key: coin + "|" + interval
	lifecycleCtx context.Context

	fetch      FetchFunc
	budget     *weightBudget
	backfillCh chan backfillReq

	// wsConnected tracks upstream market-WS health; degraded series only
	// clear while it is true, so a REST repair during an outage cannot make
	// the store serve tails that nothing is updating.
	wsMu        sync.Mutex
	wsConnected bool

	// warming single-flights background on-demand warms per series so rapid
	// re-clicks and parallel tabs on the same chart don't stack duplicate
	// budgeted fetches. The stored wantMs lets a deeper warm that arrives
	// during a tail repair re-enter after the in-flight work finishes.
	warmMu  sync.Mutex
	warming map[string]*warmFlight

	// fetchSem serializes actual upstream HTTP calls made on background paths
	// (preload, on-demand warm, backfill). WarmOnDemand runs one goroutine per
	// distinct (coin, interval) — single-flighted only against itself, not
	// against warms for other series — so flipping through several different
	// cold tickers within a few seconds during the startup warm window used to
	// fire that many concurrent real fetches at once. The weight budget only
	// paces the average rate (a burst is allowed up to its cap), so it didn't
	// stop that pile-up. Hyperliquid's real per-IP limit is far more sensitive
	// to a burst of simultaneous requests than to our average-rate accounting,
	// so a handful of concurrent background fetches plus the interactive
	// passthroughs they collided with could jointly trip it — surfacing as the
	// clicked chart itself 429ing. This channel caps background fetches to one
	// in flight at a time; interactive passthrough in proxyHL never touches it,
	// so foreground chart loads stay unblocked and just as fast as before.
	fetchSem chan struct{}

	// onRegister, if set, is called when a series is registered on demand (an
	// off-list coin the user clicked) so it can be wired to the market-WS feed.
	onRegister func(coin, interval string)

	// onEvict, if set, is called (outside all store locks) for each series the
	// idle-eviction pass removes, so the permanent market-WS subscription that
	// onRegister created can be released.
	onEvict func(coin, interval string)

	// saveMu single-flights snapshot gzip so admit / periodic / shutdown
	// writers cannot rename over each other.
	saveMu sync.Mutex
}

func New(fetch FetchFunc, weightPerMin int) *Store {
	return &Store{
		series:  make(map[string]*series),
		fetch:   fetch,
		budget:  newWeightBudget(weightPerMin, time.Now, nil),
		warming: make(map[string]*warmFlight),
		// Sized for every series gapping at once (a sleep/wake does exactly
		// that); a dropped enqueue is retried on later ticks, but only after
		// the per-series cooldown, so drops delay repair by a minute each.
		backfillCh:   make(chan backfillReq, 512),
		fetchSem:     make(chan struct{}, 1),
		lifecycleCtx: context.Background(),
	}
}

// SetOnRegister wires a callback fired when a series is registered on demand,
// so the caller can keep it fed from the market WebSocket.
func (s *Store) SetOnRegister(fn func(coin, interval string)) {
	s.onRegister = fn
}

// SetOnEvict wires a callback fired (outside all store locks) for each series
// the idle-eviction pass removes, so the caller can release the permanent
// market-WS subscription onRegister created.
func (s *Store) SetOnEvict(fn func(coin, interval string)) {
	s.onEvict = fn
}

// MarkNeeded refreshes a series' idle clock without registering anything —
// the warm coordinator calls it for every member of its current warm union so
// coins still on the pinned/movers/mispricing/watchlist lists never age out.
func (s *Store) MarkNeeded(coin, interval string) {
	if ser := s.getSeries(coin, interval); ser != nil {
		ser.lastNeededMs.Store(time.Now().UnixMilli())
	}
}

// registerOnDemand is the single path for registering a series outside the
// startup preload: it registers AND fires onRegister so the series gets the
// permanent market-WS subscription that keeps its tail fresh. Every on-demand
// caller must go through here — a bare RegisterSeries leaves the series
// unfed, and its tail silently ages the moment the initial warm completes.
// Returns the series (nil when registration was rejected).
func (s *Store) registerOnDemand(coin, interval string, lookbackMs int64) *series {
	ser, created := s.registerSeries(coin, interval, lookbackMs)
	if created && s.onRegister != nil {
		s.onRegister(coin, interval)
	}
	return ser
}

// registerCvdSources ensures the 5m/30m CVD source series exist (and are
// WS-fed) for a coin whose main series is being registered or warmed, so
// ComputeCvdDeltas has live sources to sum.
func (s *Store) registerCvdSources(coin, interval string) {
	requirement, ok := chartrequirements.ForTimeframe(interval)
	if !ok {
		return
	}
	for _, source := range requirement.CvdSources {
		if interval == source.Interval {
			continue
		}
		if source.LookbackMs > 0 {
			s.registerOnDemand(coin, source.Interval, source.LookbackMs)
		}
	}
}

// Start launches the backfill worker and the hourly prune loop.
func (s *Store) Start(ctx context.Context) {
	s.lifecycleCtx = ctx
	go s.runBackfillWorker(ctx)
	go s.runPruneLoop(ctx)
}

func (s *Store) RegisterSeries(coin, interval string, lookbackMs int64) {
	s.registerSeries(coin, interval, lookbackMs)
}

// registerSeries creates a series or monotonically promotes an existing
// series' lookback. Snapshot rows can carry an older requirement (notably the
// former 175-day 4h depth); silently retaining that value lets pruneOnce cut a
// subsequently warmed 600-day RVWAP source back to 175 days. Requirements may
// deepen across releases, but they must never shrink a live/restored series.
func (s *Store) registerSeries(coin, interval string, lookbackMs int64) (*series, bool) {
	ms := intervalMs(interval)
	if coin == "" || ms <= 0 || lookbackMs <= 0 {
		return nil, false
	}
	lookbackMs = chartrequirements.ReachableLookbackMs(interval, lookbackMs)
	if lookbackMs <= 0 {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := seriesKey(coin, interval)
	if existing, ok := s.series[key]; ok {
		existing.mu.Lock()
		if lookbackMs > existing.lookbackMs {
			existing.lookbackMs = lookbackMs
		}
		existing.mu.Unlock()
		return existing, false
	}
	ser := &series{
		coin:       coin,
		interval:   interval,
		intervalMs: ms,
		lookbackMs: lookbackMs,
	}
	// A fresh registration gets a full idle TTL of grace before eviction.
	ser.lastNeededMs.Store(time.Now().UnixMilli())
	s.series[key] = ser
	return ser, true
}

// RegisteredSeries returns the (coin, interval) pairs the store tracks.
func (s *Store) RegisteredSeries() [][2]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	pairs := make([][2]string, 0, len(s.series))
	for _, ser := range s.series {
		pairs = append(pairs, [2]string{ser.coin, ser.interval})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i][0] != pairs[j][0] {
			return pairs[i][0] < pairs[j][0]
		}
		return pairs[i][1] < pairs[j][1]
	})
	return pairs
}

func (s *Store) getSeries(coin, interval string) *series {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.series[seriesKey(coin, interval)]
}

// IsCold reports whether a series has never been warmed: it is unregistered, or
// registered but holds no covered range yet (coverageStartMs == 0). It is true
// for a brand-new series and false once an initial preload/passthrough has
// landed — even while that series is degraded (WS down). The warm coordinator
// uses this so its periodic reconcile only fills genuinely cold series and
// leaves freshness of warm-but-degraded ones to the WS/backfill/passthrough heal
// path, rather than re-fetching the whole universe during an outage.
func (s *Store) IsCold(coin, interval string) bool {
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return true
	}
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	return ser.coverageStartMs == 0
}

// NeedsWarm reports that a series is cold OR that its coverage does not reach
// the registered lookback — the state a cap-truncated passthrough seed leaves
// behind (see applyFetchedRange). The warm coordinator gates on this rather
// than IsCold so a truncation-seeded series (coverage != 0 but shallow) still
// gets its budget-paced deepen; a satisfied series stays as cheap to check as
// before. Like IsCold, it deliberately ignores `degraded`, leaving outage
// recovery to the WS/backfill/passthrough heal path.
func (s *Store) NeedsWarm(coin, interval string) bool {
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return true
	}
	nowMs := time.Now().UnixMilli()
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	return ser.coverageStartMs == 0 || !coverageReachesLookback(ser.coverageStartMs, ser.interval, ser.lookbackMs, nowMs)
}

// NeedsDisplayWarm is the coordinator's first pass: missing series or
// coverage shorter than the visible chart window. Extended-lookback deepen
// (NeedsWarm after PromoteExtendedLookbacks) must not block this.
func (s *Store) NeedsDisplayWarm(coin, interval string) bool {
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return true
	}
	display := displayLookbackForInterval(interval)
	if display <= 0 {
		return s.NeedsWarm(coin, interval)
	}
	nowMs := time.Now().UnixMilli()
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	return ser.coverageStartMs == 0 || !coverageReachesLookback(ser.coverageStartMs, ser.interval, display, nowMs)
}

// PromoteExtendedLookbacks raises registered lookbacks to the post-admit
// background target (and never below already-resident candle span). Call after
// snapshot restore so prune cannot drop extra history and NeedsWarm will
// deepen series that only have the display window.
func (s *Store) PromoteExtendedLookbacks(coins []string) int {
	if s == nil {
		return 0
	}
	nowMs := time.Now().UnixMilli()
	seen := make(map[string]struct{}, len(coins))
	promoted := 0
	promote := func(coin, interval string) {
		if coin == "" || interval == "" {
			return
		}
		key := seriesKey(coin, interval)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		ser := s.getSeries(coin, interval)
		if ser == nil {
			return
		}
		target := lookbackForInterval(interval)
		ser.mu.Lock()
		defer ser.mu.Unlock()
		if len(ser.candles) > 0 {
			if span := nowMs - ser.candles[0].OpenMs; span > target {
				target = span
			}
		}
		if target > ser.lookbackMs {
			ser.lookbackMs = target
			promoted++
		}
	}
	for _, coin := range coins {
		for _, spec := range DefaultSeries {
			promote(coin, spec.Interval)
		}
	}
	for _, pair := range s.RegisteredSeries() {
		promote(pair[0], pair[1])
	}
	return promoted
}

func seriesKey(coin, interval string) string {
	return coin + "|" + interval
}

// parseSnapshotReq extracts coin/interval/range from a candleSnapshot body.
func parseSnapshotReq(body map[string]interface{}) (coin, interval string, startMs, endMs int64, ok bool) {
	req, _ := body["req"].(map[string]interface{})
	if req == nil {
		return "", "", 0, 0, false
	}
	coin, _ = req["coin"].(string)
	interval, _ = req["interval"].(string)
	startMs = int64(numericToFloat64(req["startTime"]))
	endMs = int64(numericToFloat64(req["endTime"]))
	if coin == "" || interval == "" || startMs <= 0 || endMs <= startMs {
		return "", "", 0, 0, false
	}
	return coin, interval, startMs, endMs, true
}

// ChargePassthrough deducts a passthrough candleSnapshot's estimated Hyperliquid
// IP weight from the shared candle budget without blocking, so the background
// warm-up (which wait()s on that budget) yields the per-IP allowance to
// interactive chart loads the user is actively triggering. No-op for non-candle
// bodies or when preloading is disabled.
func (s *Store) ChargePassthrough(body map[string]interface{}) {
	if s == nil || s.budget == nil {
		return
	}
	_, interval, startMs, endMs, ok := parseSnapshotReq(body)
	if !ok {
		return
	}
	s.budget.charge(passthroughCandleWeight(interval, startMs, endMs))
}

// SetBudgetWaitObserver registers a callback receiving the total blocked time
// of each background budget wait that actually blocked (metrics hook). Call
// once at wiring time, before background loops start.
func (s *Store) SetBudgetWaitObserver(fn func(time.Duration)) {
	if s == nil || s.budget == nil {
		return
	}
	s.budget.observeWait = fn
}

// PenalizeRateLimit forces the shared candle budget to yield extra headroom
// right now, in response to a real 429 observed either on an interactive
// passthrough or a background fetch. Complements ChargePassthrough/wait: those
// pace off perMin's static assumption, this corrects it live when Hyperliquid
// actually rejects a request, rather than waiting out the configured rate.
func (s *Store) PenalizeRateLimit() {
	if s == nil || s.budget == nil {
		return
	}
	s.budget.penalize()
}

// passthroughCandleWeight estimates a candleSnapshot's budget cost the same way
// fetchChunked does (20 base + 1 per 60 candles).
func passthroughCandleWeight(interval string, startMs, endMs int64) int {
	ms := intervalMs(interval)
	if ms <= 0 || endMs <= startMs {
		return 20
	}
	return 20 + int((endMs-startMs)/ms/60)
}

// ServeInfoRequest serves a candleSnapshot request body from memory when the
// store covers the requested range. The bool reports whether it served.
//
// A request reaching further back than coverage is served CLIPPED to coverage
// when the clipped span is at least what upstream's 5000-candle response cap
// would return anyway — the client cannot tell the difference from upstream's
// own head-truncation, and passing it through instead would burn real IP
// allowance on an answer no better than ours. This breaks a starvation loop:
// deep requests (e.g. the 150d CVD source) exceed the cap, so the passthrough
// can never complete coverage, while each passthrough risks a 429 whose
// penalty zeroes the background budget that the deepening warm needs. Serving
// clipped stops the passthrough churn; the kicked WarmOnDemand deepens
// coverage on the budget lane until the registered lookback is satisfied,
// after which requests serve in full.
func (s *Store) ServeInfoRequest(body map[string]interface{}) ([]byte, bool) {
	coin, interval, startMs, endMs, ok := parseSnapshotReq(body)
	if !ok {
		return nil, false
	}
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return nil, false
	}
	// The user is asking for this series — refresh its idle clock even when
	// degraded/gapped serving declines below.
	ser.lastNeededMs.Store(time.Now().UnixMilli())

	nowMs := time.Now().UnixMilli()
	var warmAfterCopy bool
	ser.mu.RLock()
	// feedUnavailable: shed permanent feed — historical / still-fresh tails OK.
	// degraded (restore or WS outage): immutable history is safe. Live-edge
	// serves only when the tail was verified within degradedLiveFreshMs;
	// otherwise the request passthroughs and scheduleTailRepair heals it.
	feedSafe := !ser.feedUnavailable || requestIsHistoricalOrTailFresh(ser.candles, ser.intervalMs, ser.verifiedThroughMs, endMs, nowMs)
	historyReady := ser.coverageStartMs != 0 && ser.unverifiedGapFromMs == 0
	liveEdgeOK := !ser.degraded || degradedLiveEdgeOK(ser, endMs, nowMs)
	healTail := ser.degraded && historyReady && len(ser.candles) > 0 && !requestIsHistoricalOnly(ser.intervalMs, endMs, nowMs)
	servable := historyReady && feedSafe && liveEdgeOK
	coverageStart := ser.coverageStartMs
	if !servable {
		ser.mu.RUnlock()
		if healTail {
			go s.scheduleTailRepair(coin, interval)
		}
		return nil, false
	}
	if startMs < coverageStart {
		capSpanMs := int64(chartrequirements.UpstreamCandleCap) * intervalMs(interval)
		if capSpanMs <= 0 || endMs-coverageStart < capSpanMs {
			ser.mu.RUnlock()
			return nil, false
		}
		warmAfterCopy = true
		startMs = coverageStart
	}
	// Copy under the same lock that observed no unverified gap so a WS jump
	// cannot be published as a complete series.
	slice := ser.copyRangeLocked(startMs, endMs)
	ser.mu.RUnlock()
	if warmAfterCopy {
		go s.WarmOnDemand(coin, interval)
	} else if healTail {
		go s.scheduleTailRepair(coin, interval)
	}
	// Composite CVD is only defined for enrichable display timeframes. 1m must
	// not inherit full 5m source volume; 1w/1M skip CVD entirely.
	if chartrequirements.CvdEnabled(interval) {
		slice = s.ComputeCvdDeltas(coin, slice)
	}
	payload, err := json.Marshal(slice)
	if err != nil {
		return nil, false
	}
	return payload, true
}

// HydrateInfoRequest is the non-blocking, store-first path used by speculative
// browser hydration. It never performs a foreground passthrough. A safe cache
// hit is returned immediately; a miss schedules exactly one budget-paced full
// warm or tail/gap repair and reports false so the HTTP boundary can answer
// 202. This prevents a 600-day RVWAP preload from competing with the chart the
// user is currently viewing while still making the next probe a memory hit.
func (s *Store) HydrateInfoRequest(body map[string]interface{}) ([]byte, bool) {
	if payload, ok := s.ServeInfoRequest(body); ok {
		return payload, true
	}
	coin, interval, startMs, endMs, ok := parseSnapshotReq(body)
	if !ok {
		return nil, false
	}
	lookbackMs := lookbackForLiveRequest(interval, startMs, endMs)
	if lookbackMs <= 0 {
		return nil, false
	}
	ser := s.registerOnDemand(coin, interval, lookbackMs)
	if ser == nil {
		return nil, false
	}
	ser.lastNeededMs.Store(time.Now().UnixMilli())

	ser.mu.RLock()
	coverageReady := ser.coverageStartMs != 0 && ser.coverageStartMs <= startMs
	coverageStartMs := ser.coverageStartMs
	gapFromMs := ser.unverifiedGapFromMs
	verifiedThroughMs := ser.verifiedThroughMs
	intervalMs := ser.intervalMs
	lastOpenMs := int64(0)
	if len(ser.candles) > 0 {
		lastOpenMs = ser.candles[len(ser.candles)-1].OpenMs
	}
	ser.mu.RUnlock()

	if !coverageReady {
		go s.WarmOnDemand(coin, interval)
		return nil, false
	}

	// The deep history is present; repair only the uncertain suffix. Starting
	// one interval before both the verified boundary and last row gives merge a
	// deterministic overlap while also covering a closed-market weekend whose
	// last actual candle is legitimately old.
	repairFromMs := gapFromMs
	for _, candidate := range []int64{verifiedThroughMs - intervalMs, lastOpenMs - intervalMs} {
		if candidate > 0 && (repairFromMs == 0 || candidate < repairFromMs) {
			repairFromMs = candidate
		}
	}
	if repairFromMs <= 0 {
		go s.WarmOnDemand(coin, interval)
		return nil, false
	}
	if repairFromMs < coverageStartMs {
		repairFromMs = coverageStartMs
	}
	if repairFromMs >= endMs {
		repairFromMs = endMs - 2*intervalMs
	}
	go s.repairOnDemand(coin, interval, repairFromMs)
	return nil, false
}

// lookbackForLiveRequest promotes a live-edge dependency to the depth it
// explicitly requested while leaving historical scrollback from old ranges
// unable to grow permanent retention without bound. RVWAP uses this to deepen
// the shared 4h display series from the 190-day chart window to 600 days
// only when requested.
func lookbackForLiveRequest(interval string, startMs, endMs int64) int64 {
	lookbackMs := lookbackForInterval(interval)
	intervalWidthMs := intervalMs(interval)
	if intervalWidthMs <= 0 || endMs < time.Now().UnixMilli()-2*intervalWidthMs {
		return lookbackMs
	}
	if span := endMs - startMs; span >= lookbackMs {
		// The warm starts after this request was stamped. Retaining exactly span
		// from the warmer's later clock makes its new coverageStart a few
		// milliseconds newer than startMs, so the same request can remain a miss
		// forever — including the common exact-600d RVWAP probe against a 4h
		// series already registered at 600d. One source bucket covers
		// scheduler/budget delay and provides a deterministic overlap for the
		// next probe (4h for the RVWAP source).
		lookbackMs = span + intervalWidthMs
	}
	return lookbackMs
}

// requestIsHistoricalOnly is true when the request ends well before the live
// edge. Used while `degraded` so restore/outage distrust never serves a live
// tail from memory, while still allowing immutable history hits.
func requestIsHistoricalOnly(interval, endMs, nowMs int64) bool {
	return interval > 0 && endMs < nowMs-2*interval
}

// requestIsHistoricalOrTailFresh lets a cache series remain useful after its
// permanent websocket feed is intentionally shed. Historical ranges are
// immutable. A live-edge range is safe only while the cached tail is recent;
// after that it falls through to REST, whose merge refreshes it for another
// interval window. This keeps hundreds of historical series cacheable without
// requiring hundreds of permanent upstream subscriptions.
func requestIsHistoricalOrTailFresh(candles []Candle, interval, verifiedThroughMs, endMs, nowMs int64) bool {
	if interval <= 0 {
		return false
	}
	if requestIsHistoricalOnly(interval, endMs, nowMs) {
		return true
	}
	// A recent complete REST range is authoritative even when a sparse market
	// produced no candle near its end. Allow one interval of drift; after that a
	// dormant, feed-shed series falls through and refreshes normally.
	if verifiedThroughMs > 0 && verifiedThroughMs+interval >= endMs {
		return true
	}
	if len(candles) == 0 {
		return false
	}
	lastOpen := candles[len(candles)-1].OpenMs
	return lastOpen+2*interval >= endMs
}

// directionalDelta returns sign(close-open) * volume for a candle.
// Returns 0 on parse errors or doji bars.
func directionalDelta(c Candle) float64 {
	open, err1 := strconv.ParseFloat(c.Open, 64)
	close, err2 := strconv.ParseFloat(c.Close, 64)
	vol, err3 := strconv.ParseFloat(c.Volume, 64)
	if err1 != nil || err2 != nil || err3 != nil || vol <= 0 {
		return 0
	}
	if close > open {
		return vol
	}
	if close < open {
		return -vol
	}
	return 0
}

// bucketEndMs returns the end of candle i's bucket: the next candle's open
// when there is one, else inferred from the candle's own interval label,
// else a 1h default.
func bucketEndMs(candles []Candle, i int) int64 {
	if i+1 < len(candles) && candles[i+1].OpenMs > candles[i].OpenMs {
		return candles[i+1].OpenMs
	}
	if candles[i].Interval != "" {
		if ms := intervalMs(candles[i].Interval); ms > 0 {
			return candles[i].OpenMs + ms
		}
	}
	return candles[i].OpenMs + 3600000 // 1h default
}

func candleVolume(c Candle) float64 {
	vol, err := strconv.ParseFloat(c.Volume, 64)
	if err != nil {
		return 0
	}
	return vol
}

// copyRangeLocked returns candles in [startMs, endMs] (inclusive). Caller holds ser.mu.
func (ser *series) copyRangeLocked(startMs, endMs int64) []Candle {
	lo := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= startMs })
	hi := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs > endMs })
	slice := make([]Candle, hi-lo)
	copy(slice, ser.candles[lo:hi])
	return slice
}

// getSlice returns a copy of the candles in [startMs, endMs] (inclusive).
func (ser *series) getSlice(startMs, endMs int64) []Candle {
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	return ser.copyRangeLocked(startMs, endMs)
}

// WarmOnDemand brings a cold or off-list series into the store in the
// background so a follow-up view serves from memory (~2ms) instead of paying
// another passthrough. The chart the user just clicked is already served by the
// proxy's fast passthrough; this fills the full lookback on the background
// budget lane without blocking that request. Off-list coins are registered and
// wired to the market-WS feed so they stay fresh. It is single-flighted per
// (coin, interval): concurrent calls — rapid re-clicks, parallel tabs — collapse
// onto one fetch. Intended to be invoked as `go store.WarmOnDemand(...)`.
func (s *Store) WarmOnDemand(coin, interval string) {
	s.warmOnDemand(coin, interval, 0, true)
}

// WarmDisplay fills only the visible chart window for a coin/interval so
// movers and watchlist become store-servable without waiting for a 400d+
// deepen of already-ready series. The series is still registered at the
// extended lookback so a later WarmOnDemand can keep extra history.
func (s *Store) WarmDisplay(coin, interval string) {
	s.warmOnDemand(coin, interval, displayLookbackForInterval(interval), true)
}

// warmOnDemand implements WarmOnDemand. expandCvdSources is false for the
// child source warms it starts, preventing the 5m and 30m sources from
// recursively scheduling each other forever once both are already covered.
func (s *Store) warmOnDemand(coin, interval string, fetchLookbackMs int64, expandCvdSources bool) {
	if coin == "" || interval == "" {
		return
	}

	// Ensure CVD source series are registered (and WS-fed) so ComputeCvdDeltas
	// can find them even if preloading hasn't completed yet.
	s.registerCvdSources(coin, interval)

	ser := s.getSeries(coin, interval)
	if ser == nil {
		lookbackMs := lookbackForInterval(interval)
		if lookbackMs <= 0 {
			return
		}
		ser = s.registerOnDemand(coin, interval, lookbackMs)
		if ser == nil {
			return
		}
	}
	ser.lastNeededMs.Store(time.Now().UnixMilli())

	nowMs := time.Now().UnixMilli()
	if fetchLookbackMs <= 0 {
		ser.mu.RLock()
		fetchLookbackMs = ser.lookbackMs
		ser.mu.RUnlock()
	}
	ser.mu.RLock()
	lookbackSatisfied := coverageReachesLookback(ser.coverageStartMs, ser.interval, fetchLookbackMs, nowMs)
	covered := lookbackSatisfied && !ser.degraded && ser.unverifiedGapFromMs == 0
	ser.mu.RUnlock()
	if covered {
		// A covered display series can still have degraded/missing composite
		// sources after snapshot restore. This early return used to skip source
		// repair permanently, so repeated chart refetches could never upgrade
		// their nil cvdDelta values. Repair the sources even when the price series
		// itself needs no fetch.
		if expandCvdSources {
			s.warmCvdSourcesAsync(coin, interval)
		}
		return
	}

	key := seriesKey(coin, interval)
	if !s.beginWarm(key, fetchLookbackMs) {
		return
	}
	defer s.finishWarm(coin, interval, key, expandCvdSources)

	if err := s.preloadSeriesDepth(s.lifecycleCtx, coin, interval, fetchLookbackMs); err != nil {
		logFetchErr("on-demand warm", coin, interval, err)
	}

	// Warm CVD source series in parallel so ComputeCvdDeltas can produce
	// cross-timeframe deltas from the 5m/30m composite source.
	if expandCvdSources {
		s.warmCvdSourcesAsync(coin, interval)
	}
}

func (s *Store) beginWarm(key string, wantMs int64) bool {
	s.warmMu.Lock()
	defer s.warmMu.Unlock()
	if flight, ok := s.warming[key]; ok {
		if wantMs > flight.wantMs {
			flight.wantMs = wantMs
		}
		return false
	}
	s.warming[key] = &warmFlight{startedMs: wantMs, wantMs: wantMs}
	return true
}

func (s *Store) endWarm(key string) (startedMs, wantMs int64) {
	s.warmMu.Lock()
	defer s.warmMu.Unlock()
	flight := s.warming[key]
	delete(s.warming, key)
	if flight == nil {
		return 0, 0
	}
	return flight.startedMs, flight.wantMs
}

func (s *Store) finishWarm(coin, interval, key string, expandCvdSources bool) {
	startedMs, wantMs := s.endWarm(key)
	if wantMs <= startedMs {
		return
	}
	ser := s.getSeries(coin, interval)
	if ser == nil {
		return
	}
	nowMs := time.Now().UnixMilli()
	ser.mu.RLock()
	satisfied := coverageReachesLookback(ser.coverageStartMs, ser.interval, wantMs, nowMs)
	ser.mu.RUnlock()
	if satisfied {
		return
	}
	go s.warmOnDemand(coin, interval, wantMs, expandCvdSources)
}

// logFetchErr reports a background candle fetch failure unless shutdown
// canceled the lifecycle context — that is teardown, not a repair error.
func logFetchErr(op, coin, interval string, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	log.Printf("candlecache: %s failed coin=%s interval=%s: %v", op, coin, interval, err)
}

// repairOnDemand verifies only a covered series' uncertain suffix. It shares
// the same per-series single-flight as a full WarmOnDemand so hydrate probes,
// reconnect repair, and the warm coordinator cannot duplicate upstream work.
func (s *Store) repairOnDemand(coin, interval string, fromMs int64) {
	if coin == "" || interval == "" || fromMs <= 0 {
		return
	}
	key := seriesKey(coin, interval)
	if !s.beginWarm(key, 0) {
		return
	}
	defer s.finishWarm(coin, interval, key, true)

	ser := s.getSeries(coin, interval)
	if ser == nil {
		return
	}
	endMs := time.Now().UnixMilli()
	if fromMs >= endMs {
		return
	}
	ser.mu.RLock()
	genAtStart := ser.gapGen
	ser.mu.RUnlock()
	candles, err := s.fetchChunked(s.lifecycleCtx, coin, interval, fromMs, endMs)
	if err != nil {
		logFetchErr("hydrate repair", coin, interval, err)
		return
	}
	s.applyVerifiedRange(ser, candles, fromMs, endMs, genAtStart, false)
}

func (s *Store) warmCvdSourcesAsync(coin, interval string) {
	requirement, ok := chartrequirements.ForTimeframe(interval)
	if !ok {
		return
	}
	for _, source := range requirement.CvdSources {
		if interval != source.Interval {
			go s.warmOnDemand(coin, source.Interval, 0, false)
		}
	}
}

// ApplyWSCandle merges an upstream candle-WS message. Runs on the single
// market-WS read goroutine, so the common paths (in-place tail update,
// contiguous append) must stay cheap; gap repair is handed to the backfill
// worker, never done inline.
func (s *Store) ApplyWSCandle(wsMsg map[string]interface{}) {
	data, ok := wsMsg["data"].(map[string]interface{})
	if !ok {
		return
	}
	c, ok := candleFromMap(data)
	if !ok {
		return
	}
	ser := s.getSeries(c.Symbol, c.Interval)
	if ser == nil {
		return
	}
	wsConnected := s.isWSConnected()

	var backfillFrom int64
	ser.mu.Lock()
	// A valid upstream candle proves that this series is again receiving a live
	// feed. Do not clear this state from REST merges: they only repair a point in
	// time and would let the tail silently age again after a shed feed.
	ser.feedUnavailable = false
	n := len(ser.candles)
	switch {
	case n == 0:
		// Preload hasn't landed yet; keep the live tail, coverage stays 0.
		ser.candles = append(ser.candles, c)
	case c.OpenMs == ser.candles[n-1].OpenMs:
		if c.Trades >= ser.candles[n-1].Trades {
			ser.candles[n-1] = c
		}
		if wsConnected {
			ser.degraded = false
		}
	case isNextOpen(ser.candles[n-1].OpenMs, c.OpenMs, ser.interval):
		if ser.degraded {
			// The previous bucket may have missed its final trades while the
			// WS was down; a cheap backfill re-snapshots its close.
			backfillFrom = ser.candles[n-1].OpenMs
			if wsConnected {
				ser.degraded = false
			}
		}
		ser.candles = append(ser.candles, c)
	case c.OpenMs > ser.candles[n-1].OpenMs:
		// Jumped more than one bucket: record the unverified gap so serving
		// declines until a backfill or covering passthrough verifies the
		// range. (Setting degraded instead would not survive the next
		// same-bucket tick, which clears it — the store would serve the
		// hole as real data while the backfill is still queued.)
		if ser.unverifiedGapFromMs == 0 || ser.candles[n-1].OpenMs < ser.unverifiedGapFromMs {
			ser.unverifiedGapFromMs = ser.candles[n-1].OpenMs
		}
		ser.gapGen++
		ser.candles = append(ser.candles, c)
	default:
		ser.candles = mergeCandles(ser.candles, []Candle{c})
	}
	// While a gap is unverified, every tick retries the enqueue (after the
	// cooldown): a send dropped on a full queue — e.g. all series gapping at
	// once after a wake — must not orphan the gap permanently.
	if ser.unverifiedGapFromMs != 0 && (backfillFrom == 0 || ser.unverifiedGapFromMs < backfillFrom) {
		backfillFrom = ser.unverifiedGapFromMs
	}
	if backfillFrom > 0 && time.Since(ser.lastBackfillAt) >= backfillCooldown {
		ser.lastBackfillAt = time.Now()
	} else {
		backfillFrom = 0
	}
	ser.mu.Unlock()

	if backfillFrom > 0 {
		select {
		case s.backfillCh <- backfillReq{coin: c.Symbol, interval: c.Interval, fromMs: backfillFrom}:
		default:
			// Queue full: stay degraded; the next candle re-enqueues after
			// the cooldown.
		}
	}
}

// OnCandleFeedDropped marks a series as no longer live-fed by the upstream
// market websocket. Historical and still-fresh ranges remain cacheable;
// live-edge requests fall through once the cached tail ages and are refreshed
// by REST until an active chart subscription supplies real ticks again.
func (s *Store) OnCandleFeedDropped(coin, interval string) {
	if ser := s.getSeries(coin, interval); ser != nil {
		ser.mu.Lock()
		ser.feedUnavailable = true
		ser.mu.Unlock()
	}
}

// MergePassthrough folds an upstream candleSnapshot response that passed
// through the proxy into the store, extending coverage. This makes a
// degraded or cold series self-healing: the very passthrough the frontend
// triggers also repairs it.
func (s *Store) MergePassthrough(body map[string]interface{}, respBody []byte) {
	coin, interval, startMs, endMs, ok := parseSnapshotReq(body)
	if !ok {
		return
	}
	ser := s.getSeries(coin, interval)
	if ser == nil {
		// Passthrough returned data for a series the store doesn't know yet —
		// register it so the data is folded in and the next request serves
		// directly from the store with cvdDelta. Intervals outside
		// DefaultSeries (lookback 0) are rejected by RegisterSeries.
		ser = s.registerOnDemand(coin, interval, lookbackForLiveRequest(interval, startMs, endMs))
		// Also register CVD source series so ComputeCvdDeltas can find them.
		s.registerCvdSources(coin, interval)
		if ser == nil {
			return
		}
	} else {
		// A deeper live-edge consumer (the 600-day RVWAP source) must promote an
		// existing 175-day display series before pruning can discard the response.
		ser = s.registerOnDemand(coin, interval, lookbackForLiveRequest(interval, startMs, endMs))
	}
	ser.lastNeededMs.Store(time.Now().UnixMilli())
	ser.mu.RLock()
	genAtStart := ser.gapGen
	ser.mu.RUnlock()
	var candles []Candle
	if err := json.Unmarshal(respBody, &candles); err != nil {
		return
	}
	s.applyFetchedRange(ser, candles, startMs, endMs, genAtStart)
}

const degradedLiveFreshMs = int64(2 * time.Minute / time.Millisecond)

func degradedLiveEdgeOK(ser *series, endMs, nowMs int64) bool {
	if ser == nil {
		return false
	}
	if requestIsHistoricalOnly(ser.intervalMs, endMs, nowMs) {
		return true
	}
	if ser.verifiedThroughMs <= 0 || nowMs-ser.verifiedThroughMs > degradedLiveFreshMs {
		return false
	}
	return requestIsHistoricalOrTailFresh(ser.candles, ser.intervalMs, ser.verifiedThroughMs, endMs, nowMs)
}

func coverageReachesLookback(coverageStartMs int64, interval string, lookbackMs, nowMs int64) bool {
	if coverageStartMs == 0 || lookbackMs <= 0 {
		return false
	}
	return coverageStartMs <= nowMs-chartrequirements.ReachableLookbackMs(interval, lookbackMs)
}

// applyFetchedRange merges a fetched [startMs, endMs] range into the series and
// updates coverage/gap/degraded bookkeeping. Shared by MergePassthrough (proxy
// passthrough responses) and the on-demand WarmOnDemand path. genAtStart is
// the gapGen captured before the fetch began: a jump that landed mid-flight
// lies beyond the fetched range, so its marker must survive.
func (s *Store) applyFetchedRange(ser *series, candles []Candle, startMs, endMs int64, genAtStart uint64) {
	s.applyRange(ser, candles, startMs, endMs, genAtStart, false, true)
}

func (s *Store) applyRange(ser *series, candles []Candle, startMs, endMs int64, genAtStart uint64, claimRequestedStart, capTruncates bool) {
	wsConnected := s.isWSConnected()
	nowMs := time.Now().UnixMilli()

	// A cap-sized response was head-truncated: claim coverage (and vouch for
	// gaps) only from the first candle actually returned, not the requested
	// start. Claiming the unfetched head would pin the series shallow forever —
	// WarmOnDemand sees "covered" and skips deepening, and the store would
	// serve requests for the missing head as if it were real history. Short-
	// history coins return fewer than the cap, so their requested-range
	// coverage semantics are unchanged.
	if capTruncates && len(candles) >= chartrequirements.UpstreamCandleCap {
		firstOpen := int64(0)
		for _, c := range candles {
			if firstOpen == 0 || c.OpenMs < firstOpen {
				firstOpen = c.OpenMs
			}
		}
		if firstOpen > startMs {
			startMs = firstOpen
		}
	}

	ser.mu.Lock()
	defer ser.mu.Unlock()

	reachesPresent := endMs >= nowMs-2*ser.intervalMs
	adjoinsCoverage := ser.coverageStartMs > 0 && endMs >= ser.coverageStartMs-ser.intervalMs

	if len(candles) == 0 {
		// Empty REST is proof of "no trades in range" only for an already
		// populated series. It must not pin coverageStartMs — not even when
		// claimRequestedStart is true. A cold series (or a live tail that
		// landed while the fetch was in flight) would otherwise look warm
		// forever and ServeInfoRequest would copy a one-bar range as history.
		if reachesPresent && len(ser.candles) > 0 {
			if ser.gapGen == genAtStart && startMs <= ser.unverifiedGapFromMs && ser.unverifiedGapFromMs != 0 {
				ser.unverifiedGapFromMs = 0
			}
			if wsConnected {
				ser.degraded = false
			}
			if endMs > ser.verifiedThroughMs {
				ser.verifiedThroughMs = endMs
			}
		}
		return
	}

	ser.candles = mergeCandles(ser.candles, candles)
	if claimRequestedStart {
		if ser.coverageStartMs == 0 || startMs < ser.coverageStartMs {
			ser.coverageStartMs = startMs
		}
		if ser.gapGen == genAtStart && ser.unverifiedGapFromMs != 0 && startMs <= ser.unverifiedGapFromMs {
			ser.unverifiedGapFromMs = 0
		}
		if wsConnected {
			ser.degraded = false
		}
		if endMs > ser.verifiedThroughMs {
			ser.verifiedThroughMs = endMs
		}
		return
	}

	// Only requests whose range reaches the present (a chart's main fetch)
	// or adjoins existing coverage (scrollback) may extend coverage. A pure
	// historical fetch on a cold series must not: it would claim coverage
	// up to "now" while the tail between its endTime and the present is
	// missing, and later requests would be served with that hole.
	if (reachesPresent || adjoinsCoverage) && (ser.coverageStartMs == 0 || startMs < ser.coverageStartMs) {
		ser.coverageStartMs = startMs
	}
	// An unverified gap clears only when the merged range covers it through
	// to the present; a short tail probe reaching the present must not
	// vouch for an older hole it never fetched.
	if ser.gapGen == genAtStart && reachesPresent && startMs <= ser.unverifiedGapFromMs && ser.unverifiedGapFromMs != 0 {
		ser.unverifiedGapFromMs = 0
	}
	if wsConnected && reachesPresent {
		ser.degraded = false
	}
	if reachesPresent && endMs > ser.verifiedThroughMs {
		ser.verifiedThroughMs = endMs
	}
}

func (s *Store) isWSConnected() bool {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	return s.wsConnected
}

// OnMarketWSDown marks every series degraded: with no live updates the
// tails would silently age, so requests fall back to the proxy.
func (s *Store) OnMarketWSDown() {
	s.wsMu.Lock()
	s.wsConnected = false
	s.wsMu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ser := range s.series {
		ser.mu.Lock()
		ser.degraded = true
		ser.mu.Unlock()
	}
}

// OnMarketWSReconnect records connectivity but leaves series degraded; each
// one clears on its first contiguous candle, verifying backfill, or
// passthrough merge. (Clearing everything here would either trust possibly
// stale tails or trigger a backfill storm across all series.)
func (s *Store) OnMarketWSReconnect() {
	s.wsMu.Lock()
	s.wsConnected = true
	s.wsMu.Unlock()
}

func (s *Store) runBackfillWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case req := <-s.backfillCh:
			s.processBackfill(ctx, req)
		}
	}
}

func (s *Store) processBackfill(ctx context.Context, req backfillReq) {
	ser := s.getSeries(req.coin, req.interval)
	if ser == nil {
		return
	}
	endMs := time.Now().UnixMilli()
	if req.fromMs <= 0 || req.fromMs >= endMs {
		return
	}
	ser.mu.RLock()
	genAtStart := ser.gapGen
	ser.mu.RUnlock()
	candles, err := s.fetchChunked(ctx, req.coin, req.interval, req.fromMs, endMs)
	if err != nil {
		logFetchErr("backfill", req.coin, req.interval, err)
		return
	}
	s.applyFetchedRange(ser, candles, req.fromMs, endMs, genAtStart)
}

func (s *Store) runPruneLoop(ctx context.Context) {
	ticker := time.NewTicker(pruneInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			s.pruneOnce(now)
			s.evictIdleSeries(now)
		}
	}
}

// evictIdleSeries removes whole series that nothing has needed for
// seriesIdleTTL, returning how many were evicted. This is what bounds the
// series SET (pruneOnce only bounds each series' depth): without it, every
// off-list coin ever clicked and every mover that churned through the warm
// union stays in memory, in the snapshot, and holds a permanent upstream WS
// subscription forever.
//
// The CVD source intervals (5m/30m) inherit their coin's freshest clock:
// ComputeCvdDeltas reads them without touching, so their own clock goes stale
// while any chart of that coin still needs them. Propagating the coin-level
// max INTO their lastNeededMs (rather than special-casing the comparison)
// keeps the write-lock recheck and the snapshot save/load idle-skips all
// judging the same per-series value.
//
// Races are benign by construction: victims are re-checked by pointer under
// the write lock, so a concurrent re-registration survives; an in-flight
// warm/backfill holding the old pointer merges into an orphaned object the GC
// collects; a WS tick for an evicted series drops at getSeries == nil; the
// next chart load passthroughs and re-registers via MergePassthrough.
func (s *Store) evictIdleSeries(now time.Time) int {
	cutoff := now.UnixMilli() - seriesIdleTTL.Milliseconds()
	nowMs := now.UnixMilli()

	type candidate struct {
		key string
		ser *series
	}
	var victims []candidate

	s.mu.RLock()
	sers := make([]*series, 0, len(s.series))
	for _, ser := range s.series {
		sers = append(sers, ser)
	}
	coinMax := coinNeededMax(sers, nowMs)
	for key, ser := range s.series {
		if ser.interval == cvdRecentInterval || ser.interval == cvdDeepInterval {
			if max := coinMax[ser.coin]; max > ser.lastNeededMs.Load() {
				ser.lastNeededMs.Store(max)
			}
		}
		if effectiveLastNeededMs(ser, coinMax, nowMs) < cutoff {
			victims = append(victims, candidate{key: key, ser: ser})
		}
	}
	s.mu.RUnlock()

	if len(victims) == 0 {
		return 0
	}

	evicted := victims[:0]
	s.mu.Lock()
	for _, v := range victims {
		// Same pointer and still idle: a re-registration or a touch that
		// landed after the scan wins over the stale eviction decision.
		if s.series[v.key] != v.ser || v.ser.lastNeededMs.Load() >= cutoff {
			continue
		}
		// For CVD sources (5m/30m), recheck if any active series for this coin
		// is still needed before deleting the source series.
		if v.ser.interval == cvdRecentInterval || v.ser.interval == cvdDeepInterval {
			coinStillNeeded := false
			for _, otherSer := range s.series {
				if otherSer.coin == v.ser.coin && otherSer != v.ser {
					if lastNeededOrNow(otherSer, nowMs) >= cutoff {
						coinStillNeeded = true
						v.ser.lastNeededMs.Store(lastNeededOrNow(otherSer, nowMs))
						break
					}
				}
			}
			if coinStillNeeded {
				continue
			}
		}
		delete(s.series, v.key)
		evicted = append(evicted, v)
	}
	s.mu.Unlock()

	if len(evicted) == 0 {
		return 0
	}
	if s.onEvict != nil {
		for _, v := range evicted {
			s.onEvict(v.ser.coin, v.ser.interval)
		}
	}
	log.Printf("candlecache: evicted %d idle series (unneeded for %s)", len(evicted), seriesIdleTTL)
	return len(evicted)
}

func lastNeededOrNow(ser *series, nowMs int64) int64 {
	last := ser.lastNeededMs.Load()
	if last == 0 {
		return nowMs
	}
	return last
}

func coinNeededMax(sers []*series, nowMs int64) map[string]int64 {
	coinMax := make(map[string]int64, len(sers))
	for _, ser := range sers {
		last := lastNeededOrNow(ser, nowMs)
		if last > coinMax[ser.coin] {
			coinMax[ser.coin] = last
		}
	}
	return coinMax
}

// effectiveLastNeededMs is the idle clock save and evict both judge.
// 5m/30m CVD sources inherit the coin's freshest stamp because ComputeCvdDeltas
// reads them without touching lastNeeded.
func effectiveLastNeededMs(ser *series, coinMax map[string]int64, nowMs int64) int64 {
	last := lastNeededOrNow(ser, nowMs)
	if ser.interval == cvdRecentInterval || ser.interval == cvdDeepInterval {
		if max := coinMax[ser.coin]; max > last {
			return max
		}
	}
	return last
}

func (s *Store) pruneOnce(now time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ser := range s.series {
		ser.mu.Lock()
		cutoff := now.UnixMilli() - ser.lookbackMs - pruneSlack.Milliseconds()
		idx := sort.Search(len(ser.candles), func(i int) bool { return ser.candles[i].OpenMs >= cutoff })
		if idx > 0 {
			ser.candles = append([]Candle(nil), ser.candles[idx:]...)
			if ser.coverageStartMs < cutoff {
				ser.coverageStartMs = cutoff
			}
		}
		ser.mu.Unlock()
	}
}
