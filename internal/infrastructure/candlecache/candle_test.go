package candlecache

import (
	"testing"
	"time"
)

func TestNextOpenMsCalendarMonth(t *testing.T) {
	jan := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	feb := time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	mar := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC).UnixMilli()

	if got := nextOpenMs(jan, "1M"); got != feb {
		t.Fatalf("Jan→Feb: got %d want %d", got, feb)
	}
	if got := nextOpenMs(feb, "1M"); got != mar {
		t.Fatalf("Feb→Mar: got %d want %d", got, mar)
	}
	if !isNextOpen(jan, feb, "1M") || !isNextOpen(feb, mar, "1M") {
		t.Fatal("adjacent calendar months must not be treated as a jump")
	}
	if isNextOpen(jan, mar, "1M") {
		t.Fatal("Jan→Mar skipped February and must be a jump")
	}

	base := int64(1_700_000_000_000)
	if !isNextOpen(base, base+intervalMs("8h"), "8h") {
		t.Fatal("fixed intervals still advance by intervalMs")
	}
}

func TestSnapshotGapFromMonthly(t *testing.T) {
	jan := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	feb := time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	mar := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	adjacent := []Candle{{OpenMs: jan}, {OpenMs: feb}, {OpenMs: mar}}
	if gap := snapshotGapFrom(adjacent, "1M"); gap != 0 {
		t.Fatalf("calendar months must not gap, got %d", gap)
	}
	skipped := []Candle{{OpenMs: jan}, {OpenMs: mar}}
	if gap := snapshotGapFrom(skipped, "1M"); gap != jan {
		t.Fatalf("Jan→Mar must gap at Jan, got %d", gap)
	}
}
