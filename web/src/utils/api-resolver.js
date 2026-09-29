function readMetaContent(name) {
  if (typeof document === 'undefined') return '';
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBrowserWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function getApiBaseUrl() {
  const browserWindow = getBrowserWindow();
  return trimTrailingSlash(
    browserWindow?.__PEZ_CONFIG__?.apiBaseUrl
    || readMetaContent('pez-api-base')
    || ''
  );
}

function resolveApiUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = getApiBaseUrl();
  if (!base) return url;
  if (url.startsWith('/')) return `${base}${url}`;
  return `${base}/${url}`;
}

function resolveWebSocketUrl(url) {
  const resolved = resolveApiUrl(url);
  if (!resolved) return resolved;
  if (/^wss?:\/\//i.test(resolved)) return resolved;
  if (/^https?:\/\//i.test(resolved)) {
    return resolved.replace(/^http/i, 'ws');
  }
  const browserWindow = getBrowserWindow();
  const protocol = browserWindow?.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = browserWindow?.location?.host || '';
  if (!host) return resolved;
  if (resolved.startsWith('/')) {
    return `${protocol}//${host}${resolved}`;
  }
  return `${protocol}//${host}/${resolved}`;
}

export {
  getApiBaseUrl,
  resolveApiUrl,
  resolveWebSocketUrl,
};
