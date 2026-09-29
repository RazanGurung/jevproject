package warmcoordinator

import (
	"context"
	"strings"
	"testing"
	"time"
)

// fake records warm calls in order and tracks which series have been warmed so
// NeedsWarm can mimic the store.
type fake struct {
	order  []string
	warmed map[string]bool
	// degradedWarm, when true, makes every series report warm (not cold) even
	// though Warm was never called — modelling a warm-but-WS-down store.
	allWarm bool
}

func newFake() *fake { return &fake{warmed: map[string]bool{}} }

func (f *fake) warm(coin, interval string) {
	key := coin + "|" + interval
	f.order = append(f.order, key)
	f.warmed[key] = true
}

func (f *fake) needsWarm(coin, interval string) bool {
	if f.allWarm {
		return false
	}
	return !f.warmed[coin+"|"+interval]
}

func baseDeps(f *fake) Deps {
	return Deps{
		Pinned:         []string{"BTC"},
		MoverCoins:     func(context.Context) []string { return []string{"ETH"} },
		MispriceCoins:  func(context.Context) []string { return []string{"xyz:AAPL"} },
		Watchlist:      func() []string { return []string{"SOL"} },
		WarmReferences: func(context.Context) { f.order = append(f.order, "REFS") },
		Warm:           f.warm,
		NeedsWarm:      f.needsWarm,
		CoreIntervals:  []string{"1h", "15m"},
		DeepIntervals:  []string{"1w", "1M"},
	}
}

func indexOf(order []string, key string) int {
	for i, v := range order {
		if v == key {
			return i
		}
	}
	return -1
}

func TestPreferRemainderRunsBeforeUnion(t *testing.T) {
	f := newFake()
	deps := baseDeps(f)
	deps.PreferCoins = []string{"SOL"}
	deps.PreferIntervals = []string{"4h"}
	c := New(deps)
	c.reconcile(context.Background())

	prefer := indexOf(f.order, "SOL|4h")
	firstPinned := indexOf(f.order, "BTC|1h")
	if prefer < 0 || firstPinned < 0 || prefer > firstPinned {
		t.Fatalf("prefer remainder must run before pinned core: SOL|4h@%d BTC|1h@%d order=%v", prefer, firstPinned, f.order)
	}
}

func TestTierOrder(t *testing.T) {
	f := newFake()
	c := New(baseDeps(f))
	c.reconcile(context.Background())

	// Every core interval is warmed before the first deep interval.
	firstDeep := indexOf(f.order, "BTC|1w")
	references := indexOf(f.order, "REFS")
	if references < 0 || references > firstDeep {
		t.Fatalf("references not warmed before deep history: order=%v", f.order)
	}
	for _, coin := range []string{"BTC", "ETH", "xyz:AAPL", "SOL"} {
		for _, interval := range []string{"1h", "15m"} {
			if at := indexOf(f.order, coin+"|"+interval); at < 0 || at > references {
				t.Fatalf("core series %s|%s not before reference tier: order=%v", coin, interval, f.order)
			}
		}
	}

	// Pinned hot-set: BTC's core intervals come before any non-pinned core warm.
	lastPinnedCore := indexOf(f.order, "BTC|15m")
	firstRestCore := indexOf(f.order, "ETH|1h")
	if lastPinnedCore < 0 || firstRestCore < 0 || lastPinnedCore > firstRestCore {
		t.Fatalf("pinned hot-set not warmed first: BTC|15m@%d ETH|1h@%d", lastPinnedCore, firstRestCore)
	}

	// Whole union × all intervals warmed exactly once.
	wantCoins := []string{"BTC", "ETH", "xyz:AAPL", "SOL"}
	for _, coin := range wantCoins {
		for _, iv := range []string{"1h", "15m", "1w", "1M"} {
			if !f.warmed[coin+"|"+iv] {
				t.Fatalf("missing warm for %s|%s", coin, iv)
			}
		}
	}
}

func TestCandidateDiscoveryPrecedesReferenceWarm(t *testing.T) {
	f := newFake()
	discovered := false
	deps := baseDeps(f)
	deps.MispriceCoins = func(context.Context) []string {
		discovered = true
		return []string{"xyz:AAPL"}
	}
	deps.WarmReferences = func(context.Context) {
		if !discovered {
			t.Fatal("reference warm ran before candidate discovery")
		}
		f.order = append(f.order, "REFS")
	}
	New(deps).reconcile(context.Background())
}

