package streaming

import (
	"testing"
	"time"

	ps "hyperliquid-go/internal/ports/streaming"
)

func recvWithin(t *testing.T, ch <-chan ps.Event, d time.Duration) (ps.Event, bool) {
	t.Helper()
	select {
	case ev := <-ch:
		return ev, true
	case <-time.After(d):
		return ps.Event{}, false
	}
}

func TestEventBusDeliversToSubscriber(t *testing.T) {
	bus := NewEventBus()
	ch := bus.Subscribe()

	bus.Publish(ps.Event{Type: ps.EventOrderUpdate, Payload: "x"})

	ev, ok := recvWithin(t, ch, time.Second)
	if !ok {
		t.Fatal("subscriber did not receive published event")
	}
	if ev.Type != ps.EventOrderUpdate || ev.Payload != "x" {
		t.Fatalf("received unexpected event: %+v", ev)
	}
}

func TestEventBusFansOutToAllSubscribers(t *testing.T) {
	bus := NewEventBus()
	a := bus.Subscribe()
	b := bus.Subscribe()

	bus.Publish(ps.Event{Type: ps.EventOrderUpdate})

	if _, ok := recvWithin(t, a, time.Second); !ok {
		t.Fatal("subscriber A did not receive event")
	}
	if _, ok := recvWithin(t, b, time.Second); !ok {
		t.Fatal("subscriber B did not receive event")
	}
}

// A subscriber that never drains its channel must not be able to block the
// publisher; excess events are dropped at the per-client buffer (cap 100).
func TestEventBusPublishDoesNotBlockOnFullSubscriber(t *testing.T) {
	bus := NewEventBus()
	ch := bus.Subscribe()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 150; i++ {
			bus.Publish(ps.Event{Type: ps.EventOrderUpdate})
		}
		close(done)
	}()

	select {
	case <-done:
		// Publisher completed without blocking — the contract holds.
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on a full subscriber buffer")
	}

	if got := len(ch); got != 100 {
		t.Fatalf("buffered %d events, want the 100-cap to bound it", got)
	}
}

func TestEventBusUnsubscribe(t *testing.T) {
	bus := NewEventBus()
	ch := bus.Subscribe()

	bus.Unsubscribe(ch)
	bus.Publish(ps.Event{Type: ps.EventOrderUpdate, Payload: "post-unsub"})

	if len(bus.subscribers) != 0 {
		t.Fatalf("expected 0 subscribers after unsubscribe, got %d", len(bus.subscribers))
	}
	if len(ch) != 0 {
		t.Fatalf("expected empty channel for unsubscribed client, got %d", len(ch))
	}
}
