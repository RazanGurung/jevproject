// Long enough that a reconnect completing at normal speed (instant first retry
// + initial snapshot, well under a second) never paints the overlay; it only
// appears during a genuine outage.
const RECOVERY_OVERLAY_DELAY_MS = 1500;
const RECOVERY_OVERLAY_MIN_VISIBLE_MS = 350;

let activeRecoveryToken = 0;
let showTimer = null;
let hideTimer = null;
let visibleAt = 0;

function getRecoveryOverlayElement() {
  return document.getElementById('resumeRecoveryOverlay');
}

function setOverlayVisible(visible, message = 'Reconnecting live data...') {
  const overlay = getRecoveryOverlayElement();
  if (!overlay) return;

  const messageEl = overlay.querySelector('[data-role="message"]');
  if (messageEl) {
    messageEl.textContent = message;
  }

  overlay.hidden = !visible;
  overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) {
    visibleAt = Date.now();
  } else {
    visibleAt = 0;
  }
}

function beginRecoveryOverlay(message = 'Reconnecting live data...') {
  activeRecoveryToken += 1;
  const token = activeRecoveryToken;

  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);

  showTimer = setTimeout(() => {
    showTimer = null;
    if (token !== activeRecoveryToken) return;
    setOverlayVisible(true, message);
  }, RECOVERY_OVERLAY_DELAY_MS);

  return token;
}

function finishRecoveryOverlay(token = activeRecoveryToken) {
  if (token !== activeRecoveryToken) return;

  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const overlay = getRecoveryOverlayElement();
  if (!overlay || overlay.hidden) {
    return;
  }

  const elapsed = visibleAt ? Date.now() - visibleAt : RECOVERY_OVERLAY_MIN_VISIBLE_MS;
  const remaining = Math.max(0, RECOVERY_OVERLAY_MIN_VISIBLE_MS - elapsed);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (token !== activeRecoveryToken) return;
    setOverlayVisible(false);
  }, remaining);
}

export {
  beginRecoveryOverlay,
  finishRecoveryOverlay,
};
