package utils

import "testing"

func TestGetDexNameAndBuilderClassification(t *testing.T) {
	t.Parallel()
	cases := []struct {
		coin        string
		dex         string
		builder     bool
		hip3        bool
	}{
		{"BTC", "", false, false},
		{"xyz:GOLD", "xyz", true, true},
		{"XYZ:GOLD", "XYZ", true, true},
		{"vntl:BTC", "vntl", true, false},
		{":broken", "", false, false},
		{"broken:", "", false, false},
		{"  xyz:CL  ", "xyz", true, true},
	}
	for _, tc := range cases {
		if got := GetDexName(tc.coin); got != tc.dex {
			t.Fatalf("GetDexName(%q)=%q want %q", tc.coin, got, tc.dex)
		}
		if got := IsBuilderPerpCoin(tc.coin); got != tc.builder {
			t.Fatalf("IsBuilderPerpCoin(%q)=%v want %v", tc.coin, got, tc.builder)
		}
		if got := IsHip3Coin(tc.coin); got != tc.hip3 {
			t.Fatalf("IsHip3Coin(%q)=%v want %v", tc.coin, got, tc.hip3)
		}
	}
}
