import { describe, expect, it, vi } from 'vitest';

import { drawChartLoadingState, getChartOverlayState } from '../chart-loading-state.js';

describe('chart loading state', () => {
  it('prefers an explicit loading overlay while candles are empty', () => {
    const overlay = getChartOverlayState({
      candles: [],
      chartSession: { status: 'loading' },
      legacyLoadingFlag: false,
      hasChartLevels: true,
      fallbackNotice: 'No chart data',
    });

    expect(overlay).toEqual({
      chartNotice: '',
      overlayText: 'Loading...',
      shouldShowOverlay: true,
      showLoadingState: true,
    });
  });

  it('shows a notice overlay when candles are empty and a chart notice exists', () => {
    const overlay = getChartOverlayState({
      candles: [],
      chartSession: { status: 'notice', message: 'Chart unavailable' },
      legacyLoadingFlag: false,
      hasChartLevels: true,
      fallbackNotice: '',
    });

    expect(overlay).toEqual({
      chartNotice: 'Chart unavailable',
      overlayText: 'Chart unavailable',
      shouldShowOverlay: true,
      showLoadingState: false,
    });
  });

  it('draws an overlay-only loading badge for lightweight mode', () => {
    const ctx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      font: '',
      textAlign: '',
    };

    drawChartLoadingState(ctx, 800, 400, { overlayOnly: true, text: 'Loading...' });

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 400);
    expect(ctx.fillRect).toHaveBeenCalledWith(356, 186, 88, 24);
    expect(ctx.fillText).toHaveBeenCalledWith('Loading...', 400, 200);
  });
});
