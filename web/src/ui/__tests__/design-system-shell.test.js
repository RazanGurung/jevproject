import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(import.meta.dirname, '../../..');
const shell = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
const styles = readFileSync(resolve(webRoot, 'styles.css'), 'utf8');

describe('design-system shell', () => {
  it('binds the migrated application chrome and ticket controls to shared classes', () => {
    expect(shell).toContain('data-action="clearMessagesAndDrawings"');
    expect(shell).toContain('id="hideValuesBtn" data-action="toggleHide"');
    expect(shell).toContain('>Hide $</button>');
    expect(shell).toContain('id="settingsToggleBtn"');
    expect(shell).toContain('data-action="toggleSettings"');
    expect(shell).toContain('id="settingsPanel"');
    expect(shell).toContain('id="colorPaletteToggleBtn"');
    expect(shell).toContain('data-action="toggleColorPalette"');
    // Settings sits between Hide $ and Live; Colors lives inside the settings panel.
    expect(shell).toMatch(/id="hideValuesBtn"[\s\S]*id="settingsToggleBtn"[\s\S]*id="statusPill"/);
    expect(shell).toMatch(/id="settingsPanel"[\s\S]*id="colorPaletteToggleBtn"[\s\S]*id="colorPalettePanel"/);
    expect(shell).not.toMatch(/class="panel-controls"[\s\S]*id="colorPaletteToggleBtn"/);
    expect(shell).not.toContain('drawing-clear-btn');
    expect(shell).not.toContain('data-action="clearDrawings"');
    expect(shell).toContain('id="walletBar" class="wallet-bar"');
    expect(shell).toContain('id="connectModal" class="modal-backdrop"');
    expect(shell).toContain('id="bulkTotalDisplay" class="total-chip"');
    expect(shell).toContain('id="botToggleBtn" data-action="botToggle" class="bot-toggle-btn"');
    expect(shell).toContain('id="priceSizeGrid" class="ticket-grid-2"');
    expect(shell).toContain('class="tf-group" role="group" aria-label="Chart timeframe"');
    expect(shell).toContain('id="sizeSlider"');
    expect(shell).toContain('class="field-input slider-input"');
    expect(shell).toContain('id="previewBtn" data-action="previewOrder" class="preview-btn"');
    expect(shell).toContain('id="mobileDock"');
    expect(shell).toContain('data-action="setMobileView"');
    expect(shell).toContain('pez-ultimate');
    expect(shell).toContain('data-action="toggleMoversCollapsed"');
    expect(shell).not.toContain('toggleFocusMode');
    expect(shell).not.toContain('cycleDensity');
    expect(shell).not.toContain('densityToggleBtn');
    expect(shell).toContain('id="newsResizeHandle"');
    expect(shell).not.toContain('fonts.googleapis.com');
    expect(styles).toContain("'IBM Plex Sans'");
    expect(styles).toContain("'IBM Plex Mono'");
  });

  it('keeps inline styles limited to runtime-controlled visibility and bot mode state', () => {
    const inlineStyles = [...shell.matchAll(/\bid="([^"]+)"[^>]*\bstyle="([^"]+)"/g)]
      .map(([, id, style]) => ({ id, style }));

    const allowedVisibilityIds = new Set([
      'coinDropdown', 'candleOverlayPanel', 'indicatorsPanel', 'settingsPanel', 'colorPalettePanel',
      'walletConnected', 'compactBuyBtn', 'compactSellBtn',
      'leverageSliderContainer', 'connectModal', 'modalError', 'scaleGroup',
      'twapGroup', 'twapStatusPanel', 'cancelTwapBtn', 'botGroup',
      'bulkSection', 'previewMarginRow', 'previewLiqRow', 'previewDistRow',
      'drawingTextModal',
    ]);
    const allowedBotModeIds = new Set(['modeSeq', 'modeBulk']);

    for (const { id, style } of inlineStyles) {
      if (allowedVisibilityIds.has(id)) {
        expect(style).toBe('display:none;');
      } else {
        expect(allowedBotModeIds.has(id)).toBe(true);
        expect(style).toMatch(/^background:var\(--(?:green|bg2)\);color:(?:#000|var\(--text2\));$/);
      }
    }
  });

  it('defines every shared class used by the completed migration', () => {
    for (const selector of [
      '.wallet-bar', '.wallet-connected-col', '.modal-backdrop', '.book-stack', '.ticket-grid-2',
      '.total-chip', '.bot-panel-card', '.bot-toggle-btn', '.preview-btn',
      '.mobile-dock', '.status-pill', '.topbar-brand',
      '.col-resize-handle', '.movers-collapsed', '.pez-ultimate',
    ]) {
      expect(styles).toContain(selector);
    }
  });

  it('exposes responsive design tokens for chart protection', () => {
    expect(styles).toContain('--chart-min');
    expect(styles).toContain('--col-news');
    expect(styles).toContain('--mobile-dock-h');
    expect(styles).toContain("var(--sans)");
    expect(styles).toContain('PEZ ULTIMATE');
  });
});
