package websocket

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	exchangeport "hyperliquid-go/internal/ports/exchange"
)

type accountRefreshFetcher struct {
	state map[string]interface{}
}

func (f *accountRefreshFetcher) GetAccount(context.Context, string) (map[string]interface{}, error) {
	return f.state, nil
}
func (f *accountRefreshFetcher) GetOpenOrders(context.Context, string) ([]interface{}, error) {
	return nil, nil
}

func (f *accountRefreshFetcher) GetBuilderDexes(context.Context) ([]string, error) {
	return nil, nil
}
func (f *accountRefreshFetcher) GetBuilderDexState(context.Context, string, string, bool) (exchangeport.BuilderDexState, error) {
	return exchangeport.BuilderDexState{}, nil
}

func TestRequestAccountRefreshBroadcastsRiskStateOverWebSocket(t *testing.T) {
	const account = "0x1111111111111111111111111111111111111111"
	manager := NewWebSocketManager(nil)
	manager.accountFetcher = &accountRefreshFetcher{state: map[string]interface{}{
		"riskSummary": map[string]interface{}{
			"accountValue":    "12.25",
			"availableMargin": "10.12",
		},
	}}
	client := &streamClient{
		account: account,
		kind:    tradingStream,
		conn:    &websocket.Conn{},
		sendCh:  make(chan []byte, 1),
		doneCh:  make(chan struct{}),
	}
	manager.streamClients[client] = true

	manager.RequestAccountRefresh("0x1111111111111111111111111111111111111111")

	select {
	case raw := <-client.sendCh:
		var msg map[string]interface{}
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("refresh message is not JSON: %v", err)
		}
		if msg["channel"] != "webData2" {
			t.Fatalf("channel=%v, want webData2", msg["channel"])
		}
		data, _ := msg["data"].(map[string]interface{})
		risk, _ := data["riskSummary"].(map[string]interface{})
		if risk["accountValue"] != "12.25" || risk["availableMargin"] != "10.12" {
			t.Fatalf("riskSummary=%v", risk)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for account refresh broadcast")
	}
}