func TestPartitionUnionHonorsConfiguredMaxWithWatchlistPriority(t *testing.T) {
	f := newFake()
	deps := baseDeps(f)
	deps.MaxCoins = 3 // pinned BTC + two dynamic slots
	deps.Watchlist = func() []string { return []string{"SOL", "DOGE"} }
	deps.MoverCoins = func(context.Context) []string { return []string{"ETH"} }
	deps.MispriceCoins = func(context.Context) []string { return []string{"xyz:AAPL"} }

	pinned, rest := New(deps).partitionUnion(context.Background())
	if got := strings.Join(pinned, ","); got != "BTC" {
		t.Fatalf("pinned = %q, want BTC", got)
	}
	if got := strings.Join(rest, ","); got != "SOL,DOGE" {
		t.Fatalf("rest = %q, want watchlist-first SOL,DOGE", got)
	}
}

func TestColdOnlyReconcile(t *testing.T) {
	f := newFake()
	c := New(baseDeps(f))
	c.reconcile(context.Background())
	warmsAfterFirst := len(f.order)

	// Second tick: everything already covered → no new Warm calls (REFS may run
	// again; it is cheap/idempotent, so allow it but assert no chart warms).
	c.reconcile(context.Background())
	for _, key := range f.order[warmsAfterFirst:] {
		if key != "REFS" {
			t.Fatalf("cold-only reconcile re-warmed %q", key)
		}
	}
}

func TestNewMoverPickedUp(t *testing.T) {
	f := newFake()
	movers := []string{"ETH"}
	d := baseDeps(f)
	d.MoverCoins = func(context.Context) []string { return movers }
	c := New(d)
	c.reconcile(context.Background())

	movers = []string{"ETH", "DOGE"} // DOGE promoted into the movers row
	c.reconcile(context.Background())

	for _, iv := range []string{"1h", "15m", "1w", "1M"} {
		if !f.warmed["DOGE|"+iv] {
			t.Fatalf("newly-promoted mover DOGE|%s not warmed on reconcile", iv)
		}
	}
}

func TestOutageSafetyNoReWarm(t *testing.T) {
	f := newFake()
	f.allWarm = true // every series warm-but-degraded (WS down): NeedsWarm == false
	c := New(baseDeps(f))
	c.reconcile(context.Background())

	for _, key := range f.order {
		if key != "REFS" {
			t.Fatalf("reconcile re-warmed %q during simulated WS outage", key)
		}
	}
}

func TestActiveSeriesWarmedFirst(t *testing.T) {
	f := newFake()
	deps := baseDeps(f)
	// The user is viewing a non-pinned, non-mover coin (off the hot set).
	deps.ActiveSeries = func() [][2]string { return [][2]string{{"xyz:CL", "4h"}} }
	c := New(deps)
	c.reconcile(context.Background())

	if len(f.order) == 0 || f.order[0] != "xyz:CL|4h" {
		t.Fatalf("active chart series was not warmed first; order=%v", f.order)
	}
	// And it precedes every pinned hot-set warm.
	active := indexOf(f.order, "xyz:CL|4h")
	btc := indexOf(f.order, "BTC|1h")
	if btc >= 0 && active > btc {
		t.Fatalf("active chart (%d) warmed after pinned BTC (%d): %v", active, btc, f.order)
	}
}

func TestActiveSeriesNotReWarmedWhenAlreadyWarm(t *testing.T) {
	f := newFake()
	f.allWarm = true // active series already warm: must not re-fetch
	deps := baseDeps(f)
	deps.ActiveSeries = func() [][2]string { return [][2]string{{"xyz:CL", "4h"}} }
	c := New(deps)
	c.reconcile(context.Background())
	for _, key := range f.order {
		if key != "REFS" {
			t.Fatalf("warmed %q though every series was already warm: %v", key, f.order)
		}
	}
}

// Touch must fire for every union member on every reconcile — including
// already-warm series that NeedsWarm skips — or the candle store's idle
// eviction would reap series still on the clickable lists.
func TestTouchFiresForWarmUnionMembers(t *testing.T) {
	f := newFake()
	f.allWarm = true // nothing needs warming; Touch must still fire
	touched := map[string]bool{}
	d := baseDeps(f)
	d.Touch = func(coin, interval string) { touched[coin+"|"+interval] = true }
	c := New(d)
	c.reconcile(context.Background())

	for _, coin := range []string{"BTC", "ETH", "xyz:AAPL", "SOL"} {
		for _, iv := range []string{"1h", "15m", "1w", "1M"} {
			if !touched[coin+"|"+iv] {
				t.Fatalf("union member %s|%s not touched on reconcile", coin, iv)
			}
		}
	}
}

