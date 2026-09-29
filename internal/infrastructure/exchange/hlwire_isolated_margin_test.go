package exchange

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"hyperliquid-go/internal/infrastructure/signing"
)

func TestUsdToNtli(t *testing.T) {
	got, err := usdToNtli(12.5)
	if err != nil {
		t.Fatal(err)
	}
	if got != 12_500_000 {
		t.Fatalf("usdToNtli(12.5) = %d, want 12500000", got)
	}
	got, err = usdToNtli(-1)
	if err != nil {
		t.Fatal(err)
	}
	if got != -1_000_000 {
		t.Fatalf("usdToNtli(-1) = %d, want -1000000", got)
	}
	if _, err := usdToNtli(math.NaN()); err == nil {
		t.Fatal("expected error for NaN")
	}
}

func TestTriggerExecPriceUsesSlippageForMarket(t *testing.T) {
	trigger := 100.0
	got := triggerExecPrice(true, false, trigger, 2)
	want := slippagePrice(trigger, false, marketOrderSlippage, 2)
	if got != want {
		t.Fatalf("market trigger exec px = %v, want %v", got, want)
	}
	if got := triggerExecPrice(false, false, trigger, 2); got != trigger {
		t.Fatalf("limit trigger exec px = %v, want trigger", got)
	}
}

func TestScheduleCancelRejectsStaleTime(t *testing.T) {
	h := NewHyperliquidAdapter()
	tooSoon := time.Now().UnixMilli() + 1000
	err := h.ScheduleCancel(t.Context(), goldenTestKey, &tooSoon, false)
	if err == nil {
		t.Fatal("expected schedule cancel to reject time < now+5s")
	}
}

func TestIsolatedMarginGoldenJSON(t *testing.T) {
	action := UpdateIsolatedMarginAction{Type: "updateIsolatedMargin", Asset: 3, IsBuy: true, Ntli: 12_500_000}
	got, err := json.Marshal(action)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"updateIsolatedMargin","asset":3,"isBuy":true,"ntli":12500000}`
	if string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
	key, err := crypto.HexToECDSA(goldenTestKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []struct {
		name    string
		expires *int64
		mainnet bool
	}{
		{"mainnet", nil, true},
		{"testnet", nil, false},
		{"expiring", &goldenExpiresAfter, true},
	} {
		sig, err := signing.SignL1Action(key, action, "", goldenNonce, variant.expires, variant.mainnet)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s R=%s S=%s V=%d", variant.name, sig.R, sig.S, sig.V)
	}
}
