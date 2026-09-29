package utils

import (
	"strconv"
	"strings"
)

// ParseFloat64 parses a value that may be string or float64.
func ParseFloat64(v interface{}) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	if s, ok := v.(string); ok {
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	return 0
}

// GetDexName extracts the DEX prefix from a coin name (e.g., "xyz" from "xyz:GOLD").
// Returns empty string for standard perps without a dex qualifier.
func GetDexName(coin string) string {
	coin = strings.TrimSpace(coin)
	if idx := strings.Index(coin, ":"); idx > 0 && idx < len(coin)-1 {
		return coin[:idx]
	}
	return ""
}

// IsBuilderPerpCoin reports whether coin is a builder-dex perp ("<dex>:<symbol>").
// This is the canonical routing classifier for exchange wire and account runtime.
// Category-specific product rules (e.g. stock mispricing on xyz only) should use
// IsHip3Coin, not reimplement prefix checks.
func IsBuilderPerpCoin(coin string) bool {
	return GetDexName(coin) != ""
}

// IsHip3Coin returns true if the coin is an xyz HIP-3 synthetic (category label).
// Do not use this for order routing — use IsBuilderPerpCoin / GetDexName instead.
func IsHip3Coin(coin string) bool {
	return strings.EqualFold(GetDexName(coin), "xyz")
}

// GetSpotUSDCBalance extracts available USDC from spotClearinghouseState.
func GetSpotUSDCBalance(spotState map[string]interface{}) float64 {
	balances, ok := spotState["balances"].([]interface{})
	if !ok {
		return 0
	}
	for _, b := range balances {
		if bal, ok := b.(map[string]interface{}); ok {
			if coin, ok := bal["coin"].(string); ok && coin == "USDC" {
				total := ParseFloat64(bal["total"])
				hold := ParseFloat64(bal["hold"])
				return total - hold
			}
		}
	}
	return 0
}

// GetSpotWithdrawable extracts withdrawable amount from spotClearinghouseState.
func GetSpotWithdrawable(spotState map[string]interface{}) float64 {
	if avail, ok := spotState["tokenToAvailableAfterMaintenance"].([]interface{}); ok {
		for _, item := range avail {
			if arr, ok := item.([]interface{}); ok && len(arr) >= 2 {
				if token, ok := arr[0].(float64); ok && token == 0 {
					if val, ok := arr[1].(string); ok {
						return ParseFloat64(val)
					}
				}
			}
		}
	}
	// Fallback: total - hold
	return GetSpotUSDCBalance(spotState)
}

// GetPortfolioCurrentValue extracts the current account value from the portfolio endpoint response.
// Portfolio response is an array of [period, {data}] tuples.
func GetPortfolioCurrentValue(portfolio []interface{}) float64 {
	for _, entry := range portfolio {
		arr, ok := entry.([]interface{})
		if !ok || len(arr) < 2 {
			continue
		}
		period, ok := arr[0].(string)
		if !ok || period != "allTime" {
			continue
		}
		data, ok := arr[1].(map[string]interface{})
		if !ok {
			continue
		}
		history, ok := data["accountValueHistory"].([]interface{})
		if !ok || len(history) == 0 {
			continue
		}
		last := history[len(history)-1]
		lastArr, ok := last.([]interface{})
		if !ok || len(lastArr) < 2 {
			continue
		}
		if val, ok := lastArr[1].(string); ok {
			return ParseFloat64(val)
		}
	}
	return 0
}
