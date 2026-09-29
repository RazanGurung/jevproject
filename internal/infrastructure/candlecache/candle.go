package candlecache

import (
	"sort"
	"strconv"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

// Candle mirrors the upstream candleSnapshot/candle-WS shape so cached bytes
// are interchangeable with proxied ones. Tags "t" and "T" both resolve via
// exact-match unmarshal.
type Candle struct {
	OpenMs   int64    `json:"t"`
	CloseMs  int64    `json:"T"`
	Symbol   string   `json:"s"`
	Interval string   `json:"i"`
	Open     string   `json:"o"`
	Close    string   `json:"c"`
	High     string   `json:"h"`
	Low      string   `json:"l"`
	Volume   string   `json:"v"`
	Trades   int64    `json:"n"`
	CvdDelta *float64 `json:"cvdDelta,omitempty"`
}

// candleFromMap coerces a decoded candle-WS payload into a Candle. The data
// object is either the candle itself or wraps it under "candle".
func candleFromMap(data map[string]interface{}) (Candle, bool) {
	if inner, ok := data["candle"].(map[string]interface{}); ok {
		data = inner
	}
	c := Candle{
		OpenMs:  int64(numericToFloat64(data["t"])),
		CloseMs: int64(numericToFloat64(data["T"])),
		Trades:  int64(numericToFloat64(data["n"])),
		Open:    numericToString(data["o"]),
		Close:   numericToString(data["c"]),
		High:    numericToString(data["h"]),
		Low:     numericToString(data["l"]),
		Volume:  numericToString(data["v"]),
	}
	c.Symbol, _ = data["s"].(string)
	c.Interval, _ = data["i"].(string)
	if c.OpenMs <= 0 || c.Symbol == "" || c.Interval == "" {
		return Candle{}, false
	}
	return c, true
}

// mergeCandles combines two candle sets, deduping by open time. On conflict
// the candle with the higher trade count wins (trade count grows monotonically
// within a bucket's life, so higher n = newer snapshot regardless of whether
// it came from REST or WS); incoming wins ties.
func mergeCandles(existing, incoming []Candle) []Candle {
	if len(existing) == 0 && candlesSortedUnique(incoming) {
		out := make([]Candle, len(incoming))
		copy(out, incoming)
		return out
	}
	if len(incoming) == 0 && candlesSortedUnique(existing) {
		out := make([]Candle, len(existing))
		copy(out, existing)
		return out
	}
	if candlesSortedUnique(existing) && candlesSortedUnique(incoming) {
		return mergeCandlesSorted(existing, incoming)
	}
	byTime := make(map[int64]Candle, len(existing)+len(incoming))
	for _, c := range existing {
		byTime[c.OpenMs] = c
	}
	for _, c := range incoming {
		if prev, ok := byTime[c.OpenMs]; ok && prev.Trades > c.Trades {
			continue
		}
		byTime[c.OpenMs] = c
	}
	merged := make([]Candle, 0, len(byTime))
	for _, c := range byTime {
		merged = append(merged, c)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].OpenMs < merged[j].OpenMs })
	return merged
}

func mergeCandlesSorted(existing, incoming []Candle) []Candle {
	merged := make([]Candle, 0, len(existing)+len(incoming))
	i, j := 0, 0
	for i < len(existing) && j < len(incoming) {
		if existing[i].OpenMs < incoming[j].OpenMs {
			merged = append(merged, existing[i])
			i++
		} else if incoming[j].OpenMs < existing[i].OpenMs {
			merged = append(merged, incoming[j])
			j++
		} else {
			if incoming[j].Trades >= existing[i].Trades {
				merged = append(merged, incoming[j])
			} else {
				merged = append(merged, existing[i])
			}
			i++
			j++
		}
	}
	if i < len(existing) {
		merged = append(merged, existing[i:]...)
	}
	if j < len(incoming) {
		merged = append(merged, incoming[j:]...)
	}
	return merged
}

// restoreCandles prepares snapshot rows for an empty series. Writers emit
// sorted, deduped candles; the common path is a single copy without the
// map+sort of mergeCandles. Malformed rows still fall back to a full merge.
func restoreCandles(candles []Candle) []Candle {
	if len(candles) == 0 {
		return nil
	}
	if candlesSortedUnique(candles) {
		out := make([]Candle, len(candles))
		copy(out, candles)
		return out
	}
	return mergeCandles(nil, candles)
}

func candlesSortedUnique(candles []Candle) bool {
	for i := 1; i < len(candles); i++ {
		if candles[i].OpenMs <= candles[i-1].OpenMs {
			return false
		}
	}
	return true
}

func numericToFloat64(v interface{}) float64 {
	switch value := v.(type) {
	case float64:
		return value
	case int64:
		return float64(value)
	case int:
		return float64(value)
	case string:
		f, _ := strconv.ParseFloat(value, 64)
		return f
	default:
		return 0
	}
}

func numericToString(v interface{}) string {
	switch value := v.(type) {
	case string:
		return value
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	default:
		return ""
	}
}

func intervalMs(interval string) int64 {
	if ms := chartrequirements.IntervalMs(interval); ms > 0 {
		return ms
	}
	if interval == "3d" {
		return 259_200_000
	}
	return 0
}

// nextOpenMs is the open of the bucket that immediately follows openMs.
// 1M uses the next UTC calendar month start (Hyperliquid 1M cadence), not +30d.
func nextOpenMs(openMs int64, interval string) int64 {
	if openMs <= 0 {
		return 0
	}
	if interval == "1M" {
		open := time.UnixMilli(openMs).UTC()
		return time.Date(open.Year(), open.Month()+1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	}
	ms := intervalMs(interval)
	if ms <= 0 {
		return 0
	}
	return openMs + ms
}

func isNextOpen(prevOpen, nextOpen int64, interval string) bool {
	expected := nextOpenMs(prevOpen, interval)
	return expected > 0 && nextOpen == expected
}
