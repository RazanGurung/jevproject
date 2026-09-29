package utils

import (
	"math"
	"testing"
)

func approx(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %v, want ~%v", label, got, want)
	}
}

func TestRoundToDecimals(t *testing.T) {
	approx(t, "RoundToDecimals(1.23456789, 4)", RoundToDecimals(1.23456789, 4), 1.2346)
	approx(t, "RoundToDecimals(1.005, 2)", RoundToDecimals(1.005, 2), 1.0) // float repr of 1.005 rounds down
	approx(t, "RoundToDecimals(2.5, 0)", RoundToDecimals(2.5, 0), 3)
}

func TestMaintenanceMarginRate(t *testing.T) {
	approx(t, "maxLev=20", MaintenanceMarginRate(20), 0.025)
	approx(t, "maxLev=50", MaintenanceMarginRate(50), 0.01)
	approx(t, "maxLev=3", MaintenanceMarginRate(3), 0.16666667)
	// Non-positive leverage falls back to a conservative 5%.
	approx(t, "maxLev=0", MaintenanceMarginRate(0), 0.05)
	approx(t, "maxLev=-1", MaintenanceMarginRate(-1), 0.05)
}

func TestInitialMargin(t *testing.T) {
	approx(t, "long", InitialMargin(2, 50000, 10), 10000)
	// Size is taken absolute, so a short of equal magnitude costs the same margin.
	approx(t, "short via negative size", InitialMargin(-2, 50000, 10), 10000)
	// Guard: non-positive leverage yields zero, not a divide-by-zero.
	approx(t, "zero leverage", InitialMargin(2, 50000, 0), 0)
}

func TestCalcMaintenanceMargin(t *testing.T) {
	approx(t, "value=100000 maxLev=20", CalcMaintenanceMargin(100000, 20), 2500)
}

func TestDistanceToLiqPct(t *testing.T) {
	approx(t, "entry=100 liq=90", DistanceToLiqPct(100, 90), 10)
	approx(t, "entry=100 liq=110", DistanceToLiqPct(100, 110), 10)
	approx(t, "entry<=0 guard", DistanceToLiqPct(0, 90), 0)
}

func TestLiquidationPriceIsolatedAtEntry(t *testing.T) {
	// entry=100, lev=10, maxLev=20, l=0.025.
	// long:  100 - 100*(0.1-0.025)/0.975  = 92.30769231
	approx(t, "long", LiquidationPriceIsolatedAtEntry(100, 10, 20, true), 92.30769231)
	// short: 100 + 100*(0.1-0.025)/1.025 = 107.31707317
	approx(t, "short", LiquidationPriceIsolatedAtEntry(100, 10, 20, false), 107.31707317)
	// Guards.
	approx(t, "entry<=0", LiquidationPriceIsolatedAtEntry(0, 10, 20, true), 0)
	approx(t, "lev<=0", LiquidationPriceIsolatedAtEntry(100, 0, 20, true), 0)
	approx(t, "maxLev<=0", LiquidationPriceIsolatedAtEntry(100, 10, 0, true), 0)
}

func TestLiquidationPriceCross(t *testing.T) {
	// markPx=100, accountValue=200, maintMargin=0 → marginAvailable=200,
	// positionSize=10, maxLev=50 → l=0.01.
	// long:  100 - 200/10/0.99  = 79.7979798
	approx(t, "long", LiquidationPriceCross(100, 200, 0, 10, true, 50), 79.7979798)
	// short: 100 + 200/10/1.01 = 119.8019802
	approx(t, "short", LiquidationPriceCross(100, 200, 0, 10, false, 50), 119.8019802)
	// Negative margin available is floored to zero → liq price at mark.
	approx(t, "margin underwater floored", LiquidationPriceCross(100, 0, 500, 10, true, 50), 100)
	// Guards.
	approx(t, "markPx<=0", LiquidationPriceCross(0, 200, 0, 10, true, 50), 0)
	approx(t, "positionSize<=0", LiquidationPriceCross(100, 200, 0, 0, true, 50), 0)
}

func TestLiquidationPriceFull(t *testing.T) {
	// Explicit marginAvailable=200, otherwise identical to the cross example.
	approx(t, "long", LiquidationPriceFull(100, 200, 10, true, 50), 79.7979798)
	approx(t, "short", LiquidationPriceFull(100, 200, 10, false, 50), 119.8019802)
	approx(t, "positionSize<=0", LiquidationPriceFull(100, 200, 0, true, 50), 0)
}

