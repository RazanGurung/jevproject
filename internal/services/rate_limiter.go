package services

import (
	"sync"
	"time"
)

// OrderPlacementBudget is a per-address product throttle for order placement
// only. It is NOT the Hyperliquid REST weight budget.
//
// Process-wide official HL weight accounting lives solely in
// internal/infrastructure/hlratelimit (transport wrapper). This limiter exists
// so a single hot wallet cannot spam PlaceOrder/PlaceBulkOrders at the app
// edge independent of upstream weight.
//
// RateLimiter is retained as a type alias for existing call sites and tests.
type OrderPlacementBudget struct {
	buckets   map[string]*placementBucket
	mu        sync.RWMutex
	maxWeight int
	window    time.Duration
}

// RateLimiter is the historical name for OrderPlacementBudget.
type RateLimiter = OrderPlacementBudget

type placementBucket struct {
	weight      int
	windowStart time.Time
}

// NewOrderPlacementBudget builds a per-address placement budget.
// maxWeight is app-local "placement weight" units (1 + batch/40), not HL REST weight.
func NewOrderPlacementBudget(maxWeight int, window time.Duration) *OrderPlacementBudget {
	return &OrderPlacementBudget{
		buckets:   make(map[string]*placementBucket),
		maxWeight: maxWeight,
		window:    window,
	}
}

// NewRateLimiter is the historical constructor name for NewOrderPlacementBudget.
func NewRateLimiter(maxWeight int, window time.Duration) *RateLimiter {
	return NewOrderPlacementBudget(maxWeight, window)
}

func (r *OrderPlacementBudget) Allow(address string, weight int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	b, exists := r.buckets[address]

	if !exists || (r.window > 0 && now.Sub(b.windowStart) > r.window) {
		r.buckets[address] = &placementBucket{weight: weight, windowStart: now}
		return true
	}

	if b.weight+weight > r.maxWeight {
		return false
	}

	b.weight += weight
	return true
}

// Weight returns app-local placement weight for a batch (not HL exchange weight).
func (r *OrderPlacementBudget) Weight(address string, batchLength int) int {
	return 1 + batchLength/40
}

// Refund restores previously debited placement weight for an address when an
// order fails with a non-ambiguous error (e.g. invalid size, min notional reject,
// insufficient margin, or local pre-flight failure).
func (r *OrderPlacementBudget) Refund(address string, weight int) {
	if weight <= 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	b, exists := r.buckets[address]
	if !exists {
		return
	}
	b.weight -= weight
	if b.weight < 0 {
		b.weight = 0
	}
}

