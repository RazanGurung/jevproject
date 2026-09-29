/**
 * Toast - toast and lightweight notification UI
 */

// Options:
//   persist — when true, the toast does not auto-dismiss after 3s; it stays
//   until the user clicks it (or clearToasts() is called). Use for alerts the
//   user shouldn't miss while away from the screen (e.g. CVD alerts).
function showToast(message, isError = false, { persist = false } = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    // Bottom-anchored flex column that grows upward. Capped to the viewport so a
    // run of persistent (un-dismissed) alerts scrolls internally instead of
    // marching off the top of the screen; padding-left leaves room for the
    // scrollbar without clipping the box shadows.
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 40px);overflow-y:auto;overflow-x:hidden;padding-left:8px;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.cssText = `
    background: color-mix(in srgb, ${isError ? 'var(--red2)' : 'var(--accent)'} 18%, transparent);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    color: #d0d6dd;
    padding: 12px 16px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: toastIn 0.2s ease;
    max-width: 300px;
    flex-shrink: 0;
  `;

  container.appendChild(toast);
  // Newest is appended at the bottom; keep it in view when the stack overflows.
  container.scrollTop = container.scrollHeight;

  function dismiss() {
    toast.style.animation = 'toastOut 0.2s ease';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  }

  if (persist) {
    // Stays until clicked. Render the message alongside a ✕ affordance so the
    // dismiss action is discoverable.
    toast.style.cssText += 'cursor:pointer;display:flex;align-items:center;gap:8px;';
    toast.title = 'Click to dismiss';
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('span');
    close.textContent = '✕';
    close.style.cssText = 'font-weight:700;opacity:0.7;';
    toast.append(text, close);
    toast.addEventListener('click', dismiss);
  } else {
    toast.textContent = message;
    setTimeout(dismiss, 3000);
  }
}

function clearToasts() {
  const container = document.getElementById('toast-container');
  if (container) {
    container.innerHTML = '';
  }
}

export {
  showToast,
  clearToasts
};