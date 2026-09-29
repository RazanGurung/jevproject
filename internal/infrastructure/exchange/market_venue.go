package exchange

import (
	"context"

	"hyperliquid-go/pkg/utils"
)

type marketVenueKind string

const (
	marketVenueStandardPerp marketVenueKind = "standard_perp"
	marketVenueBuilderPerp  marketVenueKind = "builder_perp"
)

type marketVenue struct {
	Kind marketVenueKind
	Dex  string
}

// resolveMarketVenue is the adapter-local view of the process-wide classifier
// in pkg/utils (IsBuilderPerpCoin / GetDexName). Keep these in lockstep.
func resolveMarketVenue(coin string) marketVenue {
	if !utils.IsBuilderPerpCoin(coin) {
		return marketVenue{Kind: marketVenueStandardPerp}
	}
	return marketVenue{Kind: marketVenueBuilderPerp, Dex: utils.GetDexName(coin)}
}

func (v marketVenue) isBuilderPerp() bool {
	return v.Kind == marketVenueBuilderPerp && v.Dex != ""
}

func (h *HyperliquidAdapter) assetIndexForCoin(ctx context.Context, apiURL, coin string) int {
	venue := resolveMarketVenue(coin)
	return h.getAssetIndex(ctx, apiURL, coin, venue.Dex)
}
