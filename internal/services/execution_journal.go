package services

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/internal/domain/models"
)

// ExecutionJournal manages an append-only transaction audit log on disk
// and maintains an in-memory ring buffer for low-latency queries.
type ExecutionJournal struct {
	mu       sync.RWMutex
	filePath string
	file     *os.File
	entries  []models.JournalEntry
	maxRing  int
}

// NewExecutionJournal initializes an execution journal at filePath.
// If the file already exists, it preloads the last maxRing entries into memory.
func NewExecutionJournal(filePath string, maxRing int) (*ExecutionJournal, error) {
	if maxRing <= 0 {
		maxRing = 1000
	}

	dir := filepath.Dir(filePath)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("create journal directory: %w", err)
		}
	}

	// Preload existing entries from disk if present
	preloaded := make([]models.JournalEntry, 0, maxRing)
	if existingFile, err := os.Open(filePath); err == nil {
		scanner := bufio.NewScanner(existingFile)
		// Use a 64KB buffer for long lines
		buf := make([]byte, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var entry models.JournalEntry
			if err := json.Unmarshal([]byte(line), &entry); err == nil {
				preloaded = append(preloaded, entry)
				if len(preloaded) > maxRing*2 {
					// Compact to prevent unbounded memory usage on massive files
					preloaded = preloaded[len(preloaded)-maxRing:]
				}
			}
		}
		_ = existingFile.Close()
	}

	// Keep only the most recent maxRing entries
	if len(preloaded) > maxRing {
		preloaded = preloaded[len(preloaded)-maxRing:]
	}

	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open journal file: %w", err)
	}

	return &ExecutionJournal{
		filePath: filePath,
		file:     f,
		entries:  preloaded,
		maxRing:  maxRing,
	}, nil
}

// Record appends an execution entry both to the on-disk journal and in-memory ring buffer.
func (j *ExecutionJournal) Record(entry models.JournalEntry) error {
	if entry.ID == "" {
		entry.ID = generateJournalID()
	}
	if entry.Timestamp.IsZero() {
		entry.Timestamp = time.Now().UTC()
	}

	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("marshal journal entry: %w", err)
	}
	data = append(data, '\n')

	j.mu.Lock()
	defer j.mu.Unlock()

	if j.file != nil {
		if _, writeErr := j.file.Write(data); writeErr != nil {
			return fmt.Errorf("write journal file: %w", writeErr)
		}
	}

	j.entries = append(j.entries, entry)
	if len(j.entries) > j.maxRing {
		// Drop oldest
		j.entries = j.entries[len(j.entries)-j.maxRing:]
	}

	return nil
}

// GetEntries returns journal records matching the optional coin and action filters,
// ordered newest to oldest. Limit defaults to 100, maximum 500.
func (j *ExecutionJournal) GetEntries(coin, action string, limit int) []models.JournalEntry {
	j.mu.RLock()
	defer j.mu.RUnlock()

	if limit <= 0 || limit > 500 {
		limit = 100
	}

	coin = strings.ToUpper(strings.TrimSpace(coin))
	action = strings.ToUpper(strings.TrimSpace(action))

	results := make([]models.JournalEntry, 0, limit)
	// Iterate in reverse (newest first)
	for i := len(j.entries) - 1; i >= 0 && len(results) < limit; i-- {
		e := j.entries[i]
		if coin != "" && strings.ToUpper(e.Coin) != coin {
			continue
		}
		if action != "" && strings.ToUpper(e.Action) != action {
			continue
		}
		results = append(results, e)
	}

	return results
}

// GetSummary aggregates execution metrics across all recorded entries.
func (j *ExecutionJournal) GetSummary() models.JournalSummary {
	j.mu.RLock()
	defer j.mu.RUnlock()

	summary := models.JournalSummary{
		TotalEntries: len(j.entries),
	}
	if len(j.entries) == 0 {
		return summary
	}

	var successfulOrders int
	var latencySum int64
	var slippageSum float64
	var slippageCount int

	for _, e := range j.entries {
		if strings.Contains(strings.ToUpper(e.Action), "CANCEL") {
			summary.TotalCancels++
		} else {
			summary.TotalOrders++
			if e.Sz > 0 && e.LimitPx > 0 {
				summary.TotalVolumeUsd += e.Sz * e.LimitPx
			} else if e.Sz > 0 && e.PreTradeMid > 0 {
				summary.TotalVolumeUsd += e.Sz * e.PreTradeMid
			}
		}

		if e.Success {
			successfulOrders++
		}
		latencySum += e.LatencyMs

		if e.RealizedSlippageBps != 0 {
			slippageSum += e.RealizedSlippageBps
			slippageCount++
		}

		if e.Timestamp.After(summary.LastRecordedAt) {
			summary.LastRecordedAt = e.Timestamp
		}
	}

	if summary.TotalEntries > 0 {
		summary.SuccessRatePct = float64(successfulOrders) / float64(summary.TotalEntries) * 100
		summary.AvgLatencyMs = float64(latencySum) / float64(summary.TotalEntries)
	}
	if slippageCount > 0 {
		summary.AvgSlippageBps = slippageSum / float64(slippageCount)
	}

	return summary
}

// Close flushes and closes the on-disk file handle.
func (j *ExecutionJournal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()

	if j.file != nil {
		err := j.file.Close()
		j.file = nil
		return err
	}
	return nil
}

func generateJournalID() string {
	var b [8]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return fmt.Sprintf("exec_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("exec_%d_%s", time.Now().UnixNano(), hex.EncodeToString(b[:]))
}
