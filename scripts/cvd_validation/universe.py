"""Perp-universe ticker selection by liquidity tier."""


def fetch_universe(mainnet):
    """Returns [(coin, day_notional_volume)] sorted by volume desc,
    excluding delisted coins."""
    meta, ctxs = mainnet.info({"type": "metaAndAssetCtxs"})
    out = []
    for asset, ctx in zip(meta["universe"], ctxs):
        if asset.get("isDelisted"):
            continue
        try:
            vol = float(ctx.get("dayNtlVlm") or 0)
        except (TypeError, ValueError):
            vol = 0.0
        out.append((asset["name"], vol))
    out.sort(key=lambda x: -x[1])
    return out


def pick_tiers(universe, top=0, mid=0, bottom=0):
    """Top by volume, mid around the median rank, bottom = thinnest coins
    that still trade (nonzero volume)."""
    picked = []
    picked += [c for c, _ in universe[:top]]
    if mid > 0 and len(universe) > mid:
        center = len(universe) // 2
        lo = max(0, center - mid // 2)
        picked += [c for c, _ in universe[lo:lo + mid]]
    if bottom > 0:
        traded = [c for c, v in universe if v > 0]
        picked += traded[-bottom:]
    seen = set()
    return [c for c in picked if not (c in seen or seen.add(c))]
