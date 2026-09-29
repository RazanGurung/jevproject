package streaming

import (
	"sync"

	"hyperliquid-go/internal/ports/streaming"
)

// EventBus implements a publish-subscribe pattern for streaming events.
type EventBus struct {
	subscribers []chan streaming.Event
	mu          sync.RWMutex
}

// NewEventBus creates the small in-process fan-out used by the order bridge.
func NewEventBus() *EventBus {
	return &EventBus{}
}

// Publish broadcasts an event to all subscribed clients.
func (e *EventBus) Publish(event streaming.Event) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	for _, events := range e.subscribers {
		select {
		case events <- event:
		default:
			// Subscriber buffer full; skip rather than block the order path.
		}
	}
}

// Subscribe registers a new subscriber and returns its event channel.
func (e *EventBus) Subscribe() <-chan streaming.Event {
	events := make(chan streaming.Event, 100)

	e.mu.Lock()
	defer e.mu.Unlock()
	e.subscribers = append(e.subscribers, events)
	return events
}

// Unsubscribe removes a subscriber channel.
func (e *EventBus) Unsubscribe(ch <-chan streaming.Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, sub := range e.subscribers {
		if sub == ch {
			e.subscribers = append(e.subscribers[:i], e.subscribers[i+1:]...)
			return
		}
	}
}
