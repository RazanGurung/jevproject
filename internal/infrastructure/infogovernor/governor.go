// Package infogovernor coordinates Hyperliquid /info concurrency across
// otherwise independent trading and chart components. Hyperliquid accounts
// allowance per IP, so separate HTTP clients alone do not provide isolation.
package infogovernor

import (
	"context"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type Lane uint8

type laneContextKey struct{}

const (
	Execution Lane = iota
	VisibleChart
	AccountCore
	Enrichment
	Background
)

func (l Lane) String() string {
	switch l {
	case Execution:
		return "execution"
	case VisibleChart:
		return "visible_chart"
	case AccountCore:
		return "account_core"
	case Enrichment:
		return "enrichment"
	default:
		return "background"
	}
}

type waiter struct {
	lane    Lane
	ready   chan struct{}
	granted bool
}

type Governor struct {
	mu          sync.Mutex
	inFlight    int
	maxInFlight int
	waiters     []*waiter
}

var (
	defaultGovernor = New(8)
	queueSeconds    = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pez_info_lane_queue_seconds",
		Help:    "Time a Hyperliquid info request waits for its priority lane.",
		Buckets: prometheus.DefBuckets,
	}, []string{"lane"})
	inFlightGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pez_info_lane_in_flight",
		Help: "Current Hyperliquid info requests by priority lane.",
	}, []string{"lane"})
)

func init() {
	prometheus.MustRegister(queueSeconds, inFlightGauge)
}

func New(maxInFlight int) *Governor {
	if maxInFlight < 2 {
		maxInFlight = 2
	}
	return &Governor{maxInFlight: maxInFlight}
}

// laneCeiling reserves global slots for more important work even when lower
// lanes arrive first. Existing requests are never preempted.
func (g *Governor) laneCeiling(lane Lane) int {
	reserve := map[Lane]int{
		Execution:    0,
		VisibleChart: 1,
		AccountCore:  2,
		Enrichment:   3,
		Background:   4,
	}[lane]
	ceiling := g.maxInFlight - reserve
	if ceiling < 1 {
		return 1
	}
	return ceiling
}

func (g *Governor) canGrant(lane Lane) bool {
	return g.inFlight < g.laneCeiling(lane)
}

func (g *Governor) Acquire(ctx context.Context, lane Lane) (func(), error) {
	started := time.Now()
	w := &waiter{lane: lane, ready: make(chan struct{})}
	g.mu.Lock()
	if len(g.waiters) == 0 && g.canGrant(lane) {
		g.inFlight++
		w.granted = true
		g.mu.Unlock()
		queueSeconds.WithLabelValues(lane.String()).Observe(time.Since(started).Seconds())
		inFlightGauge.WithLabelValues(lane.String()).Inc()
		return g.release(lane), nil
	}
	g.waiters = append(g.waiters, w)
	g.mu.Unlock()

	select {
	case <-w.ready:
		queueSeconds.WithLabelValues(lane.String()).Observe(time.Since(started).Seconds())
		inFlightGauge.WithLabelValues(lane.String()).Inc()
		return g.release(lane), nil
	case <-ctx.Done():
		g.mu.Lock()
		if !w.granted {
			for i, queued := range g.waiters {
				if queued == w {
					g.waiters = append(g.waiters[:i], g.waiters[i+1:]...)
					break
				}
			}
			g.mu.Unlock()
			return nil, ctx.Err()
		}
		g.mu.Unlock()
		// Grant won the race with cancellation; return a release so capacity
		// cannot leak. The caller will immediately observe its canceled context.
		inFlightGauge.WithLabelValues(lane.String()).Inc()
		return g.release(lane), nil
	}
}

func (g *Governor) release(lane Lane) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			inFlightGauge.WithLabelValues(lane.String()).Dec()
			g.mu.Lock()
			if g.inFlight > 0 {
				g.inFlight--
			}
			g.grantLocked()
			g.mu.Unlock()
		})
	}
}

func (g *Governor) grantLocked() {
	for {
		best := -1
		for i, w := range g.waiters {
			if !g.canGrant(w.lane) {
				continue
			}
			if best == -1 || w.lane < g.waiters[best].lane {
				best = i
			}
		}
		if best < 0 {
			return
		}
		w := g.waiters[best]
		g.waiters = append(g.waiters[:best], g.waiters[best+1:]...)
		g.inFlight++
		w.granted = true
		close(w.ready)
	}
}

func Acquire(ctx context.Context, lane Lane) (func(), error) {
	return defaultGovernor.Acquire(ctx, lane)
}

func WithLane(ctx context.Context, lane Lane) context.Context {
	return context.WithValue(ctx, laneContextKey{}, lane)
}

func LaneFromContext(ctx context.Context, fallback Lane) Lane {
	if lane, ok := ctx.Value(laneContextKey{}).(Lane); ok {
		return lane
	}
	return fallback
}
