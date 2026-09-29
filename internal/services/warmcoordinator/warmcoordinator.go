// Package warmcoordinator decides what the server keeps warm in the candle
// store and in what order. It is the single authority that replaces the old
// one-shot startup preload.
//
// It unions the clickable ticker lists the UI actually shows — pinned markets,
// the top gainers/losers, the market-mispricing candidates, and the user
// watchlist — and warms them in strict priority:
//
//	Tier 0 (active charts, first): the (coin, interval) series clients are
//	  viewing right now (ActiveSeries), warmed before everything and re-checked
//	  between every bulk item so a chart selected mid-pass at cold start is
//	  servable soonest instead of waiting out the hot-set sweep.
//	Tier 1 (charts): the interactive chart timeframes, pinned coins fully first
//	  (hot-set) so the default view is servable fastest, then the rest.
//	Tier 2 (references): closed-session MISPRICE 1m close references.
//	Tier 3 (radar/deep, last): the cheap long-history 1w/1M series the long-
//	  horizon charts and the market-radar regime read.
//
// Everything is paced by the candle store's background weight budget (the
// injected Warm func blocks on it), so the warm-up never bursts Hyperliquid's
// per-IP allowance and always yields to interactive chart loads. After the
// initial pass it fills display windows for the clickable union (watchlist,
// movers, pinned) so those charts serve from the store and persist into the
// next snapshot, then optionally deepens already-ready series toward exchange
// retention. Outage recovery of warm-but-degraded series stays on the heal path.
package warmcoordinator

import (
	"context"
	"log"
	"time"
)

// Deps are the coordinator's injected collaborators. Keeping them as plain
// functions keeps this package free of any candlecache/services/websocket
// import (and therefore any import cycle) and makes it trivially testable.
type Deps struct {
	// Pinned are always-warm curated markets (warmed first as the hot set).
	Pinned []string
	// MaxCoins bounds the warm union. Pinned coins are retained even if they
	// exceed the configured cap; dynamic candidates fill the remaining slots.
	MaxCoins int

	// MoverCoins, MispriceCoins, and Watchlist return the dynamic clickable
	// sets. Any may return nil (transient upstream error / empty watchlist);
	// the coordinator just unions what it gets this tick.
	MoverCoins    func(ctx context.Context) []string
	MispriceCoins func(ctx context.Context) []string
	Watchlist     func() []string

	// ActiveSeries returns the (coin, interval) chart series clients are viewing
	// right now (from the market-WS candle subscriptions). The coordinator warms
	// these before everything else and re-checks them between bulk items, so the
	// chart a user just selected jumps to the front of the warm-up line and is
	// servable soonest — even when picked mid-pass during the cold-start warm.
	// May be nil (no signal); then no series gets active priority.
	ActiveSeries func() [][2]string

	// WarmReferences schedules missing close-reference resolutions. It must be
	// non-blocking; the resolver owns bounded workers and uses the same
	// background candle lane as Warm.
	WarmReferences func(ctx context.Context)

	// Warm brings one (coin, interval) fully into the store, blocking on the
	// weight budget (candlecache Store.WarmOnDemand called synchronously). It
	// registers + WS-subscribes the series as a side effect.
	Warm func(coin, interval string)

	// NeedsWarm reports a series still needs its *display-window* warm
	// (Store.NeedsDisplayWarm). True when unregistered, cold, or shorter
	// than the visible chart lookback. False once first-paint history is
	// in the store so movers/watchlist are clickable without waiting for
	// a 400d+ deepen of already-ready series.
	NeedsWarm func(coin, interval string) bool

	// NeedsDeepen reports coverage has the display window but not the
	// post-admit extended lookback. Optional; when nil, no deepen pass runs.
	NeedsDeepen func(coin, interval string) bool

	// Deepen fills the extended lookback (Store.WarmOnDemand). Optional.
	Deepen func(coin, interval string)

	// Touch refreshes a series' idle clock in the candle store WITHOUT
	// registering or fetching anything (Store.MarkNeeded). Called for every
	// series reconcile visits — warm or cold — so members of the current warm
	// union never age into the store's idle eviction, while coins that drop
	// off the lists stop being touched and get evicted after the TTL. May be
	// nil (no idle tracking).
	Touch func(coin, interval string)

	// CoreIntervals are the interactive chart timeframes (Tier 1); DeepIntervals
	// are the cheap long-history timeframes (Tier 2).
	CoreIntervals []string
	DeepIntervals []string

	// PreferCoins × PreferIntervals are the first post-admit display pass
	// (startup remainder TFs for the admit-set markets) so common switches
	// hit memory before the full clickable union.
	PreferCoins     []string
	PreferIntervals []string

	// MinMoverSlots reserves a minimum number of dynamic slots for MoverCoins
	// so a large user watchlist cannot completely starve top gainers/losers
	// from getting background warmed. Defaults to 10 when zero.
	MinMoverSlots int

	// NudgeCh allows external events (like a newly asserted watchlist) to trigger
	// an immediate reconcile pass without waiting for the next ReconcileInterval tick.
	NudgeCh <-chan struct{}

	// ReconcileInterval is how often the cold-only reconcile runs. Defaults to
	// 60s when zero.
	ReconcileInterval time.Duration
}

