package utils

import "math"

// RoundToDecimals rounds val to the specified number of decimal places.
func RoundToDecimals(val float64, decimals int) float64 {
	multiplier := math.Pow10(decimals)
	return math.Round(val*multiplier) / multiplier
}

// MaintenanceMarginRate returns 1/(2*maxLeverage), rounded to 8 decimal places.
func MaintenanceMarginRate(maxLeverage int) float64 {
	if maxLeverage <= 0 {
		return 0.05
	}
	rate := 1.0 / (2.0 * float64(maxLeverage))
	return RoundToDecimals(rate, 8)
}

// InitialMargin returns position notional divided by leverage, rounded to 8 decimals.
func InitialMargin(positionSize, markPx float64, leverage int) float64 {
	if leverage <= 0 {
		return 0
	}
	margin := math.Abs(positionSize) * markPx / float64(leverage)
	return RoundToDecimals(margin, 8)
}

// CalcMaintenanceMargin returns position value times maintenance margin rate.
func CalcMaintenanceMargin(positionValue float64, maxLeverage int) float64 {
	margin := positionValue * MaintenanceMarginRate(maxLeverage)
	return RoundToDecimals(margin, 8)
}

// DistanceToLiqPct calculates |entryPx - liqPx| / entryPx * 100.
func DistanceToLiqPct(entryPx, liqPx float64) float64 {
	if entryPx <= 0 {
		return 0
	}
	return math.Abs(entryPx-liqPx) / entryPx * 100
}

// LiquidationPriceIsolatedAtEntry estimates the liquidation price of an
// isolated position at entry (margin = notional/leverage, no fees), valid for
// both venues. Exact Hyperliquid-docs derivation:
// liq = entry - side × entry × (1/leverage - l) / (1 - l × side), l = 1/(2 × maxLeverage).
// (A legacy approximation, entry × (1 ± (1-l)/leverage), diverged from this by
// 0.7–2.3% of entry in the risk-understating direction and was removed.)
func LiquidationPriceIsolatedAtEntry(entryPx float64, leverage int, maxLeverage int, isLong bool) float64 {
	if entryPx <= 0 || leverage <= 0 || maxLeverage <= 0 {
		return 0
	}
	l := 1.0 / (2.0 * float64(maxLeverage))
	side := 1.0
	if !isLong {
		side = -1.0
	}
	denominator := 1.0 - l*side
	if denominator == 0 {
		return 0
	}
	return entryPx - side*entryPx*(1.0/float64(leverage)-l)/denominator
}

// LiquidationPriceCross calculates the cross-margin liquidation price.
// Formula: liq_price = markPx - side × margin_available / position_size / (1 - l × side)
func LiquidationPriceCross(markPx, accountValue, maintMarginRequired, positionSize float64, isLong bool, maxLev int) float64 {
	if markPx <= 0 || positionSize <= 0 || maxLev <= 0 {
		return 0
	}
	marginAvailable := accountValue - maintMarginRequired
	if marginAvailable < 0 {
		marginAvailable = 0
	}
	l := MaintenanceMarginRate(maxLev)
	side := 1.0
	if !isLong {
		side = -1.0
	}
	denominator := 1.0 - l*side
	if denominator == 0 {
		return 0
	}
	return markPx - side*marginAvailable/positionSize/denominator
}

// LiquidationPriceFull calculates liquidation price with explicit margin_available.
func LiquidationPriceFull(markPx, marginAvailable, positionSize float64, isLong bool, maxLev int) float64 {
	if markPx <= 0 || positionSize <= 0 || maxLev <= 0 {
		return 0
	}
	l := MaintenanceMarginRate(maxLev)
	side := 1.0
	if !isLong {
		side = -1.0
	}
	denominator := 1.0 - l*side
	if denominator == 0 {
		return 0
	}
	return markPx - side*marginAvailable/positionSize/denominator
}
