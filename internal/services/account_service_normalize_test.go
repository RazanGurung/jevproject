package services

import "testing"

func TestNormalizeAccountStateFreeCollateralSemantics(t *testing.T) {
	tests := []struct {
		name  string
		state map[string]interface{}
		want  float64
	}{
		{
			name: "top level authoritative zero",
			state: map[string]interface{}{
				"withdrawable": "0",
				"riskSummary":  map[string]interface{}{"accountValue": "97.08", "withdrawable": "50"},
			},
			want: 0,
		},
		{
			name: "existing available margin",
			state: map[string]interface{}{
				"riskSummary": map[string]interface{}{"accountValue": "100", "availableMargin": "12.5"},
			},
			want: 12.5,
		},
		{
			name: "canonical mode aware margin beats raw perp zero",
			state: map[string]interface{}{
				"withdrawable": "0.0",
				"riskSummary": map[string]interface{}{
					"accountValue": "13.62241000", "availableMargin": "13.62241011",
				},
			},
			want: 13.62241011,
		},
		{
			name: "summary fallback",
			state: map[string]interface{}{
				"crossMarginSummary": map[string]interface{}{"accountValue": "100", "totalMarginUsed": "80"},
			},
			want: 20,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeAccountState(tc.state)
			risk, _ := got["riskSummary"].(map[string]interface{})
			if available := getFloat64(risk, "availableMargin"); available != tc.want {
				t.Fatalf("availableMargin=%v, want %v (risk=%v)", available, tc.want, risk)
			}
			if withdrawable := getFloat64(risk, "withdrawable"); withdrawable != tc.want {
				t.Fatalf("withdrawable=%v, want %v (risk=%v)", withdrawable, tc.want, risk)
			}
		})
	}
}
