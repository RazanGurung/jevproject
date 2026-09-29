package websocket

import (
	"context"
	"sync"
	"testing"
	"time"

	exchangeport "hyperliquid-go/internal/ports/exchange"
)

type coalescingBuilderFetcher struct {
	accountRefreshFetcher
	mu      sync.Mutex
	calls   int
	started chan int
	release chan struct{}
}

func newCoalescingBuilderFetcher() *coalescingBuilderFetcher {
	return &coalescingBuilderFetcher{
		started: make(chan int, 4),
		release: make(chan struct{}, 4),
	}
}

func (f *coalescingBuilderFetcher) GetBuilderDexState(ctx context.Context, _ string, dex string, _ bool) (exchangeport.BuilderDexState, error) {
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.mu.Unlock()
	f.started <- call
	select {
	case <-ctx.Done():
		return exchangeport.BuilderDexState{}, ctx.Err()
	case <-f.release:
		return exchangeport.BuilderDexState{Dex: dex}, nil
	}
}

func (f *coalescingBuilderFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestBuilderRefreshCollapsesFillAndOrderUpdateBurst(t *testing.T) {
	fetcher := newCoalescingBuilderFetcher()
	manager := NewWebSocketManager(nil)
	manager.accountFetcher = fetcher
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const account = "0x1111111111111111111111111111111111111111"

	manager.requestBuilderDexRefresh(ctx, account, "xyz")
	manager.requestBuilderDexRefresh(ctx, account, "XYZ")
	select {
	case <-fetcher.started:
	case <-time.After(time.Second):
		t.Fatal("targeted builder refresh did not start")
	}
	fetcher.release <- struct{}{}
	time.Sleep(2 * targetedBuilderRefreshDebounce)
	if got := fetcher.callCount(); got != 1 {
		t.Fatalf("builder refresh calls = %d, want one collapsed request", got)
	}
}

func TestBuilderRefreshRunsOneFollowUpForEventDuringFetch(t *testing.T) {
	fetcher := newCoalescingBuilderFetcher()
	manager := NewWebSocketManager(nil)
	manager.accountFetcher = fetcher
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const account = "0x2222222222222222222222222222222222222222"

	manager.requestBuilderDexRefresh(ctx, account, "xyz")
	select {
	case <-fetcher.started:
	case <-time.After(time.Second):
		t.Fatal("first targeted builder refresh did not start")
	}
	manager.requestBuilderDexRefresh(ctx, account, "xyz")
	fetcher.release <- struct{}{}
	select {
	case call := <-fetcher.started:
		if call != 2 {
			t.Fatalf("follow-up call = %d, want 2", call)
		}
	case <-time.After(time.Second):
		t.Fatal("dirty event did not trigger one follow-up refresh")
	}
	fetcher.release <- struct{}{}
	time.Sleep(2 * targetedBuilderRefreshDebounce)
	if got := fetcher.callCount(); got != 2 {
		t.Fatalf("builder refresh calls = %d, want exactly two", got)
	}
}
