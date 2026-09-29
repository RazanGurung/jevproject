/**
 * Lightweight modal prompt for trading UI. Kept out of trading-service so
 * execution APIs stay headless-testable and presentation-free.
 */

export function asyncPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg2,#1a1a2e);border:1px solid var(--border,#333);border-radius:8px;padding:20px;min-width:280px;color:var(--text1,#eee);font-family:inherit;';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'margin-bottom:12px;font-size:13px;';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = defaultValue;
    input.style.cssText = 'width:100%;padding:8px;background:var(--bg1,#111);border:1px solid var(--border,#444);border-radius:4px;color:var(--text1,#eee);font-size:14px;box-sizing:border-box;margin-bottom:12px;';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:6px 14px;background:transparent;border:1px solid var(--border,#444);border-radius:4px;color:var(--text2,#888);cursor:pointer;';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.cssText = 'padding:6px 14px;background:var(--accent,#3861fb);border:none;border-radius:4px;color:#fff;cursor:pointer;';

    const cleanup = (val) => { overlay.remove(); resolve(val); };
    cancelBtn.onclick = () => cleanup(null);
    okBtn.onclick = () => cleanup(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value);
      if (e.key === 'Escape') cleanup(null);
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cleanup(null); });

    btnRow.append(cancelBtn, okBtn);
    box.append(label, input, btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => input.focus());
  });
}

/** Optional confirm gate (injectable for tests). */
export function confirmAction(message) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  try {
    return window.confirm(message) !== false;
  } catch {
    return true;
  }
}
