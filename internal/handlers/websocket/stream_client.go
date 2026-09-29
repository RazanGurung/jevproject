package websocket

import (
	"encoding/json"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const clientWriteDeadline = 5 * time.Second
const clientSendQueueSize = 512
const marketSendQueueSize = 2048

func streamQueueCapacityFor(kind streamKind) int {
	if kind.acceptsMarket() {
		return marketSendQueueSize
	}
	return clientSendQueueSize
}

func (m *WebSocketManager) sendToClient(client *streamClient, payload interface{}) {
	if client == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	m.sendRawToClient(client, data)
}

func (m *WebSocketManager) sendRawToClient(client *streamClient, data []byte) {
	if client == nil {
		return
	}
	msg := m.decorateMessageFor(client.kind, data)

	client.mu.Lock()
	if client.closed || client.conn == nil || client.sendCh == nil || client.doneCh == nil {
		client.mu.Unlock()
		return
	}
	sendCh := client.sendCh
	doneCh := client.doneCh
	client.mu.Unlock()

	select {
	case sendCh <- msg:
	case <-doneCh:
	default:
		downstreamStreamQueueDrops.WithLabelValues(client.kind.metricName()).Inc()
		m.closeStreamClient(client)
	}
}

func (m *WebSocketManager) startClientWriter(client *streamClient) {
	if client == nil {
		return
	}
	go func() {
		for {
			select {
			case <-client.doneCh:
				return
			case msg := <-client.sendCh:
				if !m.writeRawClientMessage(client, msg) {
					return
				}
			}
		}
	}()
}

func (m *WebSocketManager) writeRawClientMessage(client *streamClient, msg []byte) bool {
	if client == nil {
		return false
	}
	client.mu.Lock()
	if client.closed || client.conn == nil {
		client.mu.Unlock()
		return false
	}
	_ = client.conn.SetWriteDeadline(time.Now().Add(clientWriteDeadline))
	err := client.conn.WriteMessage(websocket.TextMessage, msg)
	client.mu.Unlock()
	if err != nil {
		m.closeStreamClient(client)
		return false
	}
	return true
}

func (m *WebSocketManager) closeStreamClient(client *streamClient) {
	if client == nil {
		return
	}
	client.once.Do(func() {
		client.mu.Lock()
		client.closed = true
		conn := client.conn
		client.conn = nil
		doneCh := client.doneCh
		client.mu.Unlock()

		if doneCh != nil {
			close(doneCh)
		}
		if conn != nil {
			_ = conn.Close()
		}
	})
}

// decorateMessageFor injects a lane-local eventId into JSON bytes using
// byte-level splicing to avoid an Unmarshal/Marshal round-trip per message.
func (m *WebSocketManager) decorateMessageFor(kind streamKind, data []byte) []byte {
	id := m.nextStreamSequenceFor(kind)
	prefix := []byte(`{"eventId":` + strconv.FormatInt(id, 10) + `,`)
	if len(data) > 0 && data[0] == '{' {
		// Replace leading '{' with '{"eventId":N,'
		return append(prefix, data[1:]...)
	}
	return data
}

func (m *WebSocketManager) nextStreamSequenceFor(kind streamKind) int64 {
	switch kind {
	case tradingStream:
		return atomic.AddInt64(&m.TradingStreamSequence, 1)
	case marketStream:
		return atomic.AddInt64(&m.MarketStreamSequence, 1)
	default:
		return 0
	}
}
