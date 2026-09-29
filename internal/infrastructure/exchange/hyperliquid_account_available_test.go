package exchange

import "testing"

func TestAccountAvailableCollateralUsesAccountModeOwner(t *testing.T) {
	perp := map[string]interface{}{"withdrawable": "0.0"}
	spot := map[string]interface{}{
		"balances": []interface{}{
			map[string]interface{}{"coin": "USDC", "total": "13.7", "hold": "0.1"},
		},
		"tokenToAvailableAfterMaintenance": []interface{}{
			[]interface{}{float64(0), "13.62241011"},
		},
	}

	tests := []struct {
		mode string
		want float64
	}{
		{mode: "standard", want: 0},
		{mode: "dexAbstraction", want: 0},
		{mode: "unifiedAccount", want: 13.6},
		{mode: "portfolioMargin", want: 13.6},
	}

	for _, tc := range tests {
		t.Run(tc.mode, func(t *testing.T) {
			got, ok := accountAvailableCollateral(tc.mode, perp, spot)
			if !ok || got != tc.want {
				t.Fatalf("accountAvailableCollateral(%q)=(%v,%v), want (%v,true)", tc.mode, got, ok, tc.want)
			}
		})
	}
}

func TestAccountAvailableCollateralSubtractsUnifiedOrderHolds(t *testing.T) {
	spot := map[string]interface{}{
		"balances": []interface{}{
			map[string]interface{}{"coin": "USDC", "total": "13.62241011", "hold": "4.1814"},
		},
		"tokenToAvailableAfterMaintenance": []interface{}{
			[]interface{}{float64(0), "13.62241011"},
		},
	}
	got, ok := accountAvailableCollateral("unifiedAccount", map[string]interface{}{"withdrawable": "0"}, spot)
	if !ok || got != 9.44101011 {
		t.Fatalf("got (%v,%v), want (9.44101011,true)", got, ok)
	}
}

func TestAccountAvailableCollateralTreatsModeOwnedZeroAsAuthoritative(t *testing.T) {
	spot := map[string]interface{}{
		"balances": []interface{}{
			map[string]interface{}{"coin": "USDC", "total": "0", "hold": "0"},
		},
	}
	got, ok := accountAvailableCollateral("unifiedAccount", nil, spot)
	if !ok || got != 0 {
		t.Fatalf("got (%v,%v), want authoritative zero", got, ok)
	}
}
