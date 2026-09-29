/**
 * On-Chart Market Liquidation Clusters
 *
 * Visualizes real-time market-wide liquidations and forced-closure clusters
 * directly on the price chart:
 *   - Long liquidations (forced sell to close): Red level marker
 *   - Short liquidations (forced buy to close): Cyan/Green level marker
 *
 * Groups nearby liquidations into high-conviction reaction zones with
 * aggregated USD notional sizing badges.
 *
 * Rendering uses a lightweight-charts series primitive attached to the candle
 * series in bitmap coordinate space (zero autoscale distortion).
 */

import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';

const DEFAULTS = {
  clusterThresholdPct: 0.002, // Group within 0.2% price tolerance
  maxClusters: 10,
};

export function getLiquidationColors() {
  return {
    short: getPaletteColor('liqShort') || '#22cce6',
    long: getPaletteColor('liqLong') || '#ff5050',
  };
}

const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

export function formatNotionalCompact(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Pure clustering function for market liquidations.
 *
 * @param {Array} liquidations - List of liquidation events
 * @param {string} coin - Filter for active coin
 * @param {Object} options - { clusterThresholdPct, maxClusters }
 * @returns {Array} List of cluster objects:
 *   [{ id, price, side: 'long'|'short', notional, count, latestTime }]
 */
export function computeLiquidationClusters(liquidations, coin, options = {}) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const targetCoin = String(coin || '').toUpperCase();

  const coinEvents = (Array.isArray(liquidations) ? liquidations : [])
    .filter((liq) => {
      const c = String(liq?.coin || '').toUpperCase();
      return c === targetCoin && Number.isFinite(Number(liq?.px)) && Number(liq.px) > 0;
    })
    .map((liq) => {
      const px = Number(liq.px);
      const sz = Number(liq.sz) || 0;
      const notional = px * sz;
      const sideRaw = String(liq.side || '').toUpperCase();
      const isShort = sideRaw === 'B' || sideRaw === 'BUY';
      return {
        px,
        sz,
        notional,
        side: isShort ? 'short' : 'long', // 'short' liq = forced buy; 'long' liq = forced sell
        time: normalizeTimestamp(liq.time),
      };
    })
    .sort((a, b) => b.time - a.time);

  if (coinEvents.length === 0) return [];

  const clusters = [];

  for (const event of coinEvents) {
    let matchedCluster = null;
    for (const cluster of clusters) {
      if (cluster.side === event.side) {
        const diffPct = Math.abs(cluster.price - event.px) / cluster.price;
        if (diffPct <= opts.clusterThresholdPct) {
          matchedCluster = cluster;
          break;
        }
      }
    }

    if (matchedCluster) {
      const totalNotional = matchedCluster.notional + event.notional;
      matchedCluster.price = totalNotional > 0
        ? (matchedCluster.price * matchedCluster.notional + event.px * event.notional) / totalNotional
        : (matchedCluster.price + event.px) / 2;
      matchedCluster.notional = totalNotional;
      matchedCluster.count += 1;
      matchedCluster.latestTime = Math.max(matchedCluster.latestTime, event.time);
    } else {
      clusters.push({
        id: `liq-${event.side}-${event.px.toFixed(2)}-${clusters.length}`,
        price: event.px,
        side: event.side,
        notional: event.notional,
        count: 1,
        latestTime: event.time,
      });
    }
  }

  return clusters.sort((a, b) => b.notional - a.notional).slice(0, opts.maxClusters);
}

/**
 * Creates the lightweight-charts series primitive overlay for On-Chart Liquidation Clusters.
 */
