package services

import (
	"context"
	"testing"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services/testutil"
)

func TestClosePositionKeepsCoinOrdersInAccountRuntimeUntilCancelIsConfirmed(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	var capturedSzi float64
	mockExchange.ClosePositionFunc = func(privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error) {
		capturedSzi = positionSzi
		return models.ClosePositionResult{Status: "ok", RequestedSzCoin: 0.5, FilledSzCoin: 0.5}, nil
	}

	runtime := NewAccountRuntime()
	service := NewAccountService(mockExchange, testutil.NewMockMetadataCache(), runtime)

	address := "0x123"
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(111), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(222), "coin": "ETH", "limitPx": "3000"},
	}, true)

	_, err := service.ClosePosition(context.Background(), "", address, "BTC", 1.0, 0.5, -0.5, false)
	if err != nil {
		t.Fatalf("ClosePosition returned error: %v", err)
	}
	if capturedSzi != -0.5 {
		t.Fatalf("signed position size was not forwarded: got %v", capturedSzi)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 2 {
		t.Fatalf("expected 2 remaining runtime orders, got %d", len(snapshot.Orders))
	}
	first := snapshot.Orders[0].(map[string]interface{})
	second := snapshot.Orders[1].(map[string]interface{})
	if first["coin"] != "BTC" || second["coin"] != "ETH" {
		t.Fatalf("unexpected runtime orders after close: %+v %+v", first, second)
	}
}
