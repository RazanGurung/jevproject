package candlecache

import (
	"math"
	"sort"
	"strconv"
	"time"
)

const (
	defaultCVDLookbackDays = 90.0
	secondsPerDay          = 86400.0
	cvdRatioDivisor        = 5.0
	minPriceBandSeconds    = 6 * 3600.0
	minExtremeSamples      = 2
	cvdScale               = 0.25
	cvdEpsilon             = 1e-9
	cvdAmplitudeScale      = 2.5
	minAmplitudePeriods    = 8
)

// CVDOscillatorPoint is the compact backend read model consumed by the alert
// scanner. Time is seconds since epoch, matching lightweight-charts.
type CVDOscillatorPoint struct {
	Time  int64
	Value *float64
}

// ComputeCVDOscillator mirrors web/src/chart/cvd-oscillator.js. Keeping the
// same calculation on the backend lets scanners consume one compact endpoint
// while the visual overlay can continue rendering locally from chart candles.
func ComputeCVDOscillator(input []Candle, lookbackDays float64) []CVDOscillatorPoint {
	bars := dedupeOscillatorCandles(input)
	if len(bars) == 0 {
		return nil
	}
	n := len(bars)
	times := make([]int64, n)
	raw := make([]float64, n)
	highs := make([]float64, n)
	lows := make([]float64, n)
	closes := make([]float64, n)

	cumulative := 0.0
	for i, bar := range bars {
		times[i] = bar.OpenMs / 1000
		highs[i] = parseOscillatorFloat(bar.High)
		lows[i] = parseOscillatorFloat(bar.Low)
		closes[i] = parseOscillatorFloat(bar.Close)
		if bar.CvdDelta != nil && isFinite(*bar.CvdDelta) {
			cumulative += *bar.CvdDelta
		} else {
			cumulative += directionalDelta(bar)
		}
		raw[i] = cumulative
	}

	days := lookbackDays
	if !isFinite(days) || days <= 0 {
		days = defaultCVDLookbackDays
	}
	normalizationSeconds := days * secondsPerDay
	ratioSeconds := math.Max(normalizationSeconds/cvdRatioDivisor, minPriceBandSeconds)

	oscHigh := rollingTimeExtreme(times, raw, normalizationSeconds, minExtremeSamples, true)
	oscLow := rollingTimeExtreme(times, raw, normalizationSeconds, minExtremeSamples, false)
	priceHigh := rollingTimeExtreme(times, highs, ratioSeconds, minExtremeSamples, true)
	priceLow := rollingTimeExtreme(times, lows, ratioSeconds, minExtremeSamples, false)

	oscScaled := nanSlice(n)
	for i := 0; i < n; i++ {
		if i == 0 || !isFinite(priceHigh[i-1]) || !isFinite(priceLow[i-1]) || !isFinite(oscHigh[i]) || !isFinite(oscLow[i]) {
			continue
		}
		oscNorm := (raw[i] - oscLow[i]) / math.Max(oscHigh[i]-oscLow[i], 1e-10)
		priceRange := priceHigh[i-1] - priceLow[i-1]
		priceMid := priceLow[i-1] + priceRange*0.5
		oscScaled[i] = priceMid + (oscNorm-0.5)*priceRange*cvdScale
	}

	rawDistance := nanSlice(n)
	for i := 1; i < n; i++ {
		if isFinite(oscScaled[i-1]) && isFinite(closes[i-1]) {
			rawDistance[i] = closes[i-1] - oscScaled[i-1]
		}
	}
	absDistance := nanSlice(n)
	for i, value := range rawDistance {
		if isFinite(value) {
			absDistance[i] = math.Abs(value)
		}
	}
	meanAbs := rollingTimeMean(times, absDistance, ratioSeconds, minAmplitudePeriods)

	points := make([]CVDOscillatorPoint, n)
	for i := 0; i < n; i++ {
		points[i].Time = times[i]
		if !isFinite(rawDistance[i]) || !isFinite(meanAbs[i]) {
			continue
		}
		amplitude := meanAbs[i] * cvdAmplitudeScale
		value := clampFloat(rawDistance[i]/math.Max(amplitude, cvdEpsilon), -1, 1)
		points[i].Value = &value
	}
	return points
}

// LatestClosedCVDOscillator returns the newest finite value whose candle has
// closed. Forming bars are intentionally excluded so alerts never repaint.
func LatestClosedCVDOscillator(candles []Candle, timeframe string, lookbackDays float64, now time.Time) (int64, float64, bool) {
	points := ComputeCVDOscillator(candles, lookbackDays)
	timeframeSeconds := intervalMs(timeframe) / 1000
	if timeframeSeconds <= 0 {
		return 0, 0, false
	}
	nowSeconds := now.Unix()
	for i := len(points) - 1; i >= 0; i-- {
		point := points[i]
		if point.Value != nil && point.Time+timeframeSeconds <= nowSeconds {
			return point.Time, *point.Value, true
		}
	}
	return 0, 0, false
}

func dedupeOscillatorCandles(input []Candle) []Candle {
	byTime := make(map[int64]Candle, len(input))
	for _, candle := range input {
		if candle.OpenMs > 0 {
			byTime[candle.OpenMs] = candle
		}
	}
	out := make([]Candle, 0, len(byTime))
	for _, candle := range byTime {
		out = append(out, candle)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OpenMs < out[j].OpenMs })
	return out
}

func rollingTimeExtreme(times []int64, values []float64, windowSeconds float64, minSamples int, maximum bool) []float64 {
	out := nanSlice(len(values))
	deque := make([]int, 0, len(values))
	window := make([]int, 0, len(values))
	dequeHead, windowHead := 0, 0
	for i, value := range values {
		lower := float64(times[i]) - windowSeconds
		for dequeHead < len(deque) && float64(times[deque[dequeHead]]) < lower {
			dequeHead++
		}
		for windowHead < len(window) && float64(times[window[windowHead]]) < lower {
			windowHead++
		}
		if isFinite(value) {
			for len(deque) > dequeHead {
				back := values[deque[len(deque)-1]]
				if (maximum && back <= value) || (!maximum && back >= value) {
					deque = deque[:len(deque)-1]
				} else {
					break
				}
			}
			deque = append(deque, i)
			window = append(window, i)
		}
		if len(deque) > dequeHead && len(window)-windowHead >= minSamples {
			out[i] = values[deque[dequeHead]]
		}
	}
	return out
}

func rollingTimeMean(times []int64, values []float64, windowSeconds float64, minSamples int) []float64 {
	out := nanSlice(len(values))
	indices := make([]int, 0, len(values))
	head := 0
	sum := 0.0
	for i, value := range values {
		lower := float64(times[i]) - windowSeconds
		for head < len(indices) && float64(times[indices[head]]) < lower {
			sum -= values[indices[head]]
			head++
		}
		if isFinite(value) {
			indices = append(indices, i)
			sum += value
		}
		count := len(indices) - head
		if count >= minSamples {
			out[i] = sum / float64(count)
		}
	}
	return out
}

func parseOscillatorFloat(value string) float64 {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

func nanSlice(length int) []float64 {
	out := make([]float64, length)
	for i := range out {
		out[i] = math.NaN()
	}
	return out
}

func isFinite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func clampFloat(value, low, high float64) float64 {
	return math.Min(math.Max(value, low), high)
}