export function createLiquidationClustersOverlay({ getChart, getCandleSeries, options = {} } = {}) {
  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;
  let lastSig = '';

  const state = {
    visible: false,
    clusters: [],
    coin: '',
    colors: getLiquidationColors(),
  };

  function draw(target) {
    if (!attachedChart || !attachedSeries || !state.visible || state.clusters.length === 0) return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = attachedChart.timeScale();
      const visibleRange = ts.getVisibleLogicalRange?.();
      if (!visibleRange) return;

      const xLeft = ts.logicalToCoordinate(visibleRange.from);
      const xRight = ts.logicalToCoordinate(visibleRange.to);
      if (xLeft == null || xRight == null) return;

      for (const cluster of state.clusters) {
        const y = attachedSeries.priceToCoordinate(cluster.price);
        if (y == null) continue;
        if (ctx?.canvas?.height) {
          const canvasH = Number(ctx.canvas.height) / (vpr || 1);
          if (y < -20 || y > canvasH + 20) continue;
        }

        const isShortLiq = cluster.side === 'short';
        const color = isShortLiq ? state.colors.short : state.colors.long;
        const label = `${isShortLiq ? 'Short Liq' : 'Long Liq'} ${formatNotionalCompact(cluster.notional)}`;

        ctx.save();

        // Dashed reference line across visible range
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1, 1 * vpr);
        ctx.setLineDash([3 * hpr, 3 * hpr]);
        ctx.beginPath();
        ctx.moveTo(xLeft * hpr, y * vpr);
        ctx.lineTo(xRight * hpr, y * vpr);
        ctx.stroke();

        // Right-aligned pill badge
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([]);
        ctx.font = `${Math.max(9, Math.round(9 * vpr))}px 'JetBrains Mono', monospace`;
        const textWidth = ctx.measureText(label).width;
        const padX = 4 * hpr;
        const padY = 2 * vpr;
        const badgeW = textWidth + padX * 2;
        const badgeH = 13 * vpr;
        const badgeX = (xRight * hpr) - badgeW - 6 * hpr;
        const badgeY = (y * vpr) - badgeH / 2;

        ctx.fillStyle = colorWithAlpha(color, 0.16);
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 1 * vpr);
        ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

        ctx.fillStyle = color;
        ctx.fillText(label, badgeX + padX, badgeY + badgeH - padY - 1 * vpr);

        ctx.restore();
      }
    });
  }

  const paneView = {
    zOrder: () => 'bottom',
    renderer: () => ({ draw }),
  };

  const primitive = {
    attached(params) { requestUpdate = params?.requestUpdate || null; },
    detached() { requestUpdate = null; },
    updateAllViews() {},
    paneViews: () => [paneView],
  };

  function redraw() {
    if (typeof requestUpdate === 'function') {
      try { requestUpdate(); } catch {}
    }
  }

  function detach() {
    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = null;
    attachedSeries = null;
    requestUpdate = null;
    state.clusters = [];
    lastSig = '';
  }

  function attachIfNeeded() {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series || !state.visible) return false;
    if (attachedChart === chart && attachedSeries === series) return true;

    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = chart;
    attachedSeries = series;
    try {
      series.attachPrimitive(primitive);
      return true;
    } catch {
      attachedChart = null;
      attachedSeries = null;
      return false;
    }
  }

  function setOptions(opts = {}) {
    if (opts.visible !== undefined) {
      state.visible = Boolean(opts.visible);
      if (!state.visible) {
        detach();
        return;
      }
    }
    lastSig = '';
  }

  function updateLiquidations(liquidations = [], coin = '') {
    if (!state.visible) {
      detach();
      return;
    }

    state.coin = coin;
    state.clusters = computeLiquidationClusters(liquidations, coin, options);

    attachIfNeeded();
    redraw();
  }

  function applyTheme() {
    state.colors = getLiquidationColors();
    redraw();
  }

  function getDebugState() {
    return {
      attached: Boolean(attachedChart && attachedSeries),
      visible: state.visible,
      clusterCount: state.clusters.length,
      coin: state.coin,
    };
  }

  return {
    setOptions,
    updateLiquidations,
    applyTheme,
    detach,
    getDebugState,
  };
}