// Coordinator runs the tiered warm-up and the reconcile loop.
type Coordinator struct {
	d Deps
}

// New builds a Coordinator, filling in defaults.
func New(d Deps) *Coordinator {
	if d.ReconcileInterval <= 0 {
		d.ReconcileInterval = 60 * time.Second
	}
	if d.MinMoverSlots <= 0 {
		d.MinMoverSlots = 10
	}
	return &Coordinator{d: d}
}

// Run executes the initial tiered pass, then reconciles on the interval until
// ctx is cancelled. Blocking; intended to be launched as `go c.Run(ctx)`.
func (c *Coordinator) Run(ctx context.Context) {
	started := time.Now()
	c.reconcile(ctx)
	log.Printf("warmcoordinator: initial warm pass complete in %s", time.Since(started).Round(time.Second))

	ticker := time.NewTicker(c.d.ReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.reconcile(ctx)
		case <-c.d.NudgeCh:
			c.reconcile(ctx)
		}
	}
}

// reconcile warms the current clickable union in priority order, touching only
// series that are still cold. On the first call every series is cold, so this
// is the full initial pass; later calls only fill genuinely new/failed series.
func (c *Coordinator) reconcile(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	// Tier 0 — the chart(s) the user is viewing right now, ahead of everything.
	// Re-checked between every bulk item below too, so a chart selected mid-pass
	// at cold startup is warmed before the next bulk series rather than waiting
	// out the whole hot-set sweep.
	c.warmActive(ctx)

	for _, coin := range c.d.PreferCoins {
		for _, interval := range c.d.PreferIntervals {
			c.warmActive(ctx)
			c.warmIfCold(ctx, coin, interval)
		}
	}

	pinned, rest := c.partitionUnion(ctx)
	// Tier 1 — interactive chart timeframes (charts first). Pinned coins fully
	// first (hot-set) so the prominent default-view markets are servable soonest,
	// then the rest of the clickable universe interval-major.
	for _, coin := range pinned {
		for _, interval := range c.d.CoreIntervals {
			c.warmActive(ctx)
			c.warmIfCold(ctx, coin, interval)
		}
	}
	for _, interval := range c.d.CoreIntervals {
		for _, coin := range rest {
			c.warmActive(ctx)
			c.warmIfCold(ctx, coin, interval)
		}
	}

	// Tier 2 — close references after interactive chart work but before deep
	// history. Resolution remains asynchronous/non-blocking.
	c.warmActive(ctx)
	if ctx.Err() == nil && c.d.WarmReferences != nil {
		c.d.WarmReferences(ctx)
	}

	// Tier 3 — radar / deep history, after display charts.
	for _, interval := range c.d.DeepIntervals {
		for _, coin := range pinned {
			c.warmActive(ctx)
			c.warmIfCold(ctx, coin, interval)
		}
		for _, coin := range rest {
			c.warmActive(ctx)
			c.warmIfCold(ctx, coin, interval)
		}
	}

	// Tier 4 — extend already-clickable series toward exchange retention.
	// Must not run until the display union is store-servable, or restart
	// spends the budget re-fetching 416d of BTC 2h instead of AVAX 15m.
	if c.d.NeedsDeepen != nil && c.d.Deepen != nil {
		for _, coin := range pinned {
			for _, interval := range c.d.CoreIntervals {
				c.warmActive(ctx)
				c.deepenIfNeeded(ctx, coin, interval)
			}
		}
		for _, interval := range c.d.CoreIntervals {
			for _, coin := range rest {
				c.warmActive(ctx)
				c.deepenIfNeeded(ctx, coin, interval)
			}
		}
		for _, interval := range c.d.DeepIntervals {
			for _, coin := range pinned {
				c.warmActive(ctx)
				c.deepenIfNeeded(ctx, coin, interval)
			}
			for _, coin := range rest {
				c.warmActive(ctx)
				c.deepenIfNeeded(ctx, coin, interval)
			}
		}
	}
}

