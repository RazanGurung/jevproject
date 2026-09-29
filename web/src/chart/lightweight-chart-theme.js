import { colorWithAlpha, getColorPalette, paletteSignature } from '../services/color-palette.js';
import { AppState } from '../state/store.js';

const DEFAULT_CHART_BAR_SPACING = 8;
const DEFAULT_CHART_RIGHT_OFFSET = 5;
const DEFAULT_CHART_MIN_BAR_SPACING = 0.5;
const CHART_OVERVIEW_MIN_BAR_SPACING = 0.001;
const DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR = 1;
const MAX_CHART_CONFLATION_FACTOR = 512;

// Mirrors Lightweight Charts' documented DPR-aware, power-of-two conflation
// rule. The library does not expose the active factor for built-in series, so
// this helper keeps production diagnostics and tests on the same public option
// contract without touching library internals.
function calculateChartConflationFactor(
  barSpacing,
  devicePixelRatio = globalThis?.devicePixelRatio || 1,
  thresholdFactor = DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
) {
  const spacing = Number(barSpacing);
  const dpr = Math.max(1, Number(devicePixelRatio) || 1);
  const smoothing = Math.max(0, Number(thresholdFactor) || 1);
  const threshold = smoothing / dpr;
  if (!(spacing > 0) || spacing >= threshold) return 1;
  const factor = 2 ** Math.floor(Math.log2(threshold / spacing));
  return Math.max(1, Math.min(factor, MAX_CHART_CONFLATION_FACTOR));
}

// Match body/panel floor (--bg-floor). Canvas APIs need a resolved color, so
// prefer the computed body background and fall back to the design mid hex.
function resolveAppFloorColor() {
  try {
    if (typeof document !== 'undefined' && document.body) {
      const resolved = getComputedStyle(document.body).backgroundColor;
      if (resolved && resolved !== 'rgba(0, 0, 0, 0)' && resolved !== 'transparent') {
        return resolved;
      }
    }
  } catch {
    // jsdom / non-DOM hosts
  }
  return '#0a0d11';
}

