import { recordUiAction, uiPerformanceEnabled } from '../utils/performance.js';

function parseActionArg(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function buildActionArgs(el) {
  const args = [];
  const keys = ['arg', 'arg2', 'arg3', 'arg4', 'arg5', 'arg6'];
  for (const key of keys) {
    if (el.dataset[key] !== undefined) {
      args.push(parseActionArg(el.dataset[key]));
    }
  }
  if (el.dataset.passValue === 'true') args.push(el.value);
  if (el.dataset.passEl === 'true') args.push(el);
  return args;
}

function invokeNamedAction(actionName, el, actionMap) {
  if (!actionName) return;
  const fn = actionMap[actionName] || window[actionName];
  if (typeof fn !== 'function') {
    console.warn('Unhandled delegated action:', actionName);
    return;
  }
  const startedAt = uiPerformanceEnabled() ? performance.now() : 0;
  try {
    return fn(...buildActionArgs(el));
  } finally {
    if (startedAt) {
      recordUiAction(actionName, startedAt, {
        arg: el?.dataset?.arg || '',
        eventSurface: el?.tagName || '',
      });
    }
  }
}

let delegationReady = false;

export function setupActionDelegation(actionMap) {
  if (delegationReady) return;
  delegationReady = true;

  const handle = (e, attr) => {
    const el = e.target.closest(`[${attr}]`);
    if (!el) return;
    if (el.dataset.preventDefault === 'true') e.preventDefault();
    if (el.dataset.stopPropagation === 'true') e.stopPropagation();
    invokeNamedAction(el.getAttribute(attr), el, actionMap);
  };

  document.addEventListener('click', (e) => handle(e, 'data-action'));
  document.addEventListener('input', (e) => handle(e, 'data-input-action'));
  document.addEventListener('change', (e) => handle(e, 'data-change-action'));
  document.addEventListener('submit', (e) => {
    const el = e.target.closest('[data-submit-action]');
    if (!el) return;
    e.preventDefault();
    invokeNamedAction(el.getAttribute('data-submit-action'), el, actionMap);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    handle(e, 'data-enter-action');
  });
}
