package exchange

import "testing"

// These cover the USD-notional -> coin-size conversion and wire formatting that
// turn a user's requested dollar amount into the size actually sent to the
// exchange. They are pure functions on the funded order path, so their behavior
// is locked in here rather than relying solely on manual live validation.

func TestRoundNotionalToCoinSizeFloors(t *testing.T) {
	cases := []struct {
		name       string
		usd, price float64
		szDecimals int
		want       float64
	}{
		{"exact", 100, 50, 2, 2.0},
		{"floors_to_szdecimals", 100, 3, 4, 33.3333},
		{"small_size_high_price", 100, 30000, 5, 0.00333},
		{"zero_notional", 0, 50, 2, 0},
		{"zero_price", 100, 0, 2, 0},
		{"negative_notional", -5, 50, 2, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := roundNotionalToCoinSize(tc.usd, tc.price, tc.szDecimals); got != tc.want {
				t.Fatalf("roundNotionalToCoinSize(%v,%v,%d) = %v, want %v", tc.usd, tc.price, tc.szDecimals, got, tc.want)
			}
		})
	}
}

func TestRoundOrderNotionalToCoinSizeMinOpenNotional(t *testing.T) {
	cases := []struct {
		name       string
		usd, price float64
		szDecimals int
		enforce    bool
		want       float64
	}{
		// Requested under $10: never bumped up, just floored.
		{"below_min_not_bumped", 5, 1, 2, true, 5},
		// >= $10 requested but floor lands under $10 notional: round up so the
		// order is not rejected as below the exchange minimum.
		{"bumped_to_meet_min", 11, 3, 0, true, 4},
		// Enforcement disabled (reduce-only style): plain floor even if tiny.
		{"enforce_off_plain_floor", 11, 3, 0, false, 3},
		// Floor already clears $10: returned unchanged.
		{"already_above_min", 100, 3, 0, true, 33},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := roundOrderNotionalToCoinSize(tc.usd, tc.price, tc.szDecimals, tc.enforce); got != tc.want {
				t.Fatalf("roundOrderNotionalToCoinSize(%v,%v,%d,%v) = %v, want %v", tc.usd, tc.price, tc.szDecimals, tc.enforce, got, tc.want)
			}
		})
	}
}

func TestRejectBelowMinOpenNotional(t *testing.T) {
	if err := rejectBelowMinOpenNotional(2, 3, false); err == nil {
		t.Fatal("expected $10 floor to reject a $6 opening size")
	}
	if err := rejectBelowMinOpenNotional(4, 3, false); err != nil {
		t.Fatalf("size already at $10: %v", err)
	}
	if err := rejectBelowMinOpenNotional(0.1, 3, true); err != nil {
		t.Fatalf("reduce-only must pass: %v", err)
	}
}

func TestValidateModifyNotionalProtectsCancelReplace(t *testing.T) {
	tests := []struct {
		name                  string
		size, price           float64
		reduceOnly, isTrigger bool
		wantErr               bool
	}{
		{"opening_below_min_rejected", 0.00018, 55000, false, false, true},
		{"opening_at_min_allowed", 0.0002, 50000, false, false, false},
		{"reduce_only_below_min_allowed", 0.00001, 50000, true, false, false},
		{"trigger_below_min_allowed", 0.00001, 50000, false, true, false},
		{"invalid_zero_rejected", 0, 50000, false, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateModifyNotional(tc.size, tc.price, tc.reduceOnly, tc.isTrigger)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateModifyNotional() error = %v, wantErr %t", err, tc.wantErr)
			}
		})
	}
}

func TestFormatWireSizeTrimsToSzDecimals(t *testing.T) {
	cases := []struct {
		name       string
		size       float64
		szDecimals int
		want       string
	}{
		{"trims_trailing_zeros", 2.0, 2, "2"},
		{"keeps_significant_decimals", 0.00333, 5, "0.00333"},
		{"partial_decimals", 12.5, 1, "12.5"},
		{"whole_coin", 5, 0, "5"},
		{"zero", 0, 2, "0"},
		{"negative_szdecimals_clamped", 7, -1, "7"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatWireSize(tc.size, tc.szDecimals); got != tc.want {
				t.Fatalf("formatWireSize(%v,%d) = %q, want %q", tc.size, tc.szDecimals, got, tc.want)
			}
		})
	}
}
