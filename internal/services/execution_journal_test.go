package services

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"hyperliquid-go/internal/domain/models"
)

func TestExecutionJournal_BasicRecordAndQuery(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "journal_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	filePath := filepath.Join(tmpDir, "test_journal.jsonl")
	journal, err := NewExecutionJournal(filePath, 50)
	if err != nil {
		t.Fatalf("failed to create journal: %v", err)
	}
	defer journal.Close()

	entry1 := models.JournalEntry{
		Action:              "PLACE_ORDER",
		Coin:                "BTC",
		Side:                "BUY",
		Sz:                  0.5,
		LimitPx:             65000,
		OrderType:           "LIMIT",
		Tif:                 "Gtc",
		Cloid:               "0xabc123",
		PreTradeMid:         64990,
		RealizedSlippageBps: 1.54,
		LatencyMs:           42,
		Success:             true,
		Status:              "filled",
	}

	entry2 := models.JournalEntry{
		Action:       "CANCEL_ORDER",
		Coin:         "ETH",
		Oid:          999,
		LatencyMs:    15,
		Success:      true,
		Status:       "cancelled",
	}

	if err := journal.Record(entry1); err != nil {
		t.Fatalf("failed to record entry1: %v", err)
	}
	if err := journal.Record(entry2); err != nil {
		t.Fatalf("failed to record entry2: %v", err)
	}

	// Query all
	all := journal.GetEntries("", "", 10)
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}
	// Newest should be entry2
	if all[0].Coin != "ETH" || all[1].Coin != "BTC" {
		t.Fatalf("expected newest first order, got %s then %s", all[0].Coin, all[1].Coin)
	}

	// Filter by coin
	btcEntries := journal.GetEntries("BTC", "", 10)
	if len(btcEntries) != 1 || btcEntries[0].Coin != "BTC" {
		t.Fatalf("expected 1 BTC entry, got %d", len(btcEntries))
	}

	// Filter by action
	cancels := journal.GetEntries("", "CANCEL_ORDER", 10)
	if len(cancels) != 1 || cancels[0].Action != "CANCEL_ORDER" {
		t.Fatalf("expected 1 CANCEL_ORDER entry, got %d", len(cancels))
	}

	// Summary check
	summary := journal.GetSummary()
	if summary.TotalEntries != 2 {
		t.Fatalf("expected 2 total entries, got %d", summary.TotalEntries)
	}
	if summary.TotalOrders != 1 || summary.TotalCancels != 1 {
		t.Fatalf("expected 1 order and 1 cancel, got %d and %d", summary.TotalOrders, summary.TotalCancels)
	}
	if summary.TotalVolumeUsd != 0.5*65000 {
		t.Fatalf("expected volume %f, got %f", 0.5*65000, summary.TotalVolumeUsd)
	}
	if summary.SuccessRatePct != 100.0 {
		t.Fatalf("expected 100%% success rate, got %f", summary.SuccessRatePct)
	}
}

func TestExecutionJournal_PersistenceAndReload(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "journal_test_reload_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	filePath := filepath.Join(tmpDir, "reload_journal.jsonl")

	// Phase 1: Write entries and close
	j1, err := NewExecutionJournal(filePath, 100)
	if err != nil {
		t.Fatalf("failed to create journal 1: %v", err)
	}
	for i := 0; i < 5; i++ {
		_ = j1.Record(models.JournalEntry{
			Action:  "PLACE_ORDER",
			Coin:    "SOL",
			Sz:      10,
			LimitPx: 140,
			Success: true,
		})
	}
	if err := j1.Close(); err != nil {
		t.Fatalf("failed to close journal 1: %v", err)
	}

	// Phase 2: Reload into a new journal instance
	j2, err := NewExecutionJournal(filePath, 100)
	if err != nil {
		t.Fatalf("failed to create journal 2: %v", err)
	}
	defer j2.Close()

	entries := j2.GetEntries("SOL", "", 10)
	if len(entries) != 5 {
		t.Fatalf("expected 5 preloaded entries, got %d", len(entries))
	}

	summary := j2.GetSummary()
	if summary.TotalOrders != 5 {
		t.Fatalf("expected 5 orders, got %d", summary.TotalOrders)
	}
	if summary.TotalVolumeUsd != 5*10*140 {
		t.Fatalf("expected volume %f, got %f", float64(5*10*140), summary.TotalVolumeUsd)
	}
}

func TestExecutionJournal_RingBufferBounds(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "journal_test_ring_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	filePath := filepath.Join(tmpDir, "ring_journal.jsonl")
	maxRing := 10
	journal, err := NewExecutionJournal(filePath, maxRing)
	if err != nil {
		t.Fatalf("failed to create journal: %v", err)
	}
	defer journal.Close()

	for i := 0; i < 25; i++ {
		_ = journal.Record(models.JournalEntry{
			Action:  "PLACE_ORDER",
			Coin:    "BTC",
			Sz:      float64(i + 1),
			Success: true,
		})
	}

	entries := journal.GetEntries("", "", 50)
	if len(entries) != maxRing {
		t.Fatalf("expected ring buffer to cap at %d entries, got %d", maxRing, len(entries))
	}

	// Newest should be sz=25
	if entries[0].Sz != 25 {
		t.Fatalf("expected newest entry sz=25, got %f", entries[0].Sz)
	}
}

func TestExecutionJournal_ConcurrentWrites(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "journal_test_concurrent_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	filePath := filepath.Join(tmpDir, "concurrent_journal.jsonl")
	journal, err := NewExecutionJournal(filePath, 500)
	if err != nil {
		t.Fatalf("failed to create journal: %v", err)
	}
	defer journal.Close()

	var wg sync.WaitGroup
	numWorkers := 20
	recordsPerWorker := 15

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < recordsPerWorker; i++ {
				_ = journal.Record(models.JournalEntry{
					Action:    "PLACE_ORDER",
					Coin:      "ETH",
					Sz:        float64(workerID + 1),
					LatencyMs: int64(i),
					Success:   true,
				})
				time.Sleep(time.Millisecond)
			}
		}(w)
	}

	wg.Wait()

	entries := journal.GetEntries("ETH", "", 500)
	expectedTotal := numWorkers * recordsPerWorker
	if len(entries) != expectedTotal {
		t.Fatalf("expected %d entries, got %d", expectedTotal, len(entries))
	}
}
