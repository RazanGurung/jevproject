/**
 * Text drawing label dialog — text + font size (replaces window.prompt).
 * Returns a Promise that resolves to { text, fontSize } or null on cancel.
 */

export const TEXT_FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32];
export const DEFAULT_TEXT_FONT_SIZE = 14;

let openPromise = null;

function ensureDialog() {
  let root = document.getElementById('drawingTextModal');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'drawingTextModal';
  root.className = 'modal-backdrop drawing-text-modal';
  root.style.display = 'none';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'drawingTextModalTitle');
  root.innerHTML = `
    <div class="modal-card drawing-text-card">
      <div class="modal-head">
        <div class="modal-title" id="drawingTextModalTitle">Text label</div>
        <button type="button" class="modal-close" data-drawing-text="cancel" aria-label="Close">&times;</button>
      </div>
      <form class="modal-form" id="drawingTextForm">
        <div class="modal-field">
          <label class="modal-field-label" for="drawingTextInput">Label</label>
          <input id="drawingTextInput" class="modal-input" type="text" maxlength="200" autocomplete="off" spellcheck="true" placeholder="Enter text…">
        </div>
        <div class="modal-field">
          <label class="modal-field-label" for="drawingTextFontSize">Font size</label>
          <select id="drawingTextFontSize" class="modal-input drawing-text-size-select">
            ${TEXT_FONT_SIZES.map((n) => `<option value="${n}">${n}px</option>`).join('')}
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="modal-cancel" data-drawing-text="cancel">Cancel</button>
          <button type="submit" class="modal-submit" data-drawing-text="ok">Add text</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function finish(result) {
  const root = document.getElementById('drawingTextModal');
  if (root) root.style.display = 'none';
  const resolve = openPromise;
  openPromise = null;
  resolve?.(result);
}

/**
 * @param {{ defaultText?: string, defaultFontSize?: number }} [opts]
 * @returns {Promise<{ text: string, fontSize: number } | null>}
 */
export function promptTextDrawing(opts = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  // One dialog at a time.
  if (openPromise) finish(null);

  const root = ensureDialog();
  const input = root.querySelector('#drawingTextInput');
  const sizeSelect = root.querySelector('#drawingTextFontSize');
  const form = root.querySelector('#drawingTextForm');
  const defaultSize = TEXT_FONT_SIZES.includes(Number(opts.defaultFontSize))
    ? Number(opts.defaultFontSize)
    : DEFAULT_TEXT_FONT_SIZE;

  if (input) input.value = typeof opts.defaultText === 'string' ? opts.defaultText : '';
  if (sizeSelect) sizeSelect.value = String(defaultSize);
  root.style.display = 'flex';

  return new Promise((resolve) => {
    openPromise = resolve;

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
        finish(null);
      }
    };

    const onClick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-drawing-text="cancel"]')) {
        event.preventDefault();
        cleanup();
        finish(null);
        return;
      }
      // Backdrop click cancels.
      if (target === root) {
        cleanup();
        finish(null);
      }
    };

    const onSubmit = (event) => {
      event.preventDefault();
      const text = (input?.value || '').trim();
      if (!text) {
        input?.focus();
        return;
      }
      const fontSize = Number(sizeSelect?.value) || DEFAULT_TEXT_FONT_SIZE;
      cleanup();
      finish({ text, fontSize });
    };

    function cleanup() {
      root.removeEventListener('click', onClick);
      form?.removeEventListener('submit', onSubmit);
      document.removeEventListener('keydown', onKey, true);
    }

    root.addEventListener('click', onClick);
    form?.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => input?.focus(), 0);
  });
}
