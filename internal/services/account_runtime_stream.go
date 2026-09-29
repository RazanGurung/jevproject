package services

import (
	"bytes"
	"encoding/json"
	"strings"
)

func extractRuntimeTerminalOids(payload interface{}) []int64 {
	entries := collectRuntimeEntries(payload)
	oids := make([]int64, 0)
	for _, entry := range entries {
		if !isRuntimeTerminalStatus(entry) {
			continue
		}
		if oid := extractRuntimeNestedOid(entry); oid > 0 {
			oids = append(oids, oid)
		}
	}
	return oids
}

func collectRuntimeEntries(payload interface{}) []map[string]interface{} {
	switch typed := payload.(type) {
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			if entry, ok := item.(map[string]interface{}); ok {
				out = append(out, entry)
			}
		}
		return out
	case map[string]interface{}:
		out := make([]map[string]interface{}, 0)
		for _, key := range []string{"orderUpdates", "statuses", "orders", "fills"} {
			if items, ok := typed[key].([]interface{}); ok {
				for _, item := range items {
					if entry, ok := item.(map[string]interface{}); ok {
						out = append(out, entry)
					}
				}
			}
		}
		if len(out) == 0 {
			out = append(out, typed)
		}
		return out
	default:
		return nil
	}
}

func isRuntimeTerminalStatus(entry map[string]interface{}) bool {
	statusParts := []string{
		stringValue(entry["status"]),
		stringValue(entry["orderStatus"]),
		stringValue(entry["state"]),
		stringValue(entry["type"]),
		stringValue(entry["reason"]),
	}
	joined := strings.ToLower(strings.Join(statusParts, " "))
	return strings.Contains(joined, "cancel") ||
		strings.Contains(joined, "fill") ||
		strings.Contains(joined, "close") ||
		strings.Contains(joined, "reject") ||
		strings.Contains(joined, "expire") ||
		strings.Contains(joined, "delete")
}

func extractRuntimeNestedOid(entry map[string]interface{}) int64 {
	if oid := parseRuntimeFloat(entry["oid"]); oid > 0 {
		return int64(oid)
	}
	for _, key := range []string{"order", "resting"} {
		if nested, ok := entry[key].(map[string]interface{}); ok {
			if oid := parseRuntimeFloat(nested["oid"]); oid > 0 {
				return int64(oid)
			}
		}
	}
	return 0
}

func stringValue(value interface{}) string {
	text, _ := value.(string)
	return text
}

func buildCanonicalSnapshotMessage(snapshot AccountRuntimeSnapshot) []byte {
	if !snapshot.HasSnapshot {
		return nil
	}
	msg := map[string]interface{}{
		"channel": "webData2",
		"data": map[string]interface{}{
			"orders":        snapshot.Orders,
			"orderRevision": snapshot.Revision,
			"ordersFresh":   snapshot.OrderFresh,
		},
	}
	data, _ := json.Marshal(msg)
	return data
}

func containsRuntimeWebDataChannel(raw []byte) bool {
	return bytes.Contains(raw, []byte(`"webData2"`)) || bytes.Contains(raw, []byte(`"webData3"`))
}

func injectOrdersIntoWebData2(raw []byte, snapshot AccountRuntimeSnapshot) []byte {
	if !snapshot.HasSnapshot || len(raw) == 0 {
		return raw
	}
	// Fast check: only inject into aggregate account stream messages.
	if !containsRuntimeWebDataChannel(raw) {
		return raw
	}

	// Build the injection fragment once
	injectionFields := map[string]interface{}{
		"orders":        snapshot.Orders,
		"orderRevision": snapshot.Revision,
		"ordersFresh":   snapshot.OrderFresh,
	}
	injectionBytes, err := json.Marshal(injectionFields)
	if err != nil {
		return raw
	}
	// injectionBytes is like {"orders":[...],"orderRevision":5,"ordersFresh":true}
	// We need the inner content without the outer braces: "orders":[...],...
	inner := injectionBytes[1 : len(injectionBytes)-1]

	// Find the "data":{...} object and inject fields at the start
	dataIdx := bytes.Index(raw, []byte(`"data":{`))
	if dataIdx < 0 {
		// Fallback: full parse
		return injectOrdersIntoWebData2Fallback(raw, snapshot)
	}
	insertAt := dataIdx + len(`"data":{`)
	// Splice: raw[:insertAt] + inner + "," + raw[insertAt:]
	result := make([]byte, 0, len(raw)+len(inner)+1)
	result = append(result, raw[:insertAt]...)
	result = append(result, inner...)
	result = append(result, ',')
	result = append(result, raw[insertAt:]...)
	return result
}

func injectOrdersIntoWebData2Fallback(raw []byte, snapshot AccountRuntimeSnapshot) []byte {
	var msg map[string]interface{}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return raw
	}
	data, _ := msg["data"].(map[string]interface{})
	if data == nil {
		data = map[string]interface{}{}
		msg["data"] = data
	}
	data["orders"] = snapshot.Orders
	data["orderRevision"] = snapshot.Revision
	data["ordersFresh"] = snapshot.OrderFresh
	encoded, err := json.Marshal(msg)
	if err != nil {
		return raw
	}
	return encoded
}
