package websocket

import (
	"testing"
	"time"
)

func liqFillJSON(coin, side, px, sz string, tid float64, liquidatedUser, method string) map[string]interface{} {
	return map[string]interface{}{
		"coin": coin, "side": side, "px": px, "sz": sz,
		"tid": tid, "time": float64(1000),
		"liquidation": map[string]interface{}{
			"liquidatedUser": liquidatedUser, "markPx": "49900", "method": method,
		},
	}
}

func TestExtractQuickNodeLiquidations_KeepsTaggedFillsOnly(t *testing.T) {
	env := map[string]interface{}{
		"channel": "trades",
		"data": []interface{}{
			liqFillJSON("BTC", "A", "50000", "0.1", 1, "0xabc", "market"),
			// ordinary fill: no liquidation object => ignored.
			map[string]interface{}{"coin": "ETH", "side": "B", "px": "3000", "sz": "1", "tid": float64(2)},
		},
	}
	seen := map[string]time.Time{}
	out := extractQuickNodeLiquidations(env, seen, 0)
	if len(out) != 1 {
		t.Fatalf("want 1 liquidation, got %d", len(out))
	}
	got := out[0]
	if got.Coin != "BTC" || got.Side != "A" || got.Method != "market" || got.User != "0xabc" {
		t.Fatalf("unexpected liquidation fields: %+v", got)
	}
	if got.Value != 5000 {
		t.Fatalf("value = %v, want 5000", got.Value)
	}
}

func TestExtractQuickNodeLiquidations_MinNotionalGate(t *testing.T) {
	env := map[string]interface{}{
		"data": []interface{}{liqFillJSON("BTC", "A", "50000", "0.1", 1, "0xabc", "market")},
	}
	if out := extractQuickNodeLiquidations(env, map[string]time.Time{}, 6000); len(out) != 0 {
		t.Fatalf("value 5000 should be gated by minNotional 6000, got %d", len(out))
	}
}

func TestExtractQuickNodeLiquidations_DedupesByTid(t *testing.T) {
	env := map[string]interface{}{
		"data": []interface{}{liqFillJSON("BTC", "A", "50000", "0.1", 7, "0xabc", "market")},
	}
	seen := map[string]time.Time{}
	if out := extractQuickNodeLiquidations(env, seen, 0); len(out) != 1 {
		t.Fatalf("first pass want 1, got %d", len(out))
	}
	// Same tid arriving again (victim + liquidator legs share a tid) is dropped.
	if out := extractQuickNodeLiquidations(env, seen, 0); len(out) != 0 {
		t.Fatalf("second pass should dedupe, got %d", len(out))
	}
}

func TestExtractQuickNodeLiquidations_UnwrapsParamsAndResultEnvelopes(t *testing.T) {
	for _, key := range []string{"params", "result"} {
		env := map[string]interface{}{
			key: map[string]interface{}{
				"data": []interface{}{liqFillJSON("SOL", "B", "140", "50", 1, "0xdef", "backstop")},
			},
		}
		out := extractQuickNodeLiquidations(env, map[string]time.Time{}, 0)
		if len(out) != 1 || out[0].Coin != "SOL" || out[0].Method != "backstop" {
			t.Fatalf("%s envelope: unexpected result %+v", key, out)
		}
	}
}

func TestPruneQuickNodeSeen(t *testing.T) {
	seen := map[string]time.Time{
		"old": time.Now().Add(-2 * quickNodeDedupeTTL),
		"new": time.Now(),
	}
	pruneQuickNodeSeen(seen)
	if _, ok := seen["old"]; ok {
		t.Fatalf("expired tid should be pruned")
	}
	if _, ok := seen["new"]; !ok {
		t.Fatalf("fresh tid should remain")
	}
}
