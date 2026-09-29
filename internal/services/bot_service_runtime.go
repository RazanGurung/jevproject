package services

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"hyperliquid-go/internal/domain/models"
)

func computeBotBands(candles []botCandle, prevKVWAP *float64) (float64, float64, error) {
	if len(candles) < 2 {
		return 0, 0, fmt.Errorf("not enough candles")
	}

	now := nowMillis()
	vwapCutoff := now - int64(botVwapDays)*24*60*60*1000
	stdDevCutoff := now - int64(float64(botVwapDays)*botStdDevRatio*24*60*60*1000)

	var cumVP float64
	var cumV float64
	dhArr := make([]float64, 0, len(candles))
	dlArr := make([]float64, 0, len(candles))

	for _, candle := range candles {
		if candle.Time >= vwapCutoff && candle.High > 0 && candle.Low > 0 && candle.Close > 0 && candle.Volume > 0 {
			typicalPrice := (candle.High + candle.Low + candle.Close) / 3
			cumVP += typicalPrice * candle.Volume
			cumV += candle.Volume
		}
	}
	if cumV == 0 {
		return 0, 0, fmt.Errorf("no candle volume in vwap window")
	}

	rawVWAP := cumVP / cumV
	vwap := rawVWAP
	if prevKVWAP != nil {
		vwap = *prevKVWAP + botKalmanGain*(rawVWAP-*prevKVWAP)
	}

	for _, candle := range candles {
		if candle.Time < stdDevCutoff || vwap == 0 || candle.High <= 0 || candle.Low <= 0 {
			continue
		}
		dhArr = append(dhArr, (candle.High-vwap)/vwap)
		dlArr = append(dlArr, (candle.Low-vwap)/vwap)
	}
	if len(dhArr) < 2 || len(dlArr) < 2 {
		return 0, 0, fmt.Errorf("not enough candles in stddev window")
	}

	upperSigma := computeSigma(dhArr)
	lowerSigma := computeSigma(dlArr)
	upper2 := vwap * (1 + upperSigma*2.0)
	lower2 := vwap * (1 - lowerSigma*2.0)
	stdDev := (upper2 - lower2) / 4
	if stdDev <= 0 || math.IsNaN(stdDev) || math.IsInf(stdDev, 0) {
		return 0, 0, fmt.Errorf("invalid stddev")
	}
	return vwap, stdDev, nil
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func computeSigma(values []float64) float64 {
	if len(values) == 0 {
		return 0.001
	}
	var sum float64
	var sumSquares float64
	for _, value := range values {
		sum += value
		sumSquares += value * value
	}
	n := float64(len(values))
	sigma := math.Sqrt(math.Max(sumSquares/n-math.Pow(sum/n, 2), 0))
	if sigma == 0 {
		return 0.001
	}
	return sigma
}

func buildBotOrders(coin string, currentPrice, vwap, stdDev float64, cfg models.BotConfig) []models.OrderRequest {
	orders := make([]models.OrderRequest, 0, cfg.OrdersPerSide*2)
	if currentPrice <= 0 || vwap <= 0 || stdDev <= 0 {
		return orders
	}

	var bidLevels []float64
	var askLevels []float64
	if cfg.BulkMode {
		bidLevels = generateSkewedPriceLevels(botMinStdDevOffset, botMaxStdDevOffset, cfg.OrdersPerSide, cfg.BidSkew)
		askLevels = generateSkewedPriceLevels(botMinStdDevOffset, botMaxStdDevOffset, cfg.OrdersPerSide, cfg.AskSkew)
	} else {
		bidLevels = generateLinearLevels(botMinStdDevOffset, botMaxStdDevOffset, cfg.OrdersPerSide)
		askLevels = generateLinearLevels(botMinStdDevOffset, botMaxStdDevOffset, cfg.OrdersPerSide)
	}

	for _, level := range bidLevels {
		price := vwap - (level * stdDev)
		if price > currentPrice {
			continue
		}
		size := cfg.OrderSize
		if !cfg.BulkMode {
			sizeMultiplier := 1 + ((level-botMinStdDevOffset)/(botMaxStdDevOffset-botMinStdDevOffset))*cfg.BidSkew
			size = math.Max(15, cfg.OrderSize*sizeMultiplier)
		}
		orders = append(orders, models.OrderRequest{Coin: coin, IsBuy: true, Sz: size, LimitPx: price})
	}

	for _, level := range askLevels {
		price := vwap + (level * stdDev)
		if price <= currentPrice {
			continue
		}
		size := cfg.OrderSize
		if !cfg.BulkMode {
			sizeMultiplier := 1 + ((level-botMinStdDevOffset)/(botMaxStdDevOffset-botMinStdDevOffset))*cfg.AskSkew
			size = math.Max(15, cfg.OrderSize*sizeMultiplier)
		}
		orders = append(orders, models.OrderRequest{Coin: coin, IsBuy: false, Sz: size, LimitPx: price})
	}

	return orders
}

func generateLinearLevels(minLevel, maxLevel float64, count int) []float64 {
	if count <= 1 {
		return []float64{minLevel}
	}
	levels := make([]float64, 0, count)
	for i := 0; i < count; i++ {
		t := float64(i) / float64(count-1)
		levels = append(levels, minLevel+t*(maxLevel-minLevel))
	}
	return levels
}

func generateSkewedPriceLevels(minLevel, maxLevel float64, count int, skew float64) []float64 {
	if count <= 1 {
		return []float64{minLevel}
	}
	if skew <= 1 {
		return generateLinearLevels(minLevel, maxLevel, count)
	}
	levels := make([]float64, 0, count)
	rangeSize := maxLevel - minLevel
	scale := 1 - math.Exp(-skew)
	for i := 0; i < count; i++ {
		t := float64(i) / float64(count-1)
		curve := (1 - math.Exp(-skew*t)) / scale
		levels = append(levels, minLevel+rangeSize*curve)
	}
	return levels
}

func extractBotOrderIDs(result *models.CanonicalBulkOrderResult) []int64 {
	if result == nil || len(result.Statuses) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(result.Statuses))
	for _, status := range result.Statuses {
		if status.Accepted && status.Oid > 0 {
			ids = append(ids, status.Oid)
		}
	}
	return ids
}

func parseBotFloat(value interface{}) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed
	default:
		return 0
	}
}

func parseBotInt64(value interface{}) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}
