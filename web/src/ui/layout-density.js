/**
 * Layout density — drives the mobile dock (Chart / Book / News / Trade /
 * Account). News and Trade may both stay open; the chart column flexes.
 */

import { AppState } from '../state/store.js';
import { scheduleLayoutRender } from '../render/layout-scheduler.js';

const MOBILE_MQ = '(max-width: 767px)';
const VALID_MOBILE_VIEWS = new Set(['chart', 'book', 'news', 'trade', 'account']);

let densityBound = false;
let resizeTimer = null;

function isMobileViewport() {
  return window.matchMedia?.(MOBILE_MQ)?.matches || window.innerWidth <= 767;
}

function getLayoutEl() {
  return document.getElementById('mainLayout');
}

function getMobileView() {
  const view = String(AppState.ui.mobileView || 'chart');
  return VALID_MOBILE_VIEWS.has(view) ? view : 'chart';
}

function setMobileViewState(view) {
  const next = VALID_MOBILE_VIEWS.has(view) ? view : 'chart';
  AppState.ui.mobileView = next;
  window.mobileView = next;
  return next;
}

function syncMobileDockChrome(view) {
  const active = view || getMobileView();
  document.querySelectorAll('.mobile-dock-btn').forEach((btn) => {
    const on = btn.dataset.arg === active;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/**
 * Apply mobile view attribute. Safe to call often.
 * Does not force-hide News when Trade is open — both panels may show together.
 */
function syncLayoutDensity() {
  const layoutEl = getLayoutEl();
  if (!layoutEl) return;

  const mobile = isMobileViewport();
  // Legacy class no longer used (News+Trade can both stay open).
  layoutEl.classList.remove('layout-dense');
  layoutEl.classList.toggle('is-mobile', mobile);

  const view = getMobileView();
  layoutEl.dataset.mobileView = mobile ? view : '';
  syncMobileDockChrome(view);

  document.body.classList.toggle('mobile-viewport', mobile);
}

function setMobileView(view) {
  const next = setMobileViewState(view);
  syncLayoutDensity();
  scheduleLayoutRender({
    chart: next === 'chart',
    book: next === 'book',
    reason: `mobile:${next}`,
  });
  return next;
}

function initLayoutDensity() {
  if (!AppState.ui.mobileView) {
    setMobileViewState('chart');
  }
  syncLayoutDensity();

  if (densityBound || typeof window === 'undefined') return;
  densityBound = true;

  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      syncLayoutDensity();
      const view = getMobileView();
      scheduleLayoutRender({
        chart: !isMobileViewport() || view === 'chart',
        book: isMobileViewport() && view === 'book',
        reason: 'viewport-resize',
      });
    }, 80);
  };

  window.addEventListener('resize', onResize, { passive: true });
  window.matchMedia?.(MOBILE_MQ)?.addEventListener?.('change', onResize);
}

export {
  initLayoutDensity,
  syncLayoutDensity,
  setMobileView,
  getMobileView,
  isMobileViewport,
  VALID_MOBILE_VIEWS,
};
