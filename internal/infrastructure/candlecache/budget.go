package candlecache

import (
	"context"
	"sync"
	"time"
)

// weightBudget paces candle fetches against a self-managed weight allowance so
// warm-up, backfill, and on-demand warms leave the bulk of Hyperliquid's per-IP
// budget to live dashboard traffic. It is not the per-address
// services.RateLimiter, which can't block until capacity frees up.
//
// It is a token bucket, not a fixed window: a fixed window lets the preloader
// spend the entire minute's allowance in one instant at startup (windowStart=0
// → reset → full burst), and that back-to-back burst spikes HL's per-IP limit,
// which 429s the interactive passthrough chart loads happening at the same time.
// The bucket refills continuously at perMin and caps the instantaneous burst, so
// the same average rate is spread into a smooth stream that leaves steady
// headroom for foreground navigation.
//
// Interactive chart loads never wait on this budget: the proxy serves cold
// charts straight from passthrough and only the background warm folds them in.
type weightBudget struct {
	mu     sync.Mutex
	perSec float64
	burst  float64 // max tokens — bounds the instantaneous burst
	tokens float64
	last   time.Time
	now    func() time.Time
	// sleep, when set, is a test clock: it returns after advancing fake time.
	// Production leaves it nil so wait() can interrupt a real timer on cancel
	// instead of finishing a 1.5s refill sleep after Ctrl+C.
	sleep func(time.Duration)
	// waitMu serializes wait() callers. Without it, wait() is a sleep-retry
	// race: concurrent background streams (the warm coordinator's bulk sweep
	// vs a WarmOnDemand deepen) recompute near-identical sleeps and the same
	// goroutine can lose the wake-up race every round — observed live as a
	// BTC 15m deepen starving 15+ minutes behind the initial pass while the
	// budget flowed normally. Go mutexes hand off to the longest waiter under
	// contention (starvation mode), so gating the whole reserve-sleep loop
	// behind waitMu makes background fetches take fair turns.
	waitMu sync.Mutex
	// observeWait, when set, receives the total time each wait() call spent
	// blocked (only calls that actually blocked). Metrics hook; never nil-checked
	// under mu — read via the setter-owned field on the wait path only.
	observeWait func(time.Duration)
}

func newWeightBudget(perMin int, now func() time.Time, sleep func(time.Duration)) *weightBudget {
	if perMin <= 0 {
		perMin = 600
	}
	// Cap the burst to ~10s of allowance (a couple of heavy candle fetches), with
	// a floor so a single heavy fetch always fits. This is what kills the startup
	// dump while preserving the perMin average.
	burst := float64(perMin) / 6
	if burst < 100 {
		burst = 100
	}
	return &weightBudget{
		perSec: float64(perMin) / 60.0,
		burst:  burst,
		tokens: burst,
		now:    now,
		sleep:  sleep,
	}
}

// reserve tries to consume weight tokens. On success returns (true, 0). When the
// bucket is short it returns (false, d) where d is how long until enough refills.
// A request heavier than the burst ceiling is capped to it (gets the bucket to
// itself) rather than blocking forever.
func (b *weightBudget) reserve(weight int) (bool, time.Duration) {
	w := float64(weight)
	if w > b.burst {
		w = b.burst
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if b.last.IsZero() {
		b.last = now
	}
	b.tokens += now.Sub(b.last).Seconds() * b.perSec
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens >= w {
		b.tokens -= w
		return true, 0
	}
	wait := time.Duration((w - b.tokens) / b.perSec * float64(time.Second))
	if wait <= 0 {
		wait = time.Millisecond // rounding floor — never busy-spin
	}
	return false, wait
}

// wait blocks until the given weight is available, then consumes it. Callers
// are serialized (see waitMu) so concurrent background streams take fair
// turns instead of racing each refill. A canceled ctx returns immediately
// without taking tokens, so shutdown does not drain the bucket one sleep
// at a time for hydrates that can no longer fetch.
func (b *weightBudget) wait(ctx context.Context, weight int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	b.waitMu.Lock()
	defer b.waitMu.Unlock()
	var blocked time.Duration
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		ok, d := b.reserve(weight)
		if ok {
			if blocked > 0 && b.observeWait != nil {
				b.observeWait(blocked)
			}
			return nil
		}
		blocked += d
		if err := b.sleepCtx(ctx, d); err != nil {
			return err
		}
	}
}

func (b *weightBudget) sleepCtx(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if d <= 0 {
		return nil
	}
	if b.sleep != nil {
		b.sleep(d)
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// charge deducts weight from the bucket WITHOUT blocking, allowing the token
// balance to go negative. It is for interactive passthrough chart loads, which
// must never wait — but whose Hyperliquid IP-weight should still count against
// the shared budget so the background warm-up (which does wait() on the same
// budget) yields to them. A burst of foreground loads drives tokens negative,
// which stalls the preloader until they refill, freeing the per-IP allowance for
// the chart the user is actively loading.
func (b *weightBudget) charge(weight int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if b.last.IsZero() {
		b.last = now
	}
	b.tokens += now.Sub(b.last).Seconds() * b.perSec
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	b.tokens -= float64(weight)
}

// penalize is a live correction on top of the steady configured rate: a real
// 429 means Hyperliquid's actual per-IP allowance right now is tighter than
// perMin assumes (other subsystems sharing the IP, or the assumption simply
// being optimistic), and the token bucket has no way to know that on its own
// — it just keeps refilling at the configured rate regardless of what
// upstream is actually saying. Zeroing the bucket forces every background
// wait() caller to pause for a full burst-window's worth of refill, handing
// that headroom to interactive traffic right when a collision is actually
// observed, rather than waiting out the average-rate assumption. Self-heals
// via the same continuous refill as everywhere else, so it can't wedge.
func (b *weightBudget) penalize() {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if b.last.IsZero() {
		b.last = now
	}
	b.tokens += now.Sub(b.last).Seconds() * b.perSec
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens > 0 {
		b.tokens = 0
	}
}
