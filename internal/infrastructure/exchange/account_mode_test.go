package exchange

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestFindAccountMode(t *testing.T) {
	tests := []struct {
		name string
		in   interface{}
		want string
	}{
		{"standard", map[string]interface{}{"userState": map[string]interface{}{"abstraction": "disabled"}}, "standard"},
		{"unified", map[string]interface{}{"userState": map[string]interface{}{"accountAbstractionMode": "unifiedAccount"}}, "unifiedAccount"},
		{"portfolio", []interface{}{map[string]interface{}{"abstractionMode": "p"}}, "portfolioMargin"},
		{"legacy enabled", map[string]interface{}{"dexAbstractionEnabled": true}, "dexAbstraction"},
		{"legacy false is ambiguous", map[string]interface{}{"dexAbstractionEnabled": false}, ""},
		{"unknown", map[string]interface{}{"userState": map[string]interface{}{}}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := findAccountMode(tt.in); got != tt.want {
				t.Fatalf("findAccountMode()=%q want %q", got, tt.want)
			}
		})
	}
}

func TestGetAccountUsesCachedOptionalBuildersWithoutFanout(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	var mu sync.Mutex
	requests := make([]string, 0)
	adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		text := string(body)
		mu.Lock()
		requests = append(requests, text)
		mu.Unlock()
		response := `{}`
		switch {
		case strings.Contains(text, `"type":"webData3"`):
			response = `{"userState":{"accountAbstractionMode":"standard"}}`
		case strings.Contains(text, `"type":"spotClearinghouseState"`):
			response = `{"balances":[]}`
		case strings.Contains(text, `"dex":"vntl"`):
			response = `{"assetPositions":[{"position":{"coin":"vntl:BTC"}}]}`
		case strings.Contains(text, `"type":"clearinghouseState"`):
			response = `{"assetPositions":[],"marginSummary":{"accountValue":"100","totalMarginUsed":"0"},"withdrawable":"100"}`
		case strings.Contains(text, `"type":"portfolio"`):
			response = `[]`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(response)), Header: make(http.Header)}, nil
	})}

	if _, err := adapter.GetBuilderDexState(context.Background(), "0xabc", "vntl", false); err != nil {
		t.Fatalf("prime builder cache: %v", err)
	}
	mu.Lock()
	requests = nil
	mu.Unlock()

	state, err := adapter.GetAccount(context.Background(), "0xabc")
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	positions, _ := state["assetPositions"].([]interface{})
	if len(positions) != 1 {
		t.Fatalf("cached optional builder positions=%v, want one", positions)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, body := range requests {
		if strings.Contains(body, `"type":"perpDexs"`) || strings.Contains(body, `"dex":"vntl"`) {
			t.Fatalf("core account read performed optional builder fanout: %s", body)
		}
	}
}

func TestGenericBuilderDexDiscoveryAndState(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		response := `[]`
		switch {
		case strings.Contains(string(body), `"type":"perpDexs"`):
			response = `[null,{"name":"xyz"},{"name":"vntl"}]`
		case strings.Contains(string(body), `"type":"clearinghouseState"`):
			response = `{"assetPositions":[{"position":{"coin":"vntl:BTC"}}]}`
		case strings.Contains(string(body), `"type":"frontendOpenOrders"`):
			response = `[{"coin":"vntl:BTC","oid":7}]`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(response)), Header: make(http.Header)}, nil
	})}

	// Only xyz HIP-3 markets are loaded; other builder dexs from perpDexs are filtered out.
	dexes, err := adapter.GetBuilderDexes(context.Background())
	if err != nil || len(dexes) != 1 || dexes[0] != "xyz" {
		t.Fatalf("GetBuilderDexes()=%v err=%v want [xyz]", dexes, err)
	}
	// GetBuilderDexState remains generic for explicit dex lookups (not market loading).
	state, err := adapter.GetBuilderDexState(context.Background(), "0xabc", "vntl", true)
	if err != nil || state.Dex != "vntl" || len(state.Positions) != 1 || len(state.Orders) != 1 {
		t.Fatalf("GetBuilderDexState()=%+v err=%v", state, err)
	}
}
