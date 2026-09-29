package exchange

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func (h *HyperliquidAdapter) getCachedAccountMode(address string) (string, string, bool) {
	key := strings.ToLower(strings.TrimSpace(address))
	h.accountModeMu.RLock()
	entry, ok := h.accountModeCache[key]
	h.accountModeMu.RUnlock()
	if !ok {
		return "", "", false
	}
	stale := time.Since(entry.time) >= accountModeCacheTTL
	if stale && (entry.mode == "" || entry.mode == "unknown") {
		return "", "", true
	}
	return entry.mode, entry.source, stale
}

func (h *HyperliquidAdapter) getLastKnownAccountMode(address string) (string, bool) {
	key := strings.ToLower(strings.TrimSpace(address))
	h.accountModeMu.RLock()
	entry, ok := h.accountModeCache[key]
	h.accountModeMu.RUnlock()
	if !ok || entry.mode == "" || entry.mode == "unknown" {
		return "", false
	}
	return entry.mode, true
}

func normalizeAccountMode(value interface{}) string {
	raw := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	switch raw {
	case "standard", "disabled", "i", "classic":
		return "standard"
	case "unifiedaccount", "unified_account", "unified", "u":
		return "unifiedAccount"
	case "portfoliomargin", "portfolio_margin", "portfolio", "p":
		return "portfolioMargin"
	case "dexabstraction", "dex_abstraction", "d":
		return "dexAbstraction"
	default:
		return ""
	}
}

func findAccountMode(value interface{}) string {
	switch typed := value.(type) {
	case map[string]interface{}:
		for _, key := range []string{"accountAbstractionMode", "abstraction", "abstractionMode"} {
			if mode := normalizeAccountMode(typed[key]); mode != "" {
				return mode
			}
		}
		if enabled, ok := typed["dexAbstractionEnabled"].(bool); ok {
			if enabled {
				return "dexAbstraction"
			}
			// False only rules out the legacy mode; it does not distinguish
			// Standard, Unified Account, and Portfolio Margin.
			return ""
		}
		for _, child := range typed {
			if mode := findAccountMode(child); mode != "" {
				return mode
			}
		}
	case []interface{}:
		for _, child := range typed {
			if mode := findAccountMode(child); mode != "" {
				return mode
			}
		}
	}
	return ""
}

func (h *HyperliquidAdapter) fetchAccountMode(ctx context.Context, address string) (string, string) {
	var payload map[string]interface{}
	mode := "unknown"
	source := "webData3"
	if err := h.postInfoJSON(ctx, mainnetAPIURL, map[string]interface{}{"type": "webData3", "user": address}, &payload); err == nil {
		if detected := findAccountMode(payload); detected != "" {
			mode = detected
		}
	} else {
		source = "unavailable"
	}
	// Account mode changes rarely, while webData3 can be temporarily throttled.
	// Replacing a previously confirmed Unified/Portfolio mode with "unknown"
	// makes the individual perp withdrawable zero look authoritative and blanks
	// Available. Keep the last confirmed owner until a successful response says
	// otherwise; the refreshed timestamp bounds retry pressure during outages.
	if mode == "unknown" {
		if cached, ok := h.getLastKnownAccountMode(address); ok {
			mode = cached
			source = "cached-stale"
		}
	}
	key := strings.ToLower(strings.TrimSpace(address))
	h.accountModeMu.Lock()
	h.accountModeCache[key] = accountModeEntry{mode: mode, source: source, time: time.Now()}
	h.accountModeMu.Unlock()
	return mode, source
}
