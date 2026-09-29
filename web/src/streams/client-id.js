const STREAM_CLIENT_STORAGE_KEY = 'pez_stream_client_id';

let cachedStreamClientId = '';

function createStreamClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pez-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getNavigationType() {
  try {
    const navigationEntries = globalThis.performance?.getEntriesByType?.('navigation');
    const navigationType = navigationEntries?.[0]?.type;
    return typeof navigationType === 'string' ? navigationType : '';
  } catch {
    return '';
  }
}

function getStreamClientId() {
  if (cachedStreamClientId) return cachedStreamClientId;

  let stored = '';
  try {
    stored = window.sessionStorage?.getItem(STREAM_CLIENT_STORAGE_KEY) || '';
  } catch {}

  const navigationType = getNavigationType();
  const shouldReuseStoredId = navigationType === '' || navigationType === 'reload' || navigationType === 'back_forward';

  // Duplicated browser tabs can inherit sessionStorage from the source tab.
  // Reuse the stored id only for reload/back-forward restores; fresh navigations
  // get a new id so each live tab keeps its own backend subscription scope.
  cachedStreamClientId = stored && shouldReuseStoredId
    ? stored
    : createStreamClientId();

  try {
    window.sessionStorage?.setItem(STREAM_CLIENT_STORAGE_KEY, cachedStreamClientId);
  } catch {}

  return cachedStreamClientId;
}

export {
  getStreamClientId,
};