// warmActive warms the currently-viewed chart series. It is cheap once those
// series are warm (a NeedsWarm map check per active series), so calling it
// between bulk items keeps a freshly-selected chart ahead of the queue without
// re-fetching anything already warm.
func (c *Coordinator) warmActive(ctx context.Context) {
	if c.d.ActiveSeries == nil {
		return
	}
	active := c.d.ActiveSeries()
	for _, s := range active {
		if ctx.Err() != nil {
			return
		}
		c.warmIfCold(ctx, s[0], s[1])
		c.deepenIfNeeded(ctx, s[0], s[1])
	}
}

func (c *Coordinator) warmIfCold(ctx context.Context, coin, interval string) {
	if ctx.Err() != nil {
		return
	}
	// Touch before the NeedsWarm gate: an already-warm union member never
	// warms again, but its idle clock must keep advancing or the store would
	// evict it while it's still on the clickable lists.
	if c.d.Touch != nil {
		c.d.Touch(coin, interval)
	}
	if c.d.NeedsWarm == nil || c.d.NeedsWarm(coin, interval) {
		c.d.Warm(coin, interval)
	}
}

func (c *Coordinator) deepenIfNeeded(ctx context.Context, coin, interval string) {
	if ctx.Err() != nil || c.d.NeedsDeepen == nil || c.d.Deepen == nil {
		return
	}
	if c.d.NeedsDeepen(coin, interval) {
		c.d.Deepen(coin, interval)
	}
}

// partitionUnion returns the pinned coins (in their curated order) and the rest
// of the clickable union (movers ∪ mispricing ∪ watchlist, minus pinned), each
// deduped. Pinned coins always warm, even when absent from the dynamic lists.
func (c *Coordinator) partitionUnion(ctx context.Context) (pinned, rest []string) {
	seen := make(map[string]struct{})
	add := func(dst []string, coin string) []string {
		if coin == "" {
			return dst
		}
		if _, ok := seen[coin]; ok {
			return dst
		}
		seen[coin] = struct{}{}
		return append(dst, coin)
	}

	for _, coin := range c.d.Pinned {
		pinned = add(pinned, coin)
	}
	// A user-curated watchlist is the highest-priority dynamic warm source.
	// We reserve at least MinMoverSlots for market movers so a large watchlist
	// does not crowd out top gainers and losers.
	watchlistCap := c.d.MaxCoins
	if c.d.MaxCoins > 0 && c.d.MinMoverSlots > 0 && c.d.MaxCoins > c.d.MinMoverSlots {
		watchlistCap = c.d.MaxCoins - c.d.MinMoverSlots
	}
	if c.d.Watchlist != nil {
		for _, coin := range c.d.Watchlist() {
			if watchlistCap > 0 && len(seen) >= watchlistCap {
				break
			}
			rest = add(rest, coin)
		}
	}
	for _, src := range []func(context.Context) []string{c.d.MoverCoins, c.d.MispriceCoins} {
		if src == nil {
			continue
		}
		for _, coin := range src(ctx) {
			if c.d.MaxCoins > 0 && len(seen) >= c.d.MaxCoins {
				break
			}
			rest = add(rest, coin)
		}
	}
	return pinned, rest
}
