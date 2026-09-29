/**
 * Draggable divider for the bottom positions panel.
 *
 * The desktop layout is a CSS grid whose rows are `minmax(0,1fr)` (chart) and
 * `var(--bottom-panel-h)` (positions panel). Adjusting that one variable grows
 * the panel and shrinks the chart in lockstep; the chart redraws itself via the
 * ResizeObserver behind Lightweight Charts' autoSize. So the drag only has to
 * update --bottom-panel-h, clamped to keep both regions usable.
 */

const STORAGE_KEY = 'pez:bottomPanelH';
const MIN_H = 80;
// Leave room for the chart + headers; cap the panel at most of the viewport.
function maxHeight() {
  return Math.max(MIN_H, Math.round(window.innerHeight * 0.7));
}

function clampHeight(px) {
  return Math.min(maxHeight(), Math.max(MIN_H, Math.round(px)));
}

function applyHeight(px) {
  document.documentElement.style.setProperty('--bottom-panel-h', `${clampHeight(px)}px`);
}

function currentHeight() {
  const panel = document.querySelector('.bottom-panel');
  if (panel) {
    const rect = panel.getBoundingClientRect();
    if (rect.height > 0) return rect.height;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--bottom-panel-h');
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 132;
}

export function initBottomPanelResize() {
  const handle = document.getElementById('bottomResizeHandle');
  if (!handle || handle.dataset.resizeBound === '1') return;
  handle.dataset.resizeBound = '1';

  // Restore a persisted height (ignored by the mobile flex layout).
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(saved) && saved >= MIN_H) {
    applyHeight(saved);
  }

  let startY = 0;
  let startH = 0;
  let dragging = false;

  const onMove = (event) => {
    if (!dragging) return;
    // Dragging the handle up (negative delta) grows the panel.
    const next = startH + (startY - event.clientY);
    applyHeight(next);
    event.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('bottom-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    localStorage.setItem(STORAGE_KEY, String(Math.round(currentHeight())));
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    startY = event.clientY;
    startH = currentHeight();
    document.body.classList.add('bottom-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.preventDefault();
  });

  // Re-clamp if the viewport shrinks below the saved panel height.
  window.addEventListener('resize', () => {
    applyHeight(currentHeight());
  });
}
