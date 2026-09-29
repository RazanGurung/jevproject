package infogovernor

import (
	"context"
	"testing"
	"time"
)

func TestVisibleChartJumpsQueuedBackgroundWork(t *testing.T) {
	g := New(3)
	releases := make([]func(), 0, 3)
	for i := 0; i < 3; i++ {
		release, err := g.Acquire(context.Background(), Execution)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}

	order := make(chan string, 2)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		release, err := g.Acquire(ctx, Background)
		if err == nil {
			order <- "background"
			release()
		}
	}()
	go func() {
		release, err := g.Acquire(ctx, VisibleChart)
		if err == nil {
			order <- "visible"
			release()
		}
	}()
	time.Sleep(10 * time.Millisecond)
	releases[0]()
	releases[1]()
	if got := <-order; got != "visible" {
		t.Fatalf("first granted lane=%s, want visible", got)
	}
	releases[2]()
}

func TestBackgroundLeavesReservedCapacity(t *testing.T) {
	g := New(8)
	releases := make([]func(), 0, 4)
	for i := 0; i < 4; i++ {
		release, err := g.Acquire(context.Background(), Background)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := g.Acquire(ctx, Background); err == nil {
		t.Fatal("fifth background request consumed reserved capacity")
	}
	release, err := g.Acquire(context.Background(), VisibleChart)
	if err != nil {
		t.Fatalf("visible chart could not use reserved capacity: %v", err)
	}
	release()
	for _, done := range releases {
		done()
	}
}
