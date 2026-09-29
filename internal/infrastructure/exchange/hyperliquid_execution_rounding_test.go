package exchange

import "testing"

func TestNormalizePerpPriceRoundsToHyperliquidStylePrecision(t *testing.T) {
	if got := normalizePerpPrice(75756.5, 5); got != 75757 {
		t.Fatalf("expected 75757, got %v", got)
	}
	if got := normalizePerpPrice(95.25, 3); got != 95.25 {
		t.Fatalf("expected 95.25, got %v", got)
	}
	if got := normalizePerpPrice(123456, 2); got != 123456 {
		t.Fatalf("integer prices are always valid and must be preserved, got %v", got)
	}
	if got := normalizePerpPrice(123456.75, 2); got != 123457 {
		t.Fatalf("large fractional prices must round to the nearest valid integer price, got %v", got)
	}
}

func TestSlippagePriceUsesNormalizePerpPrice(t *testing.T) {
	// Standard market and HIP-3 market must share one precision rule after the
	// ±1% bound is applied (previously wireRound floor diverged on half-values).
	mid := 25000.5
	std := slippagePrice(mid, true, marketOrderSlippage, 5)
	hip := normalizePerpPrice(mid*(1+marketOrderSlippage), 5)
	if std != hip {
		t.Fatalf("std market %.6f != hip/normalize path %.6f", std, hip)
	}
	if std != 25251 {
		t.Fatalf("expected buy slip of 25000.5 to normalize to 25251, got %v", std)
	}

	sell := slippagePrice(99999.9, false, marketOrderSlippage, 0)
	wantSell := normalizePerpPrice(99999.9*(1-marketOrderSlippage), 0)
	if sell != wantSell {
		t.Fatalf("sell slippage = %v, want %v", sell, wantSell)
	}
}

func TestPlaceTriggerOrdersGroupsPositionTpsl(t *testing.T) {
	action := OrderAction{Type: "order", Grouping: groupingPositionTpsl}
	if action.Grouping != "positionTpsl" {
		t.Fatalf("grouping = %q, want positionTpsl", action.Grouping)
	}
}
