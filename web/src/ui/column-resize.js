/**
 * Horizontal column resize for News / Order rails.
 * Book/DOM width is hard-set in styles.css and is not resizable.
 * Updates CSS vars via layout-prefs and persists widths.
 */

import { getColWidths, setColWidth, COL_DEFAULTS, COL_LIMITS } from './layout-prefs.js';

const HANDLES = [
  { id: 'newsResizeHandle', key: 'news', edge: 'right' },
  { id: 'orderResizeHandle', key: 'order', edge: 'left' },
];

function bindHandle({ id, key, edge }) {
  const handle = document.getElementById(id);
  if (!handle || handle.dataset.resizeBound === '1') return;
  handle.dataset.resizeBound = '1';

  let startX = 0;
  let startW = 0;
  let dragging = false;

  const onMove = (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    // Right-edge drag grows with +dx; left-edge drag grows with -dx.
    const next = edge === 'right' ? startW + dx : startW - dx;
    setColWidth(key, next);
    event.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('column-resizing');
    document.body.classList.remove(`resizing-${key}`);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    // Mobile / tablet: columns are not the desktop grid — ignore.
    if (window.matchMedia?.('(max-width: 767px)')?.matches) return;
    dragging = true;
    startX = event.clientX;
    startW = getColWidths()[key] ?? COL_LIMITS[key].min;
    document.body.classList.add('column-resizing');
    document.body.classList.add(`resizing-${key}`);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    event.preventDefault();
  });

  // Double-click restores the default width for that rail.
  handle.addEventListener('dblclick', (event) => {
    if (window.matchMedia?.('(max-width: 767px)')?.matches) return;
    setColWidth(key, COL_DEFAULTS[key]);
    event.preventDefault();
  });
}

export function initColumnResize() {
  HANDLES.forEach(bindHandle);
}
