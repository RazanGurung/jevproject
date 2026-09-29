package services

import (
	"encoding/json"

	"hyperliquid-go/internal/domain/models"
)

func extractAcceptedOid(result interface{}) int64 {
	root := resultToMap(result)
	if root == nil {
		return 0
	}

	if oid := extractNestedOid(root); oid > 0 {
		return oid
	}

	if resp, ok := root["response"].(map[string]interface{}); ok {
		if oid := extractNestedOid(resp); oid > 0 {
			return oid
		}
		if data, ok := resp["data"].(map[string]interface{}); ok {
			if statuses, ok := data["statuses"].([]interface{}); ok && len(statuses) > 0 {
				if first, ok := statuses[0].(map[string]interface{}); ok {
					if oid := extractNestedOid(first); oid > 0 {
						return oid
					}
				}
			}
		}
	}

	if data, ok := root["data"].(map[string]interface{}); ok {
		if statuses, ok := data["statuses"].([]interface{}); ok && len(statuses) > 0 {
			if first, ok := statuses[0].(map[string]interface{}); ok {
				return extractNestedOid(first)
			}
		}
	}

	return 0
}

func resultToMap(raw interface{}) map[string]interface{} {
	if raw == nil {
		return nil
	}
	if m, ok := raw.(map[string]interface{}); ok {
		return m
	}
	body, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var root map[string]interface{}
	if err := json.Unmarshal(body, &root); err != nil {
		return nil
	}
	return root
}

func extractNestedOid(data map[string]interface{}) int64 {
	switch value := data["oid"].(type) {
	case float64:
		if value > 0 {
			return int64(value)
		}
	case int64:
		if value > 0 {
			return value
		}
	case int:
		if value > 0 {
			return int64(value)
		}
	}

	if resting, ok := data["resting"].(map[string]interface{}); ok {
		return extractNestedOid(resting)
	}
	if filled, ok := data["filled"].(map[string]interface{}); ok {
		return extractNestedOid(filled)
	}
	if order, ok := data["order"].(map[string]interface{}); ok {
		return extractNestedOid(order)
	}
	return 0
}

func normalizeExchangeOrderResult(raw interface{}, latencyMs int64) models.CanonicalOrderResult {
	oid := extractAcceptedOid(raw)
	if oid <= 0 {
		errMsg := extractOrderError(raw)
		if errMsg == "" {
			errMsg = "order not confirmed by exchange"
		}
		return models.CanonicalOrderResult{Error: errMsg, LatencyMs: latencyMs}
	}
	return models.CanonicalOrderResult{
		Accepted:  true,
		Oid:       oid,
		Filled:    extractFilledFromResult(raw),
		LatencyMs: latencyMs,
	}
}

func normalizeExchangeBulkStatus(status interface{}, latencyMs int64) models.CanonicalOrderResult {
	m, ok := status.(map[string]interface{})
	if !ok || m == nil {
		return models.CanonicalOrderResult{Error: "empty status", LatencyMs: latencyMs}
	}
	if errText, _ := m["error"].(string); errText != "" {
		return models.CanonicalOrderResult{Error: errText, LatencyMs: latencyMs}
	}
	oid := extractNestedOid(m)
	if oid <= 0 {
		return models.CanonicalOrderResult{Error: "order not accepted", LatencyMs: latencyMs}
	}
	var filled interface{}
	if f, ok := m["filled"]; ok {
		filled = f
	}
	return models.CanonicalOrderResult{
		Accepted:  true,
		Oid:       oid,
		Filled:    filled,
		LatencyMs: latencyMs,
	}
}

func extractOrderError(raw interface{}) string {
	root := resultToMap(raw)
	if root == nil {
		return ""
	}
	if errText, ok := root["error"].(string); ok && errText != "" {
		return errText
	}
	if resp, ok := root["response"].(map[string]interface{}); ok {
		if errText, ok := resp["error"].(string); ok && errText != "" {
			return errText
		}
		if data, ok := resp["data"].(map[string]interface{}); ok {
			if statuses, ok := data["statuses"].([]interface{}); ok && len(statuses) > 0 {
				if first, ok := statuses[0].(map[string]interface{}); ok {
					if errText, ok := first["error"].(string); ok && errText != "" {
						return errText
					}
				}
			}
		}
	}
	return ""
}

func extractFilledFromResult(raw interface{}) interface{} {
	root := resultToMap(raw)
	if root == nil {
		return nil
	}
	if f, ok := root["filled"]; ok {
		return f
	}
	if resp, ok := root["response"].(map[string]interface{}); ok {
		if f, ok := resp["filled"]; ok {
			return f
		}
		if data, ok := resp["data"].(map[string]interface{}); ok {
			if statuses, ok := data["statuses"].([]interface{}); ok && len(statuses) > 0 {
				if first, ok := statuses[0].(map[string]interface{}); ok {
					if f, ok := first["filled"]; ok {
						return f
					}
				}
			}
		}
	}
	return nil
}