function buildThemeOptions({ colorType, crosshairMode } = {}) {
  const isClassic = document.body.classList.contains('classic-theme');
  const backgroundColor = resolveAppFloorColor();
  const textColor = isClassic ? '#7d8b9c' : '#555555';
  const gridColor = isClassic ? 'rgba(38, 50, 56, 0.42)' : 'rgba(45, 55, 67, 0.32)';
  const palette = getColorPalette();
  // Pane separators track palette Border with the rest of the shell outlines.
  const paneSeparatorColor = palette.border || (isClassic ? '#1a222c' : '#1e2630');
  const paneSeparatorHoverColor = isClassic ? '#2a3441' : '#2d3743';
  const overlay = AppState?.ui?.candleOverlay || {};
  const overlayActive = overlay.mode && overlay.mode !== 'off';
  const baseMode = overlay.baseCandles || 'dimmed';
  const contrast = typeof overlay.contrast === 'number' && Number.isFinite(overlay.contrast)
    ? Math.max(0.05, Math.min(1.0, overlay.contrast))
    : 0.5;

  let bullColor = colorWithAlpha(palette.bullishCandle, 0.84);
  let bearColor = colorWithAlpha(palette.bearishCandle, 0.84);
  let bullWickColor = colorWithAlpha(palette.bullishCandle, 0.94);
  let bearWickColor = colorWithAlpha(palette.bearishCandle, 0.94);
  let borderVisible = false;
  let bullBorderColor = bullColor;
  let bearBorderColor = bearColor;

  if (overlayActive) {
    if (baseMode === 'hidden') {
      bullColor = 'transparent';
      bearColor = 'transparent';
      bullWickColor = 'transparent';
      bearWickColor = 'transparent';
      bullBorderColor = 'transparent';
      bearBorderColor = 'transparent';
    } else if (baseMode === 'dimmed') {
      const renkoFactor = overlay.mode === 'renko' ? 0.7 : 1.0;
      const effectiveContrast = contrast * renkoFactor;
      bullColor = colorWithAlpha(palette.bullishCandle, effectiveContrast);
      bearColor = colorWithAlpha(palette.bearishCandle, effectiveContrast);
      const wickAlpha = Math.min(1.0, effectiveContrast * 1.25);
      bullWickColor = colorWithAlpha(palette.bullishCandle, wickAlpha);
      bearWickColor = colorWithAlpha(palette.bearishCandle, wickAlpha);
      borderVisible = true;
      bullBorderColor = bullWickColor;
      bearBorderColor = bearWickColor;
    }
  }

  return {
    key: `${isClassic ? 'classic' : 'default'}:${document.body.className}:${paletteSignature()}:${overlayActive ? `${baseMode}:${contrast.toFixed(2)}` : 'off'}`,
    chart: {
      autoSize: true,
      layout: {
        background: { type: colorType.Solid, color: backgroundColor },
        textColor,
        attributionLogo: false,
        fontFamily: 'IBM Plex Mono',
        fontSize: 10,
        panes: {
          enableResize: true,
          separatorColor: paneSeparatorColor,
          separatorHoverColor: paneSeparatorHoverColor,
        },
      },
      grid: {
        vertLines: { visible: false, color: gridColor },
        horzLines: { visible: false, color: gridColor },
      },
      crosshair: {
        mode: crosshairMode.Normal,
        vertLine: { color: 'rgba(74, 85, 104, 0.55)', width: 1, style: 2, labelVisible: true },
        horzLine: { color: 'rgba(74, 85, 104, 0.55)', width: 1, style: 2, labelVisible: true },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.03, bottom: 0.05 },
      },
      timeScale: {
        borderVisible: false,
        rightOffset: DEFAULT_CHART_RIGHT_OFFSET,
        // Keep fixLeftEdge off (library default) so panning back in time does not
        // slam into a wall at the oldest loaded bar; the infinite-history loader
        // (chart-history-loader.js) streams older candles in as the view scrolls
        // into the load zone, matching TradingView's Infinite History pattern.
        fixLeftEdge: false,
        fixRightEdge: false,
        // Keep the live edge visually stable during horizontal scrolling.
        // Preserve the user's time range through responsive resizes. Candle
        // bodies may change width, but the inspected market window does not.
        rightBarStaysOnScroll: true,
        lockVisibleTimeRangeOnResize: true,
        secondsVisible: false,
        timeVisible: true,
        // The fit path temporarily lowers this floor when a dense history needs
        // it. Official conflation then combines only sub-pixel data for display;
        // zooming back in progressively reveals the original OHLC candles.
        minBarSpacing: DEFAULT_CHART_MIN_BAR_SPACING,
        barSpacing: DEFAULT_CHART_BAR_SPACING,
        maxBarSpacing: 25,
        enableConflation: true,
        conflationThresholdFactor: DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
        precomputeConflationOnInit: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    },
    candles: {
      visible: !(overlayActive && baseMode === 'hidden'),
      upColor: bullColor,
      downColor: bearColor,
      borderVisible,
      borderUpColor: bullBorderColor,
      borderDownColor: bearBorderColor,
      wickUpColor: bullWickColor,
      wickDownColor: bearWickColor,
      priceLineVisible: false,
      lastValueVisible: false,
    },
  };
}

function applyThemeIfNeeded({ chart, candleSeries, lastThemeKey, buildTheme }) {
  if (!chart || !candleSeries) {
    return { changed: false, themeKey: lastThemeKey };
  }

  const theme = buildTheme();
  if (theme.key === lastThemeKey) {
    return { changed: false, themeKey: lastThemeKey };
  }

  // Time-scale and navigation options are structural, not palette-dependent.
  // Reapplying timeScale would discard zoom/scroll. Reapplying handleScroll /
  // handleScale would unlock pan/zoom while Draw or AVWAP placement is armed.
  const {
    timeScale: _timeScale,
    handleScroll: _handleScroll,
    handleScale: _handleScale,
    ...visualChartOptions
  } = theme.chart;
  chart.applyOptions(visualChartOptions);
  candleSeries.applyOptions(theme.candles);
  return { changed: true, themeKey: theme.key };
}

export {
  DEFAULT_CHART_BAR_SPACING,
  DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
  DEFAULT_CHART_MIN_BAR_SPACING,
  DEFAULT_CHART_RIGHT_OFFSET,
  CHART_OVERVIEW_MIN_BAR_SPACING,
  applyThemeIfNeeded,
  buildThemeOptions,
  calculateChartConflationFactor,
  resolveAppFloorColor,
};
