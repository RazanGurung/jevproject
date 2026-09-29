package exchange

import "testing"

func TestResolveMarketVenue(t *testing.T) {
	tests := []struct {
		name            string
		coin            string
		wantKind        marketVenueKind
		wantDex         string
		wantBuilderPerp bool
	}{
		{
			name:            "standard perp",
			coin:            "BTC",
			wantKind:        marketVenueStandardPerp,
			wantDex:         "",
			wantBuilderPerp: false,
		},
		{
			name:            "hip3 builder perp",
			coin:            "xyz:CL",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "xyz",
			wantBuilderPerp: true,
		},
		{
			name:            "non-xyz builder perp",
			coin:            "vntl:BTC",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "vntl",
			wantBuilderPerp: true,
		},
		{
			name:            "hip3 google builder perp",
			coin:            "xyz:GOOGL",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "xyz",
			wantBuilderPerp: true,
		},
		{
			name:            "hip3 amazon builder perp",
			coin:            "xyz:AMZN",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "xyz",
			wantBuilderPerp: true,
		},
		{
			name:            "hip3 apple builder perp",
			coin:            "xyz:AAPL",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "xyz",
			wantBuilderPerp: true,
		},
		{
			name:            "hip3 meta builder perp",
			coin:            "xyz:META",
			wantKind:        marketVenueBuilderPerp,
			wantDex:         "xyz",
			wantBuilderPerp: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveMarketVenue(tt.coin)
			if got.Kind != tt.wantKind {
				t.Fatalf("resolveMarketVenue(%q) kind = %q, want %q", tt.coin, got.Kind, tt.wantKind)
			}
			if got.Dex != tt.wantDex {
				t.Fatalf("resolveMarketVenue(%q) dex = %q, want %q", tt.coin, got.Dex, tt.wantDex)
			}
			if got.isBuilderPerp() != tt.wantBuilderPerp {
				t.Fatalf("resolveMarketVenue(%q) builderPerp = %v, want %v", tt.coin, got.isBuilderPerp(), tt.wantBuilderPerp)
			}
		})
	}
}
