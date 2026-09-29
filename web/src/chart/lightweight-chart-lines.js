function toLabelTextColor(color) {
  if (typeof color !== 'string') return 'rgba(220, 226, 235, 0.82)';
  return color.replace(/,\s*[\d.]+\)$/, ', 0.86)');
}

function lineDashToStyle(lineDash = [], lineStyle) {
  const normalized = Array.isArray(lineDash) ? lineDash.join(',') : '';
  switch (normalized) {
    case '2,2':
      return lineStyle.Dotted;
    case '4,3':
      return lineStyle.Dashed;
    default:
      return lineStyle.Solid;
  }
}

function sameStyleOptions(left = {}, right = {}) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function sameLineConfig(existing, next) {
  if (!existing) return false;
  if (existing.series !== next.series) return false;
  return existing.price === next.price
    && existing.color === next.color
    && sameStyleOptions(existing.styleOptions, next.styleOptions);
}

function createPriceLineController(candleSeriesRef, lineStyle) {
  const orderLineMap = new Map();
  const positionLineMap = new Map();
  const liquidationLineMap = new Map();
  const previewLineMap = new Map();
  const jevLineMap = new Map();
  let livePriceLineEntry = null;

  const lineColors = {
    get bid() { return colorWithAlpha(getPaletteColor('bullish'), 0.64); },
    get ask() { return colorWithAlpha(getPaletteColor('bearish'), 0.64); },
    get tp() { return colorWithAlpha(getPaletteColor('bullish'), 0.66); },
    get sl() { return colorWithAlpha(getPaletteColor('bearish'), 0.66); },
    get long() { return colorWithAlpha(getPaletteColor('bullish'), 0.7); },
    get short() { return colorWithAlpha(getPaletteColor('bearish'), 0.7); },
    liquidation: 'rgba(164, 172, 184, 0.62)',
    livePrice: 'rgba(200, 200, 200, 0.64)',
  };

  function removePriceLine(priceLine, series = candleSeriesRef()) {
    if (!series || !priceLine) return;
    try { series.removePriceLine(priceLine); } catch {}
  }

  function removeLineEntry(entry) {
    if (!entry?.priceLine) return;
    removePriceLine(entry.priceLine, entry.series);
  }

  function clearLineMap(map) {
    for (const entry of map.values()) removeLineEntry(entry);
    map.clear();
  }

  function clearAllPriceLines() {
    clearLineMap(orderLineMap);
    clearLineMap(positionLineMap);
    clearLineMap(liquidationLineMap);
    clearLineMap(previewLineMap);
    clearLineMap(jevLineMap);
    if (livePriceLineEntry) removeLineEntry(livePriceLineEntry);
    livePriceLineEntry = null;
  }

  function syncLineMap(map, items, keyFn, priceFn, colorFn, styleOptions) {
    const candleSeries = candleSeriesRef();
    if (!candleSeries) return;
    const seenKeys = new Set();
    const keyOccurrences = new Map();

    function resolveLineKey(item) {
      const rawKey = keyFn(item);
      if (rawKey == null || rawKey === '') return null;
      const baseKey = String(rawKey);
      const occurrence = keyOccurrences.get(baseKey) || 0;
      keyOccurrences.set(baseKey, occurrence + 1);
      return `${baseKey}#${occurrence}`;
    }

    for (const item of items) {
      const key = resolveLineKey(item);
      if (!key) continue;
      const price = Number(priceFn(item));
      if (!Number.isFinite(price) || price <= 0) continue;
      const color = colorFn(item);
      const resolvedStyleOptions = styleOptions(item);
      const nextConfig = {
        price,
        color,
        styleOptions: resolvedStyleOptions,
        series: candleSeries,
      };
      seenKeys.add(key);

      const existing = map.get(key);
      if (sameLineConfig(existing, nextConfig)) continue;

      if (existing) removeLineEntry(existing);

      const priceLine = candleSeries.createPriceLine({
        price,
        color,
        axisLabelVisible: false,
        title: '',
        axisLabelColor: 'rgba(0, 0, 0, 0)',
        axisLabelTextColor: toLabelTextColor(color),
        ...resolvedStyleOptions,
      });
      map.set(key, { ...nextConfig, priceLine });
    }

    for (const [key, entry] of map) {
      if (!seenKeys.has(key)) {
        removeLineEntry(entry);
        map.delete(key);
      }
    }
  }

  function syncOrderLines(orders = []) {
    syncLineMap(
      orderLineMap,
      orders,
      (o) => String(
        o.oid != null
          ? o.oid
          : `${o.side}:${o.tpsl || ''}:${o.reduceOnly === true ? 'ro' : 'nr'}:${Number(o.price).toFixed(8)}`
      ),
      (o) => o.price,
      (o) => {
        if (o.tpsl === 'tp') return lineColors.tp;
        if (o.tpsl === 'sl') return lineColors.sl;
        return (o.side === 'B' || o.side === 'buy') ? lineColors.bid : lineColors.ask;
      },
      (order) => ({
        lineWidth: order.tpsl ? 2 : 1,
        lineStyle: order.tpsl ? lineStyle.Dotted : lineStyle.Dashed,
        axisLabelVisible: Boolean(order.tpsl),
        title: order.tpsl ? String(order.tpsl).toUpperCase() : '',
      }),
    );
  }

  function syncPositionLines(positions = [], liquidations = []) {
    syncLineMap(
      positionLineMap,
      positions,
      (p) => `${p.side}:${Number(p.price).toFixed(8)}`,
      (p) => p.price,
      (p) => (p.side === 'long') ? lineColors.long : lineColors.short,
      () => ({
        lineWidth: 2,
        lineStyle: lineStyle.Solid,
        axisLabelVisible: false,
        title: '',
      }),
    );
    syncLineMap(
      liquidationLineMap,
      liquidations,
      (l) => `liq:${l.side || ''}:${Number(l.price).toFixed(8)}`,
      (l) => l.price,
      () => lineColors.liquidation,
      () => ({
        lineWidth: 1,
        lineStyle: lineStyle.Dashed,
        // Cross-margin liq prices often sit far outside the visible range
        // (small position vs equity); label the line so it's identifiable
        // when it is in range. The position overlay label always shows the
        // numeric liq price regardless.
        axisLabelVisible: true,
        title: 'LIQ',
      }),
    );
  }

  function syncPreviewLines(previewLevels = []) {
    syncLineMap(
      previewLineMap,
      Array.isArray(previewLevels) ? previewLevels : [],
      (level) => String(level.id || `${level.label || ''}:${level.isBuy ? 'buy' : 'sell'}:${Number(level.price).toFixed(6)}`),
      (level) => level.price,
      (level) => typeof level.isBuy === 'boolean'
        ? (level.isBuy ? lineColors.bid : lineColors.ask)
        : (level.color || lineColors.bid),
      (level) => ({
        lineWidth: Number(level.lineWidth) > 0 ? Number(level.lineWidth) : 1,
        lineStyle: lineDashToStyle(level.lineDash, lineStyle),
        axisLabelVisible: false,
        title: '',
      }),
    );
  }

  function syncLivePriceLine(price, open = price) {
    const candleSeries = candleSeriesRef();
    if (!candleSeries) return;
    const nextPrice = Number(price);
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      if (livePriceLineEntry) {
        removeLineEntry(livePriceLineEntry);
        livePriceLineEntry = null;
      }
      return;
    }

    // If the entry was created on a series that is no longer the active one,
    // applyOptions silently no-ops and the line appears frozen. Drop it so
    // the block below recreates the line on the current series.
    if (livePriceLineEntry && livePriceLineEntry.series !== candleSeries) {
      removeLineEntry(livePriceLineEntry);
      livePriceLineEntry = null;
    }

    const color = lineColors.livePrice;

    if (livePriceLineEntry) {
      // Update in place — avoids destroy/recreate flicker on every price tick
      if (livePriceLineEntry.price !== nextPrice || livePriceLineEntry.color !== color) {
        try {
          livePriceLineEntry.priceLine.applyOptions({
            price: nextPrice,
            color,
            axisLabelTextColor: toLabelTextColor(color),
          });
        } catch {
          // Series was removed — fall through to recreate below
          removeLineEntry(livePriceLineEntry);
          livePriceLineEntry = null;
        }
        if (livePriceLineEntry) {
          livePriceLineEntry.price = nextPrice;
          livePriceLineEntry.color = color;
          livePriceLineEntry.lastTickAt = Date.now();
          return;
        }
      } else {
        return;
      }
    }

    const priceLine = candleSeries.createPriceLine({
      price: nextPrice,
      color,
      lineWidth: 1,
      lineStyle: lineStyle.Dotted,
      axisLabelVisible: true,
      title: '',
      axisLabelColor: 'rgba(0, 0, 0, 0)',
      axisLabelTextColor: toLabelTextColor(color),
    });
    livePriceLineEntry = {
      price: nextPrice,
      color,
      styleOptions: { lineWidth: 1, lineStyle: lineStyle.Dotted, axisLabelVisible: true, title: '' },
      priceLine,
      series: candleSeries,
      createdAt: Date.now(),
      lastTickAt: Date.now(),
    };
  }

  function invalidateLivePriceLine() {
    if (!livePriceLineEntry) return;
    removeLineEntry(livePriceLineEntry);
    livePriceLineEntry = null;
  }

  function getLivePriceLineAgeMs() {
    if (!livePriceLineEntry) return Infinity;
    const stamp = livePriceLineEntry.lastTickAt || livePriceLineEntry.createdAt || 0;
    return Math.max(0, Date.now() - stamp);
  }

  function resetPriceLines() {
    orderLineMap.clear();
    positionLineMap.clear();
    liquidationLineMap.clear();
    previewLineMap.clear();
    jevLineMap.clear();
    livePriceLineEntry = null;
  }

  function syncJevSignalLines(signal) {
    if (!signal || signal.action === 'HOLD' || !signal.action) {
      clearLineMap(jevLineMap);
      return;
    }
    const items = [];
    const bullishColor = colorWithAlpha(getPaletteColor('bullish'), 0.85);
    const bearishColor = colorWithAlpha(getPaletteColor('bearish'), 0.85);

    if (signal.entryPrice > 0) {
      items.push({
        id: 'jev-entry',
        price: signal.entryPrice,
        color: 'rgba(136, 146, 176, 0.85)',
        title: `JEV ENTRY (${signal.action})`,
        lineStyle: lineStyle.Dashed,
      });
    }
    if (signal.takeProfitPrice > 0) {
      const tpPct = signal.takeProfitPct ? ` +${signal.takeProfitPct.toFixed(1)}%` : '';
      items.push({
        id: 'jev-tp',
        price: signal.takeProfitPrice,
        color: bullishColor,
        title: `JEV TP${tpPct}`,
        lineStyle: lineStyle.Dashed,
      });
    }
    if (signal.stopLossPrice > 0) {
      const slPct = signal.stopLossPct ? ` -${signal.stopLossPct.toFixed(1)}%` : '';
      items.push({
        id: 'jev-sl',
        price: signal.stopLossPrice,
        color: bearishColor,
        title: `JEV SL${slPct}`,
        lineStyle: lineStyle.Dashed,
      });
    }

    syncLineMap(
      jevLineMap,
      items,
      (item) => item.id,
      (item) => item.price,
      (item) => item.color,
      (item) => ({
        lineWidth: 1,
        lineStyle: item.lineStyle,
        axisLabelVisible: true,
        title: item.title,
        axisLabelColor: 'rgba(0, 0, 0, 0)',
        axisLabelTextColor: toLabelTextColor(item.color),
      }),
    );
  }

  function getDebugState() {
    return {
      orderLineCount: orderLineMap.size,
      positionLineCount: positionLineMap.size,
      liquidationLineCount: liquidationLineMap.size,
      previewLineCount: previewLineMap.size,
      jevLineCount: jevLineMap.size,
      hasLivePriceLine: Boolean(livePriceLineEntry),
      livePriceLinePrice: livePriceLineEntry?.price ?? null,
    };
  }

  return {
    clearAllPriceLines,
    resetPriceLines,
    syncOrderLines,
    syncPositionLines,
    syncPreviewLines,
    syncLivePriceLine,
    syncJevSignalLines,
    invalidateLivePriceLine,
    getLivePriceLineAgeMs,
    getDebugState,
  };
}

export {
  createPriceLineController,
};
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
