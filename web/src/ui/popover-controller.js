/**
 * Shared transient-popover controller.
 *
 * Chart tools and market pickers use different content semantics, but they
 * should still agree on the mechanics users feel: one surface open at a time,
 * trigger toggling, outside/Escape/resize dismissal, and truthful
 * aria-expanded state.
 *
 * Open panels are portaled to document.body so overflow/backdrop-filter on
 * topbar/chart headers cannot clip them (critical on mobile).
 */

let current = null;
let dismissHandlersInstalled = false;

function resolveElements(value) {
  if (typeof value === 'function') return Array.from(value() || []);
  if (typeof value === 'string') return Array.from(document.querySelectorAll(value));
  if (value instanceof Element) return [value];
  return Array.from(value || []);
}

/** Mobile dock height — keep popovers clear of the bottom nav. */
function bottomChromeInset() {
  // Avoid a full style/layout flush for every desktop popover open. The dock
  // only participates in narrow layouts, where its exact rendered height is
  // needed to keep menus clear of navigation.
  if (!window.matchMedia?.('(max-width: 720px)').matches) return 0;
  const dock = document.getElementById('mobileDock');
  if (!dock) return 0;
  const style = window.getComputedStyle?.(dock);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return 0;
  return dock.offsetHeight || 0;
}

/**
 * Lift the panel to <body> so fixed positioning is viewport-relative and not
 * clipped by overflow/backdrop-filter ancestors (topbar scroll, panel headers).
 */
function portalPanelToBody(panel) {
  if (!panel || !(panel instanceof Element)) return;
  if (panel.parentElement === document.body) return;
  if (panel.dataset.popoverPortal === '1') return;
  panel._portalParent = panel.parentNode;
  panel._portalNext = panel.nextSibling;
  document.body.appendChild(panel);
  panel.dataset.popoverPortal = '1';
}

function restorePanelFromBody(panel) {
  if (!panel || panel.dataset.popoverPortal !== '1') return;
  const parent = panel._portalParent;
  const next = panel._portalNext;
  if (parent && parent.isConnected) {
    if (next && next.parentNode === parent) parent.insertBefore(panel, next);
    else parent.appendChild(panel);
  }
  delete panel._portalParent;
  delete panel._portalNext;
  delete panel.dataset.popoverPortal;
}

function setTriggerStates(entry, open) {
  for (const trigger of resolveElements(entry.triggers || entry.trigger)) {
    const active = open && trigger === entry.trigger;
    trigger.setAttribute('aria-expanded', active ? 'true' : 'false');
    if (entry.openClass) trigger.classList.toggle(entry.openClass, active);
  }
}

function focusMenuItem(entry, which = 'selected') {
  if (!entry.itemsSelector) return;
  const items = Array.from(entry.panel.querySelectorAll(entry.itemsSelector))
    .filter((el) => !el.disabled && !el.hidden && el.style.display !== 'none');
  if (!items.length) return;
  const selected = items.find((el) => (
    el.getAttribute('aria-checked') === 'true' || el.classList.contains('active')
  ));
  const target = which === 'last' ? items.at(-1) : (selected || items[0]);
  target?.focus();
}

