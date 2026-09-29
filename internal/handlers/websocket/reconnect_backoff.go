package websocket

import (
	"sync"
	"time"
)

// reconnectBackoff keeps short-lived upstream sessions from becoming a
// connection storm while allowing an ordinary long-lived server rotation to
// recover at the minimum delay.
type reconnectBackoff struct {
	mu            sync.Mutex
	current       time.Duration
	min           time.Duration
	max           time.Duration
	stableSession time.Duration
}

func newReconnectBackoff(min, max, stableSession time.Duration) *reconnectBackoff {
	if min <= 0 {
		min = time.Second
	}
	if max < min {
		max = min
	}
	return &reconnectBackoff{
		current:       min,
		min:           min,
		max:           max,
		stableSession: stableSession,
	}
}

func (b *reconnectBackoff) Next(connectedFor time.Duration) time.Duration {
	if b == nil {
		return time.Second
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if connectedFor >= b.stableSession {
		b.current = b.min
	}
	delay := b.current
	if b.current < b.max {
		b.current *= 2
		if b.current > b.max {
			b.current = b.max
		}
	}
	return delay
}

func (b *reconnectBackoff) Reset() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.current = b.min
}

// wallClockSince is sleep-safe session length. time.Since uses the monotonic
// clock, which pauses during Darwin sleep and makes a multi-hour lid-close
// look like a 2s blip.
func wallClockSince(startMs int64) time.Duration {
	if startMs <= 0 {
		return 0
	}
	elapsed := time.Now().UnixMilli() - startMs
	if elapsed < 0 {
		return 0
	}
	return time.Duration(elapsed) * time.Millisecond
}

// waitForReconnect waits up to delay, but polls wall-clock so Darwin sleep
// cannot leave a monotonic timer with leftover backoff after lid-open.
// Returns false if stop is closed. If the host slept through the wait
// (wall elapsed > delay + wakeGapThreshold), slept is true so the caller
// can Reset backoff and retry immediately.
func waitThenMaybeReset(b *reconnectBackoff, stop <-chan struct{}, delay time.Duration) bool {
	ok, slept := waitForReconnect(stop, delay)
	if ok && slept {
		b.Reset()
	}
	return ok
}

func reconnectWaitSlept(startMs, nowMs, delayMs int64) bool {
	if delayMs < 0 {
		delayMs = 0
	}
	return nowMs-startMs > delayMs+wakeGapThreshold.Milliseconds()
}

func waitForReconnect(stop <-chan struct{}, delay time.Duration) (ok bool, slept bool) {
	if delay <= 0 {
		return true, false
	}
	startMs := time.Now().UnixMilli()
	deadlineMs := startMs + delay.Milliseconds()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return false, false
		case <-ticker.C:
			nowMs := time.Now().UnixMilli()
			if nowMs >= deadlineMs {
				return true, reconnectWaitSlept(startMs, nowMs, delay.Milliseconds())
			}
			if reconnectWaitSlept(startMs, nowMs, delay.Milliseconds()) {
				return true, true
			}
		}
	}
}