func TestDisplayWarmRunsBeforeDeepen(t *testing.T) {
	f := newFake()
	displayReady := map[string]bool{}
	deps := baseDeps(f)
	deps.NeedsWarm = func(coin, interval string) bool {
		return !displayReady[coin+"|"+interval]
	}
	deps.Warm = func(coin, interval string) {
		displayReady[coin+"|"+interval] = true
		f.warm(coin, interval)
	}
	deps.NeedsDeepen = func(coin, interval string) bool {
		return displayReady[coin+"|"+interval] && !strings.HasSuffix(coin+"|"+interval, "|deep")
	}
	deps.Deepen = func(coin, interval string) {
		f.order = append(f.order, coin+"|"+interval+"|deep")
	}
	New(deps).reconcile(context.Background())

	firstDeep := -1
	lastDisplay := -1
	for i, key := range f.order {
		if strings.HasSuffix(key, "|deep") {
			if firstDeep < 0 {
				firstDeep = i
			}
			continue
		}
		if key != "REFS" {
			lastDisplay = i
		}
	}
	if firstDeep < 0 {
		t.Fatalf("no deepen calls: %v", f.order)
	}
	if lastDisplay > firstDeep {
		t.Fatalf("display warm after deepen: lastDisplay=%d firstDeep=%d order=%v", lastDisplay, firstDeep, f.order)
	}
	if at := indexOf(f.order, "SOL|15m"); at < 0 || at > firstDeep {
		t.Fatalf("watchlist SOL|15m must display-warm before any deepen: %v", f.order)
	}
	if at := indexOf(f.order, "ETH|1h"); at < 0 || at > firstDeep {
		t.Fatalf("mover ETH|1h must display-warm before any deepen: %v", f.order)
	}
}

func TestNilTouchIsSafe(t *testing.T) {
	f := newFake()
	c := New(baseDeps(f)) // Touch left nil
	c.reconcile(context.Background())
	if len(f.order) == 0 {
		t.Fatal("reconcile did nothing")
	}
}

func TestCancelledContextStops(t *testing.T) {
	f := newFake()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := New(baseDeps(f))
	c.reconcile(ctx)
	if len(f.order) != 0 {
		t.Fatalf("reconcile warmed under a cancelled context: %v", f.order)
	}
}

func TestMinMoverSlotsGuaranteed(t *testing.T) {
	f := newFake()
	deps := baseDeps(f)
	deps.MaxCoins = 10
	deps.MinMoverSlots = 3
	deps.Pinned = []string{"BTC"} // 1 pinned
	// 10 watchlist coins: without quota protection, this would eat all remaining 9 slots
	deps.Watchlist = func() []string {
		return []string{"SOL", "DOGE", "AVAX", "LINK", "UNI", "AAVE", "NEAR", "SUI", "APT", "ARB"}
	}
	deps.MoverCoins = func(context.Context) []string {
		return []string{"ETH", "TIA", "OP"}
	}
	deps.MispriceCoins = func(context.Context) []string { return nil }

	pinned, rest := New(deps).partitionUnion(context.Background())
	if got := strings.Join(pinned, ","); got != "BTC" {
		t.Fatalf("pinned = %q, want BTC", got)
	}
	// Total coins in union must be exactly MaxCoins = 10 (1 pinned + 9 rest)
	if len(pinned)+len(rest) != 10 {
		t.Fatalf("total coins = %d, want 10", len(pinned)+len(rest))
	}
	// Movers ETH, TIA, OP must all be included in rest due to MinMoverSlots = 3
	for _, mover := range []string{"ETH", "TIA", "OP"} {
		if indexOf(rest, mover) < 0 {
			t.Fatalf("mover %s missing from rest: %v", mover, rest)
		}
	}
}

func TestNudgeTriggersImmediateReconcile(t *testing.T) {
	f := newFake()
	nudgeCh := make(chan struct{}, 1)
	deps := baseDeps(f)
	deps.ReconcileInterval = 1 * time.Hour // long ticker interval
	deps.NudgeCh = nudgeCh
	c := New(deps)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		c.Run(ctx)
	}()

	// Wait briefly for initial reconcile to finish
	for i := 0; i < 50; i++ {
		if len(f.order) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	initialWarms := len(f.order)
	if initialWarms == 0 {
		t.Fatal("initial warm pass did not execute")
	}

	// Trigger nudge and verify another reconcile runs without waiting 1 hour
	nudgeCh <- struct{}{}
	// Give it a moment to run
	reconciled := false
	for i := 0; i < 50; i++ {
		// REFS is appended on each reconcile
		refsCount := 0
		for _, item := range f.order {
			if item == "REFS" {
				refsCount++
			}
		}
		if refsCount >= 2 {
			reconciled = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !reconciled {
		t.Fatal("nudge did not trigger immediate reconcile")
	}
	cancel()
	<-done
}

