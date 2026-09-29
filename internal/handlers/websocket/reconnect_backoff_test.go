package websocket

import (
	"testing"
	"time"
)

func TestReconnectBackoffCapsAndResetsAfterStableSession(t *testing.T) {
	backoff := newReconnectBackoff(time.Second, 30*time.Second, 30*time.Second)
	want := []time.Duration{
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		30 * time.Second,
		30 * time.Second,
	}
	for i, expected := range want {
		if got := backoff.Next(0); got != expected {
			t.Fatalf("unstable attempt %d delay = %s, want %s", i, got, expected)
		}
	}
	if got := backoff.Next(30 * time.Second); got != time.Second {
		t.Fatalf("stable-session delay = %s, want 1s", got)
	}
	if got := backoff.Next(0); got != 2*time.Second {
		t.Fatalf("post-reset unstable delay = %s, want 2s", got)
	}
}

func TestReconnectBackoffResetReturnsToMin(t *testing.T) {
	backoff := newReconnectBackoff(time.Second, 30*time.Second, 30*time.Second)
	_ = backoff.Next(0)
	_ = backoff.Next(0)
	if backoff.current <= time.Second {
		t.Fatal("expected backoff to have grown before reset")
	}
	backoff.Reset()
	if got := backoff.Next(0); got != time.Second {
		t.Fatalf("after Reset delay = %s, want 1s", got)
	}
}

func TestWaitForReconnectStopsImmediately(t *testing.T) {
	stop := make(chan struct{})
	close(stop)
	started := time.Now()
	ok, slept := waitForReconnect(stop, time.Minute)
	if ok {
		t.Fatal("closed stop channel should cancel reconnect wait")
	}
	if slept {
		t.Fatal("cancelled wait should not report sleep")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelled reconnect wait took %s", elapsed)
	}
}

func TestWallClockSinceUsesUnixMilli(t *testing.T) {
	start := time.Now().UnixMilli() - 1500
	got := wallClockSince(start)
	if got < 1400*time.Millisecond || got > 3*time.Second {
		t.Fatalf("wallClockSince = %s, want ~1.5s", got)
	}
	if wallClockSince(0) != 0 {
		t.Fatal("zero start must return 0")
	}
}

func TestWaitForReconnectZeroDelay(t *testing.T) {
	ok, slept := waitForReconnect(make(chan struct{}), 0)
	if !ok || slept {
		t.Fatalf("zero delay = (%v,%v), want (true,false)", ok, slept)
	}
}

func TestReconnectWaitSleptRequiresDelayPlusWakeGap(t *testing.T) {
	start := int64(1_000_000)
	delayMs := int64((30 * time.Second) / time.Millisecond)
	if reconnectWaitSlept(start, start+delayMs+250, delayMs) {
		t.Fatal("a completed 30s wait with ticker overshoot must not count as sleep")
	}
	if reconnectWaitSlept(start, start+delayMs+wakeGapThreshold.Milliseconds(), delayMs) {
		t.Fatal("elapsed == delay+threshold must not count as sleep")
	}
	if !reconnectWaitSlept(start, start+delayMs+wakeGapThreshold.Milliseconds()+1, delayMs) {
		t.Fatal("elapsed > delay+threshold must count as sleep")
	}
	if reconnectWaitSlept(start, start+int64(time.Second/time.Millisecond)+250, int64(time.Second/time.Millisecond)) {
		t.Fatal("a completed 1s wait must not count as sleep")
	}
}