function installDismissHandlers() {
  if (dismissHandlersInstalled) return;
  dismissHandlersInstalled = true;

  document.addEventListener('click', (event) => {
    if (!current) return;
    // Draw (and similar multi-use menus) opt out so the surface stays open
    // while the user places successive objects on the chart.
    if (current.closeOnOutsideClick === false) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (current.panel.contains(target)) return;
    if (resolveElements(current.triggers || current.trigger).some((el) => el.contains(target))) return;
    closePopover();
  });

  document.addEventListener('keydown', (event) => {
    if (!current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // The chart also owns Escape for cancelling an armed drawing. When a
      // popover is open, dismissal consumes this key so one press has one
      // predictable effect.
      event.stopPropagation();
      closePopover(undefined, { restoreFocus: true });
      return;
    }
    if (!current.itemsSelector || !current.panel.contains(event.target)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = Array.from(current.panel.querySelectorAll(current.itemsSelector))
      .filter((el) => !el.disabled && !el.hidden && el.style.display !== 'none');
    if (!items.length) return;
    event.preventDefault();
    const activeIndex = Math.max(0, items.indexOf(document.activeElement));
    let nextIndex = activeIndex;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  });

  window.addEventListener('resize', () => closePopover());
}

export function closePopover(id, { restoreFocus = false } = {}) {
  if (!current || (id && current.id !== id)) return false;
  const closing = current;
  current = null;
  closing.panel.style.display = 'none';
  closing.panel.style.visibility = '';
  closing.panel.dataset.open = 'false';
  setTriggerStates(closing, false);
  restorePanelFromBody(closing.panel);
  closing.onClose?.();
  if (restoreFocus && closing.trigger?.isConnected) closing.trigger.focus();
  return true;
}

export function openPopover(config) {
  const panel = config?.panel;
  const trigger = config?.trigger;
  if (!config?.id || !panel || !trigger) return false;
  installDismissHandlers();
  if (current) closePopover();

  config.beforeOpen?.();
  // Portal before measure/position so fixed coords match the viewport and the
  // panel is not clipped by overflow scrollers or backdrop-filter headers.
  portalPanelToBody(panel);
  current = { ...config, panel, trigger };
  panel.style.visibility = 'hidden';
  panel.style.display = config.display || 'flex';
  panel.dataset.open = 'true';
  setTriggerStates(current, true);
  config.onOpen?.();
  config.position?.(panel, trigger);
  panel.style.visibility = 'visible';
  if (config.focusOnOpen === true) focusMenuItem(current);
  return true;
}

export function togglePopover(config) {
  if (current?.id === config?.id && current?.trigger === config?.trigger) {
    closePopover(config.id);
    return false;
  }
  return openPopover(config);
}

export function isPopoverOpen(id) {
  return current?.id === id;
}

export function getOpenPopoverId() {
  return current?.id || null;
}

export function positionPopover(panel, trigger, { minWidth = 0, scrollable = false } = {}) {
  if (!panel || !trigger) return;
  const margin = 4;
  const gap = 4;
  const bottomInset = bottomChromeInset() + margin;
  panel.style.position = 'fixed';
  panel.style.zIndex = String(5000);
  if (minWidth > 0) panel.style.minWidth = `${minWidth}px`;

  const rect = trigger.getBoundingClientRect();
  const width = Math.max(panel.offsetWidth || 0, minWidth);
  const neededHeight = (scrollable ? panel.scrollHeight : panel.offsetHeight) + 2;
  const spaceBelow = window.innerHeight - rect.bottom - bottomInset - gap;
  const spaceAbove = rect.top - margin - gap;
  const placeBelow = spaceBelow >= neededHeight || spaceBelow >= spaceAbove;
  const viewportHeight = Math.max(80, window.innerHeight - margin - bottomInset);
  const availableHeight = Math.min(
    viewportHeight,
    Math.max(80, placeBelow ? spaceBelow : spaceAbove),
  );

  if (scrollable) panel.style.maxHeight = `${availableHeight}px`;
  const renderedHeight = Math.min(neededHeight, availableHeight);
  const requestedTop = placeBelow
    ? rect.bottom + gap
    : rect.top - gap - renderedHeight;
  panel.style.top = `${Math.round(Math.max(
    margin,
    Math.min(requestedTop, window.innerHeight - renderedHeight - bottomInset),
  ))}px`;
  panel.style.left = `${Math.round(Math.max(
    margin,
    Math.min(rect.left, window.innerWidth - width - margin)
  ))}px`;
}

// Test-only reset keeps module-level state from leaking between jsdom cases.
export function resetPopoverControllerForTests() {
  closePopover();
  current = null;
}
