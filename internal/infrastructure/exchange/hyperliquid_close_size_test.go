package exchange

import "testing"

func TestCloseOrderSizeQuantizesPartialControlsWithoutOverClosing(t *testing.T) {
	tests := []struct {
		name      string
		szi       float64
		requested float64
		fraction  float64
		decimals  int
		want      float64
	}{
		{name: "BTC 25 percent", szi: 0.00017, requested: 0.00017, fraction: 0.25, decimals: 5, want: 0.00004},
		{name: "BTC 50 percent short", szi: -0.00017, requested: 0.00017, fraction: 0.5, decimals: 5, want: 0.00008},
		{name: "BTC 75 percent", szi: 0.00017, requested: 0.00017, fraction: 0.75, decimals: 5, want: 0.00012},
		{name: "full ignores stale requested size", szi: -0.00017, requested: 0.00010, fraction: 1, decimals: 5, want: 0.00017},
		{name: "GOLD 25 percent", szi: 0.0027, requested: 0.0027, fraction: 0.25, decimals: 4, want: 0.0006},
		{name: "too small partial", szi: 0.00001, requested: 0.00001, fraction: 0.25, decimals: 5, want: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := closeOrderSize(tc.szi, tc.requested, tc.fraction, tc.decimals); got != tc.want {
				t.Fatalf("closeOrderSize()=%v, want %v", got, tc.want)
			}
		})
	}
}

func TestClosePositionResultFromResponsePartialAndFull(t *testing.T) {
	cloid := "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	partial := closePositionResultFromResponse(1.0, &cloid, map[string]interface{}{
		"filled": map[string]interface{}{
			"avgPx":   "100",
			"totalSz": "0.2",
			"oid":     float64(9),
		},
	})
	if !partial.Partial || partial.FilledSzCoin != 0.2 || partial.ResidualSzCoin < 0.79 || partial.ResidualSzCoin > 0.81 {
		t.Fatalf("unexpected partial result %+v", partial)
	}
	if partial.Cloid != cloid || partial.Status != "ok" {
		t.Fatalf("missing cloid/status: %+v", partial)
	}

	full := closePositionResultFromResponse(1.0, &cloid, map[string]interface{}{
		"response": map[string]interface{}{
			"data": map[string]interface{}{
				"statuses": []interface{}{
					map[string]interface{}{
						"filled": map[string]interface{}{"avgPx": "99", "totalSz": "0.98"},
					},
				},
			},
		},
	})
	if full.Partial {
		t.Fatalf("0.98/1.0 should be within 3%% tolerance, got %+v", full)
	}

	empty := closePositionResultFromResponse(0.5, &cloid, map[string]interface{}{"status": "ok"})
	if !empty.Partial || empty.ResidualSzCoin != 0.5 || empty.FilledSzCoin != 0 {
		t.Fatalf("empty fill should be full residual: %+v", empty)
	}
}
