package services

import (
	"context"
	"testing"
)

func TestBotCandlesUseInjectedBackendSource(t *testing.T) {
	called := false
	service := &BotService{}
	service.SetCandleSnapshotFetcher(func(_ context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		called = true
		if coin != "xyz:GOLD" || interval != "15m" || startTime != 10 || endTime != 20 {
			t.Fatalf("unexpected request: %s %s %d %d", coin, interval, startTime, endTime)
		}
		return []byte(`[{"t":10,"h":"3","l":"1","c":"2","v":"4"}]`), nil
	})

	candles, err := service.fetchCandles(context.Background(), "xyz:GOLD", "15m", 10, 20)
	if err != nil {
		t.Fatalf("fetchCandles: %v", err)
	}
	if !called {
		t.Fatal("injected candle source was not used")
	}
	if len(candles) != 1 || candles[0].Time != 10 || candles[0].High != 3 || candles[0].Low != 1 || candles[0].Close != 2 || candles[0].Volume != 4 {
		t.Fatalf("decoded candles = %#v", candles)
	}
}
