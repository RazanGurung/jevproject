package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestCandlePassthroughSemBoundsConcurrency covers the Round 2 fix: concurrent
// interactive candleSnapshot passthroughs (a click plus its own prefetches
// plus a concurrent radar sweep, none of which coordinate with each other
// client-side) must never exceed a lane's semaphore capacity in flight to
// Hyperliquid at once, no matter how many arrive at the same instant.
func TestCandlePassthroughSemBoundsConcurrency(t *testing.T) {
	const attempts = 20
	var inFlight int32
	var maxInFlight int32
	var wg sync.WaitGroup

	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !acquireCandlePassthroughSlot(context.Background(), candlePassthroughSem) {
				t.Error("acquire with a live context should not fail")
				return
			}
			defer releaseCandlePassthroughSlot(candlePassthroughSem)

			n := atomic.AddInt32(&inFlight, 1)
			for {
				max := atomic.LoadInt32(&maxInFlight)
				if n <= max || atomic.CompareAndSwapInt32(&maxInFlight, max, n) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&inFlight, -1)
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&maxInFlight); got > int32(cap(candlePassthroughSem)) {
		t.Fatalf("max concurrent passthroughs = %d, want <= %d (semaphore capacity)", got, cap(candlePassthroughSem))
	}
	if got := len(candlePassthroughSem); got != 0 {
		t.Fatalf("semaphore left with %d held slots after all releases, want 0", got)
	}
}

// TestCandlePassthroughSemGivesUpOnCanceledContext covers the other half of
// the fix: a superseded/aborted chart switch must not sit in the queue behind
// traffic it no longer needs — its own canceled context should make the
// acquire return promptly instead of blocking until a slot frees.
func TestCandlePassthroughSemGivesUpOnCanceledContext(t *testing.T) {
	capacity := cap(candlePassthroughSem)
	held := make([]bool, 0, capacity)
	for i := 0; i < capacity; i++ {
		if !acquireCandlePassthroughSlot(context.Background(), candlePassthroughSem) {
			t.Fatalf("failed to fill slot %d", i)
		}
		held = append(held, true)
	}
	defer func() {
		for range held {
			releaseCandlePassthroughSlot(candlePassthroughSem)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan bool, 1)
	go func() { done <- acquireCandlePassthroughSlot(ctx, candlePassthroughSem) }()

	select {
	case ok := <-done:
		if ok {
			t.Fatal("acquire should have failed on an already-canceled context")
		}
	case <-time.After(time.Second):
		t.Fatal("acquire did not return promptly on a canceled context; it blocked instead")
	}
}

func TestChartAndPrefetchPassthroughLanesAreIndependent(t *testing.T) {
	if candlePassthroughSem == chartPrefetchSem {
		t.Fatal("visible and prefetch candle lanes must use distinct channels")
	}

	// Fill the interactive lane completely.
	held := make([]bool, 0, cap(candlePassthroughSem))
	for i := 0; i < cap(candlePassthroughSem); i++ {
		if !acquireCandlePassthroughSlot(context.Background(), candlePassthroughSem) {
			t.Fatalf("failed to fill interactive slot %d", i)
		}
		held = append(held, true)
	}
	defer func() {
		for range held {
			releaseCandlePassthroughSlot(candlePassthroughSem)
		}
	}()

	// Prefetch also remains independent, but has intentionally lower
	// concurrency so speculative work cannot create a burst.
	if cap(chartPrefetchSem) >= cap(candlePassthroughSem) {
		t.Fatalf("prefetch capacity=%d must stay below visible capacity=%d", cap(chartPrefetchSem), cap(candlePassthroughSem))
	}
	if !acquireCandlePassthroughSlot(context.Background(), chartPrefetchSem) {
		t.Fatal("prefetch lane blocked behind a full visible lane")
	}
	releaseCandlePassthroughSlot(chartPrefetchSem)
}
