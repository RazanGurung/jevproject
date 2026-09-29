package candlecache

import (
	"math"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func oscillatorFixture() []Candle {
	return oscillatorFixtureHours(240)
}

func oscillatorFixtureHours(hours int) []Candle {
	const startSeconds = int64(1704067200)
	bars := make([]Candle, 0, hours)
	previous := 100.0
	for i := 0; i < hours; i++ {
		closeValue := 100 + 10*math.Sin(float64(i)/7) + 2*math.Sin(float64(i)/2)
		openValue := previous
		openMs := (startSeconds + int64(i)*3600) * 1000
		bars = append(bars, Candle{
			OpenMs:   openMs,
			CloseMs:  openMs + int64(time.Hour/time.Millisecond) - 1,
			Symbol:   "TEST",
			Interval: "1h",
			Open:     strconv.FormatFloat(openValue, 'g', -1, 64),
			High:     strconv.FormatFloat(math.Max(openValue, closeValue)+1, 'g', -1, 64),
			Low:      strconv.FormatFloat(math.Min(openValue, closeValue)-1, 'g', -1, 64),
			Close:    strconv.FormatFloat(closeValue, 'g', -1, 64),
			Volume:   "10",
		})
		previous = closeValue
	}
	return bars
}

func TestComputeCVDOscillatorDefaultsTo90Days(t *testing.T) {
	bars := oscillatorFixtureHours(100 * 24)
	got := ComputeCVDOscillator(bars, 0)
	want := ComputeCVDOscillator(bars, 90)
	if !reflect.DeepEqual(got, want) {
		t.Fatal("invalid lookback fallback does not match an explicit 90-day lookback")
	}
	if reflect.DeepEqual(got, ComputeCVDOscillator(bars, 30)) {
		t.Fatal("90-day default unexpectedly matches a 30-day lookback")
	}
}

func TestComputeCVDOscillatorMatchesBrowserReference(t *testing.T) {
	points := ComputeCVDOscillator(oscillatorFixture(), 3)
	want := []float64{
		0.07081600087148143,
		-0.009610871135158922,
		-0.07524461953929322,
		-0.12614121320521382,
		-0.17332614104302985,
	}
	if len(points) != 240 {
		t.Fatalf("points = %d, want 240", len(points))
	}
	for i, expected := range want {
		point := points[len(points)-len(want)+i]
		if point.Value == nil || math.Abs(*point.Value-expected) > 1e-12 {
			t.Fatalf("point %d = %v, want %.15f", i, point.Value, expected)
		}
	}
}

func TestLatestClosedCVDOscillatorExcludesFormingBar(t *testing.T) {
	bars := oscillatorFixture()
	lastOpen := time.UnixMilli(bars[len(bars)-1].OpenMs)
	barTime, value, ok := LatestClosedCVDOscillator(bars, "1h", 3, lastOpen.Add(30*time.Minute))
	if !ok {
		t.Fatal("expected a closed oscillator reading")
	}
	if want := bars[len(bars)-2].OpenMs / 1000; barTime != want {
		t.Fatalf("barTime = %d, want previous closed bar %d", barTime, want)
	}
	if math.Abs(value-(-0.12614121320521382)) > 1e-12 {
		t.Fatalf("value = %.15f", value)
	}
}
