#!/usr/bin/env node

import { ensureCdpEndpoint, resolveCdpUrl } from './lib/cdp-browser.mjs';

const APP = process.env.PEZ_URL || 'http://127.0.0.1:5001';
const WEBDRIVER = process.env.PEZ_WEBDRIVER_URL || 'http://127.0.0.1:4444';
// Opera/Chromium CDP is the default smoke transport. Set PEZ_CDP_URL="" to
// use the Safari WebDriver fallback instead. If the default :9222 is down,
// the harness launches Opera (or Chrome) with an isolated profile.
let CDP = resolveCdpUrl();
let cdpLifecycle = { cleanup: async () => {} };
const RENDER_COIN = String(process.env.PEZ_RENDER_COIN || '').trim();
const RENDER_TIMEFRAMES = String(process.env.PEZ_RENDER_TIMEFRAMES || '5m,15m,30m,1h,2h,4h,8h,1d')
  .split(',').map((value) => value.trim()).filter(Boolean);
const RENDER_SOAK_MS = Math.max(0, Number.parseInt(process.env.PEZ_RENDER_SOAK_MS || '0', 10) || 0);
const RENDER_SOAK_TIMEFRAMES = String(process.env.PEZ_RENDER_SOAK_TIMEFRAMES || '5m,30m,2h,1d')
  .split(',').map((value) => value.trim()).filter(Boolean);
const RENDER_SOAK_ALLOW_ENRICHMENT = /^(1|true)$/i.test(process.env.PEZ_RENDER_SOAK_ALLOW_ENRICHMENT || '');
const TIME_RANGE_TOLERANCE_SECONDS = 1;
const failures = [];
const observations = [];
const pageErrors = [];
const failedResponses = [];
const browserConsole = [];
let sessionId = '';
let cdpSocket = null;
let cdpTargetId = '';
let cdpNextId = 1;
const cdpPending = new Map();
const cdpEventWaiters = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpCall(method, params = {}) {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`CDP socket is not open for ${method}`));
  }
  const id = cdpNextId++;
  return new Promise((resolve, reject) => {
    cdpPending.set(id, { resolve, reject, method });
    cdpSocket.send(JSON.stringify({ id, method, params }));
  });
}

function waitForCdpEvent(method, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = cdpEventWaiters.get(method) || [];
      cdpEventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve));
      reject(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const waiters = cdpEventWaiters.get(method) || [];
    waiters.push({
      resolve: (params) => {
        clearTimeout(timer);
        resolve(params);
      },
    });
    cdpEventWaiters.set(method, waiters);
  });
}

async function connectCdp() {
  const response = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`CDP target creation failed (${response.status}): ${await response.text()}`);
  const target = await response.json();
  cdpTargetId = target.id;
  cdpSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpSocket.addEventListener('open', resolve, { once: true });
    cdpSocket.addEventListener('error', reject, { once: true });
  });
  cdpSocket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const pending = cdpPending.get(message.id);
      if (!pending) return;
      cdpPending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      pageErrors.push(String(detail?.exception?.description || detail?.text || 'Runtime exception'));
    }
    if (message.method === 'Network.responseReceived') {
      const responseDetail = message.params?.response;
      if (Number(responseDetail?.status) >= 400) {
        failedResponses.push({ url: responseDetail.url, status: Number(responseDetail.status) });
      }
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const values = (message.params?.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      browserConsole.push({ type: message.params?.type || 'log', text: values });
    }
    const waiters = cdpEventWaiters.get(message.method);
    if (waiters?.length) {
      const waiter = waiters.shift();
      if (!waiters.length) cdpEventWaiters.delete(message.method);
      waiter.resolve(message.params);
    }
  });
  await Promise.all([
    cdpCall('Page.enable'),
    cdpCall('Runtime.enable'),
    cdpCall('Network.enable'),
  ]);
}

async function cdpBrowserOperation(method, path, body) {
  if (method === 'POST' && path === '/session') {
    await connectCdp();
    return { sessionId: 'opera-cdp' };
  }
  if (method === 'POST' && path.endsWith('/window/rect')) {
    try {
      const { windowId } = await cdpCall('Browser.getWindowForTarget', { targetId: cdpTargetId });
      await cdpCall('Browser.setWindowBounds', {
        windowId,
        bounds: { left: body.x, top: body.y, width: body.width, height: body.height, windowState: 'normal' },
      });
    } catch {
      // Ignore if setWindowBounds is unsupported or restricted
    }
    await cdpCall('Emulation.setDeviceMetricsOverride', {
      width: Math.round(body.width),
      height: Math.round(body.height),
      deviceScaleFactor: 1,
      mobile: body.width <= 767,
    }).catch(() => {});
    return { width: body.width, height: body.height, x: body.x, y: body.y };
  }
  if (method === 'POST' && path.endsWith('/url')) {
    const loaded = waitForCdpEvent('Page.loadEventFired');
    const result = await cdpCall('Page.navigate', { url: body.url });
    if (result.errorText) throw new Error(`CDP navigation failed: ${result.errorText}`);
    await loaded;
    return null;
  }
  if (method === 'POST' && path.endsWith('/execute/sync')) {
    const globalObject = await cdpCall('Runtime.evaluate', { expression: 'window', returnByValue: false });
    const result = await cdpCall('Runtime.callFunctionOn', {
      objectId: globalObject.result.objectId,
      functionDeclaration: `function(...args) { ${body.script}\n }`,
      arguments: (body.args || []).map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
    }
    return result.result?.value;
  }
  if (method === 'POST' && path.endsWith('/actions')) {
    for (const source of body.actions || []) {
      const actions = source.actions || [];
      if (source.type === 'wheel') {
        for (const action of actions) {
          if (action.type !== 'scroll') continue;
          await cdpCall('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Number(action.x || 0),
            y: Number(action.y || 0),
            deltaX: Number(action.deltaX || 0),
            deltaY: Number(action.deltaY || 0),
          });
          if (action.duration) await sleep(action.duration);
        }
        continue;
      }
      let x = 0;
      let y = 0;
      let buttons = 0;
      for (const action of actions) {
        if (action.type === 'pointerMove') {
          x = action.x;
          y = action.y;
          await cdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons });
          if (action.duration) await sleep(action.duration);
        }
        if (action.type === 'pointerDown') {
          buttons = 1;
          await cdpCall('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons, clickCount: 1 });
        }
        if (action.type === 'pointerUp') {
          buttons = 0;
          await cdpCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons, clickCount: 1 });
        }
      }
    }
    return null;
  }
  if (method === 'DELETE' && path.endsWith('/actions')) return null;
  if (method === 'GET' && path.endsWith('/screenshot')) {
    return (await cdpCall('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
  }
  if (method === 'DELETE' && path === `/session/${sessionId}`) {
    await cdpCall('Page.close').catch(() => {});
    cdpSocket?.close();
    cdpSocket = null;
    cdpTargetId = '';
    return null;
  }
  throw new Error(`Unsupported CDP browser operation: ${method} ${path}`);
}

async function wd(method, path, body) {
  if (CDP) return cdpBrowserOperation(method, path, body);
  const response = await fetch(`${WEBDRIVER}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { value: text }; }
  if (!response.ok || payload?.value?.error) {
    const detail = payload?.value?.message || payload?.value || text;
    throw new Error(`WebDriver ${method} ${path} failed (${response.status}): ${JSON.stringify(detail)}`);
  }
  return payload?.value;
}

async function execute(script, args = []) {
  return wd('POST', `/session/${sessionId}/execute/sync`, { script, args });
}

async function waitFor(label, predicateScript, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await execute(`return (${predicateScript});`);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(250);
  }
  let debug = null;
  try {
    debug = await execute(`
      const state = window.getChartDebugState?.() || {};
      return {
        currentCoin: state.selection?.coin,
        currentTimeframe: state.selection?.timeframe,
        chartSessionStatus: state.selection?.chartSession?.status,
        lastSeriesMeta: state.lastSeriesMeta,
        exchangeCandleCount: state.exchangeCandleCount,
        indicatorSourceCount: state.indicatorSource?.count,
        cvdRowCount: state.indicators?.cvd?.rowCount,
        lastInitError: state.lastInitError,
        smokeErrors: window.__pezSmokeErrors || [],
      };
    `);
  } catch (error) {
    debug = { captureError: error.message };
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms (last=${JSON.stringify(last)}, debug=${JSON.stringify(debug)})`);
}

function check(condition, label, detail = '') {
  if (condition) {
    observations.push({ label });
    return true;
  }
  failures.push({ label, detail });
  return false;
}

async function debugState() {
  return execute('return window.getChartDebugState ? window.getChartDebugState() : null;');
}

async function waitForStableLoadedCandles(label, timeoutMs = 15000) {
  const startedAt = Date.now();
  let previousKey = '';
  let stableSamples = 0;
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await debugState();
    const key = [
      latest?.exchangeCandleCount || 0,
      latest?.firstExchangeCandle?.t || 0,
      latest?.lastExchangeCandle?.t || 0,
      latest?.indicatorSource?.count || 0,
    ].join(':');
    if (latest?.exchangeCandleCount > 0
      && latest?.lastSeriesMeta?.length === latest?.exchangeCandleCount
      && key === previousKey) {
      stableSamples += 1;
      if (stableSamples >= 4) return latest;
    } else {
      stableSamples = 0;
    }
    previousKey = key;
    await sleep(500);
  }
  throw new Error(`${label} candle history did not settle after ${timeoutMs}ms (last=${JSON.stringify(latest)})`);
}

async function browserSnapshot(label) {
  const snapshot = await execute(`
    const d = window.getChartDebugState ? window.getChartDebugState() : null;
    const wrap = document.getElementById('chartWrap');
    const chart = document.getElementById('uplot-chart');
    return {
      label: arguments[0],
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      coin: d?.selection?.coin,
      timeframe: d?.selection?.timeframe,
      currentPrice: Number(d?.livePriceLinePrice || d?.lastExchangeCandle?.c || 0),
      chartNotice: window.chartNotice || '',
      chartSession: d?.selection?.chartSession || null,
      chartChildren: chart?.childElementCount || 0,
      chartCanvasCount: chart?.querySelectorAll('canvas').length || 0,
      overlayCanvasCount: wrap?.querySelectorAll(':scope > #chartCanvas').length || 0,
      hasChartError: Boolean(chart?.querySelector('.chart-library-error')),
      wrapRect: wrap ? { width: wrap.clientWidth, height: wrap.clientHeight } : null,
      touchToolbarDisplay: getComputedStyle(document.getElementById('chartTouchToolbar')).display,
      domRowCount: document.querySelectorAll('#domLadderList .book-row').length,
      domPrices: Array.from(document.querySelectorAll('#domLadderList .dom-price')).map((node) => Number(node.textContent)),
      hasDomAggregationControl: Boolean(document.getElementById('domAggBtn') || document.getElementById('domAggPanel')),
      debug: d,
    };
  `, [label]);
  observations.push({
    label: `snapshot:${label}`,
    detail: {
      coin: snapshot.coin,
      timeframe: snapshot.timeframe,
      candleCount: snapshot.debug?.exchangeCandleCount,
      chartCreateCount: snapshot.debug?.chartCreateCount,
    },
  });
  return snapshot;
}

function checkCurrentBarVisible(snapshot, label) {
  const lastTime = Number(snapshot?.debug?.lastSeriesMeta?.lastTime || 0);
  const visible = snapshot?.debug?.visibleTimeRange;
  check(
    lastTime > 0
      && Number(visible?.from) <= lastTime
      && Number(visible?.to) >= lastTime,
    `${label} keeps the current bar visible`,
    {
      lastTime,
      visibleTimeRange: visible,
      rightOffset: snapshot?.debug?.timeScaleRightOffset,
    },
  );
}

function checkZoomedOutOverview(snapshot, label) {
  const debug = snapshot?.debug || {};
  const visible = debug.visibleLogicalRange;
  const overview = debug.overviewLogicalRange;
  const conflation = debug.conflation || {};
  const barSpacing = Number(debug.timeScaleBarSpacing);
  const dpr = Math.max(1, Number(conflation.devicePixelRatio) || 1);
  const threshold = (Number(conflation.thresholdFactor) || 1) / dpr;
  const expectedConflationFactor = barSpacing >= threshold
    ? 1
    : Math.max(1, Math.min(2 ** Math.floor(Math.log2(threshold / barSpacing)), 512));
  // Prefer the strict overview-covers-visible diagnostic. For dense short TFs
  // (1m/3m) Lightweight Charts index mapping can leave a small logical offset
  // after multi-series recreates; accept full candle coverage as equivalent.
  const strictOverview = Boolean(
    visible
    && overview
    && debug.overviewCoversLoadedCandles === true
    && Number(debug.visibleLogicalSlotCount) >= Number(debug.exchangeCandleCount)
  );
  const tfOverview = /timeframe \S+/.test(String(label || ''));
  const remappedOverview = Number(visible?.from) < 0
    && Number(visible?.to) >= Number(debug.exchangeCandleCount) - 5
    && Number(debug.visibleLogicalSlotCount) >= Number(debug.exchangeCandleCount) - 2;
  const denseCoverageOk = tfOverview
    && visible
    && (
      remappedOverview
      || (
        Number(debug.visibleLogicalSlotCount) >= Number(debug.exchangeCandleCount) - 2
        && Number(visible?.to) - Number(visible?.from) >= Number(debug.exchangeCandleCount) * 0.98
      )
    );
  check(
    strictOverview || denseCoverageOk,
    `${label} opens on the complete candle overview`,
    {
      visible,
      overview,
      visibleLogicalSlotCount: debug.visibleLogicalSlotCount,
      exchangeCandleCount: debug.exchangeCandleCount,
      overviewCoversLoadedCandles: debug.overviewCoversLoadedCandles,
      denseCoverageOk,
    },
  );
  check(
    conflation.enabled === true
      && Number.isFinite(Number(conflation.factor))
      && Number(conflation.factor) === expectedConflationFactor
      && conflation.active === (expectedConflationFactor > 1)
      && Number.isFinite(Number(conflation.effectiveBarSpacing))
      && Math.abs(
        Number(conflation.effectiveBarSpacing) - barSpacing * expectedConflationFactor
      ) < 1e-9,
    `${label} exposes official dense-candle conflation diagnostics`,
    {
      barSpacing: debug.timeScaleBarSpacing,
      minBarSpacing: debug.timeScaleMinBarSpacing,
      expectedConflationFactor,
      conflation,
    },
  );
}

async function setTimeframe(timeframe) {
  await execute(`
    const tf = arguments[0];
    const button = document.querySelector('[data-action="setTimeframe"][data-arg="' + tf + '"]');
    if (!button) return false;
    button.click();
    return true;
  `, [timeframe]);
  await waitFor(
    `timeframe ${timeframe}`,
    `window.getChartDebugState?.().selection?.timeframe === ${JSON.stringify(timeframe)}
      && window.getChartDebugState?.().lastSeriesMeta?.timeframe === ${JSON.stringify(timeframe)}
      && window.getChartDebugState?.().exchangeCandleCount > 0
      && window.getChartDebugState?.().lastSeriesMeta?.length === window.getChartDebugState?.().exchangeCandleCount
      && (${JSON.stringify(timeframe)} === '1w' || ${JSON.stringify(timeframe)} === '1M'
        || (window.getChartDebugState?.().indicators?.cvd?.rowCount === window.getChartDebugState?.().indicatorSource?.count
          && window.getChartDebugState?.().indicators?.cvdOscillator?.rowCount > 0))
      && window.getChartDebugState?.().selection?.chartSession?.status !== 'loading'`,
    45000,
  );
  let snapshot = await browserSnapshot(`tf:${timeframe}`);
  const shouldHaveCvd = timeframe !== '1w' && timeframe !== '1M';
  if (shouldHaveCvd
    && (snapshot.debug?.indicators?.cvd?.rowCount !== snapshot.debug?.indicatorSource?.count
      || !(snapshot.debug?.indicators?.cvdOscillator?.rowCount > 0))) {
    // A cached-history merge can land between the readiness predicate and the
    // atomic snapshot. Let the already-scheduled indicator render converge,
    // then capture the settled state that the gate actually evaluates.
    await waitFor(
      `timeframe ${timeframe} indicator convergence`,
      `window.getChartDebugState?.().indicators?.cvd?.rowCount
        === window.getChartDebugState?.().indicatorSource?.count
        && window.getChartDebugState?.().indicators?.cvdOscillator?.rowCount > 0`,
      15000,
    );
    snapshot = await browserSnapshot(`tf:${timeframe}:settled`);
  }
  checkCurrentBarVisible(snapshot, `timeframe ${timeframe}`);
  checkZoomedOutOverview(snapshot, `timeframe ${timeframe}`);
  return snapshot;
}

async function switchCoin(coin) {
  await execute('window.switchCoin(arguments[0]); return true;', [coin]);
  await waitFor(
    `coin ${coin}`,
    `window.getChartDebugState?.().selection?.coin === ${JSON.stringify(coin)}
      && window.getChartDebugState?.().lastSeriesMeta?.coin === ${JSON.stringify(coin)}
      && window.getChartDebugState?.().exchangeCandleCount > 0
      && window.getChartDebugState?.().lastSeriesMeta?.length === window.getChartDebugState?.().exchangeCandleCount
      && (window.getChartDebugState?.().selection?.timeframe === '1w'
        || window.getChartDebugState?.().selection?.timeframe === '1M'
        || window.getChartDebugState?.().indicators?.cvd?.rowCount === window.getChartDebugState?.().indicatorSource?.count)
      && window.getChartDebugState?.().selection?.chartSession?.status !== 'loading'`,
    45000,
  );
  const snapshot = await browserSnapshot(`coin:${coin}`);
  checkCurrentBarVisible(snapshot, `coin ${coin}`);
  return snapshot;
}

const renderTimeframeSeconds = Object.freeze({
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800,
  '12h': 43200, '1d': 86400,
});

async function captureRenderedCvd(timeframe) {
  return execute(`
    const timeframe = arguments[0];
    const step = arguments[1];
    const debug = window.getChartDebugState?.({ includeCanonicalCandles: true });
    const bars = Array.isArray(debug?.canonicalCandles) ? [...debug.canonicalCandles] : [];
    const weekS = 7 * 86400;
    const mondayUTC = (t) => Math.floor((t - 4 * 86400) / weekS) * weekS + 4 * 86400;
    const now = Date.now() / 1000;
    const normalized = bars.map((bar) => ({ ...bar, t: Number(bar.t) >= 1e12 ? Math.floor(Number(bar.t) / 1000) : Math.floor(Number(bar.t)) }))
      .filter((bar) => bar.t > 0)
      .filter((bar) => bar.t + step <= now)
      .sort((a, b) => a.t - b.t);
    let week = null;
    let cumulative = 0;
    const rows = [];
    for (const bar of normalized) {
      const nextWeek = mondayUTC(bar.t);
      if (nextWeek !== week) {
        week = nextWeek;
        cumulative = 0;
      }
      const open = Number(bar.o);
      const close = Number(bar.c);
      const volume = Math.max(0, Number(bar.v) || 0);
      const fallback = close > open ? volume : (close < open ? -volume : 0);
      const delta = bar.cvdDelta == null ? fallback : Number(bar.cvdDelta);
      cumulative += delta;
      rows.push({
        time: bar.t,
        close: bar.t + step,
        value: cumulative,
        nil: bar.cvdDelta == null,
        week,
      });
    }
    const latest = rows.at(-1) || null;
    const currentWeek = latest?.week || 0;
    const currentWeekRows = rows.filter((row) => row.week === currentWeek);
    const closedRows = rows.filter((row) => row.week === currentWeek);
    return {
      timeframe,
      capturedAt: Date.now(),
      candleCount: normalized.length,
      expectedLastTime: latest?.time || 0,
      expectedLastValue: latest?.value ?? null,
      completedNilCount: closedRows.filter((row) => row.nil).length,
      expectedResetCount: new Set(rows.map((row) => row.week)).size,
      expectedLastResetTime: currentWeekRows[0]?.time || 0,
      closedRows: closedRows.map(({ close, value }) => ({ close, value })),
      debug,
    };
  `, [timeframe, renderTimeframeSeconds[timeframe]]);
}

function soakCheckpointOffsets() {
  if (!RENDER_SOAK_MS) return [];
  const configured = String(process.env.PEZ_RENDER_SOAK_CHECKPOINTS_MS || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= RENDER_SOAK_MS);
  const defaults = [0, 5 * 60 * 1000, 15 * 60 * 1000, RENDER_SOAK_MS]
    .filter((value) => value <= RENDER_SOAK_MS);
  return [...new Set(configured.length ? [...configured, RENDER_SOAK_MS] : defaults)].sort((a, b) => a - b);
}

async function captureSoakTimeframe(timeframe) {
  await setTimeframe(timeframe);
  return execute(`
    const timeframe = arguments[0];
    const step = arguments[1];
    const debug = window.getChartDebugState?.({ includeCanonicalCandles: true });
    const bars = Array.isArray(debug?.canonicalCandles) ? debug.canonicalCandles : [];
    const weekS = 7 * 86400;
    const mondayUTC = (t) => Math.floor((t - 4 * 86400) / weekS) * weekS + 4 * 86400;
    const now = Date.now() / 1000;
    const normalized = bars.map((bar) => ({
      ...bar,
      t: Number(bar.t) >= 1e12 ? Math.floor(Number(bar.t) / 1000) : Math.floor(Number(bar.t)),
    })).filter((bar) => bar.t > 0).sort((a, b) => a.t - b.t);
    const latestWeek = normalized.length ? mondayUTC(normalized.at(-1).t) : 0;
    let cumulative = 0;
    let expectedRenderedLastTime = 0;
    let expectedRenderedLastValue = null;
    const completedBars = [];
    for (const bar of normalized) {
      if (bar.t + step > now) continue;
      const week = mondayUTC(bar.t);
      if (week !== latestWeek) continue;
      const open = Number(bar.o);
      const close = Number(bar.c);
      const volume = Math.max(0, Number(bar.v) || 0);
      const fallback = close > open ? volume : (close < open ? -volume : 0);
      const delta = bar.cvdDelta == null ? fallback : Number(bar.cvdDelta);
      cumulative += delta;
      expectedRenderedLastTime = bar.t;
      expectedRenderedLastValue = cumulative;
      completedBars.push({
        time: bar.t,
        closeTime: bar.t + step,
        o: open,
        h: Number(bar.h),
        l: Number(bar.l),
        c: close,
        v: volume,
        cvdDelta: bar.cvdDelta == null ? null : Number(bar.cvdDelta),
        anchored: cumulative,
      });
    }
    return {
      timeframe,
      capturedAt: Date.now(),
      completedBars,
      rendered: debug?.indicators?.cvd || null,
      expectedRenderedLastTime,
      expectedRenderedLastValue,
      exchangeCandleCount: debug?.exchangeCandleCount || 0,
      candleSnapshotRevision: debug?.candleSnapshotRevision || 0,
      candleIntegrity: debug?.candleIntegrity || null,
      rejectedUpdateCount: debug?.rejectedUpdateCount || 0,
      updateCount: debug?.updateCount || 0,
      lastSeriesMeta: debug?.lastSeriesMeta || null,
    };
  `, [timeframe, renderTimeframeSeconds[timeframe]]);
}

function diffSoakTimeframe(before, after) {
  const prior = new Map((before?.completedBars || []).map((bar) => [bar.time, bar]));
  const next = new Map((after?.completedBars || []).map((bar) => [bar.time, bar]));
  const changed = [];
  let fallbackEnrichments = 0;
  const enrichmentTimes = [];
  for (const [time, left] of prior) {
    const right = next.get(time);
    if (!right) {
      changed.push({ time, kind: 'removed' });
      continue;
    }
    const fields = ['o', 'h', 'l', 'c', 'v', 'cvdDelta', 'anchored'];
    const differences = Object.fromEntries(fields
      .filter((field) => !Object.is(left[field], right[field]))
      .map((field) => [field, { before: left[field], after: right[field] }]));
    if (!Object.keys(differences).length) continue;
    const enrichmentOnly = left.cvdDelta == null && right.cvdDelta != null
      && !['o', 'h', 'l', 'c', 'v'].some((field) => field in differences);
    if (enrichmentOnly) {
      fallbackEnrichments += 1;
      enrichmentTimes.push(time);
    }
    changed.push({ time, kind: enrichmentOnly ? 'fallback-enriched' : 'mutated', differences });
  }
  for (const change of changed) {
    const fields = Object.keys(change.differences || {});
    if (change.kind === 'mutated' && fields.length === 1 && fields[0] === 'anchored'
      && enrichmentTimes.some((time) => time <= change.time)) {
      change.kind = 'enrichment-propagated';
    }
  }
  return {
    sharedBars: [...prior.keys()].filter((time) => next.has(time)).length,
    addedBars: [...next.keys()].filter((time) => !prior.has(time)).length,
    changedBars: changed,
    fallbackEnrichments,
    completedNilBefore: [...prior.values()].filter((bar) => bar.cvdDelta == null).length,
    completedNilAfter: [...next.values()].filter((bar) => bar.cvdDelta == null).length,
  };
}

async function captureSoakCheckpoint(offsetMs, startedAt) {
  const target = startedAt + offsetMs;
  while (Date.now() < target) await sleep(Math.min(30_000, target - Date.now()));
  const timeframes = {};
  for (const timeframe of RENDER_SOAK_TIMEFRAMES) {
    timeframes[timeframe] = await captureSoakTimeframe(timeframe);
  }
  const health = await fetchJson('/health');
  const metrics = await fetch(`${APP}/metrics`).then((response) => response.text());
  const selectedMetrics = metrics.split('\n').filter((line) => (
    /^pez_(candle_serve_total|upstream_rate_limited_total|market_upstream_subscriptions|market_subscription_shed_total|market_permanent_candle_feed_dropped_total)(\{|\s)/.test(line)
  ));
  return { offsetMs, capturedAt: Date.now(), health: health.value, selectedMetrics, timeframes };
}

async function validateTargetCvdSoak() {
  if (!RENDER_COIN || !RENDER_SOAK_MS) return;
  await switchCoin(RENDER_COIN);
  const checkpoints = [];
  const startedAt = Date.now();
  for (const offsetMs of soakCheckpointOffsets()) {
    const checkpoint = await captureSoakCheckpoint(offsetMs, startedAt);
    checkpoints.push(checkpoint);
    for (const timeframe of RENDER_SOAK_TIMEFRAMES) {
      const capture = checkpoint.timeframes[timeframe];
      const tolerance = Math.max(1e-7, Math.abs(Number(capture.expectedRenderedLastValue || 0)) * 1e-12);
      check(capture.rendered?.lastTime === capture.expectedRenderedLastTime
        && Number.isFinite(capture.rendered?.lastValue)
        && Math.abs(capture.rendered.lastValue - capture.expectedRenderedLastValue) <= tolerance,
      `${RENDER_COIN} ${timeframe} soak render matches canonical candles at ${offsetMs}ms`, {
        rendered: capture.rendered,
        expectedTime: capture.expectedRenderedLastTime,
        expectedValue: capture.expectedRenderedLastValue,
        tolerance,
      });
    }
    observations.push({
      label: `soak:${RENDER_COIN}:${offsetMs}`,
      detail: checkpoint,
    });
  }

  const comparisons = [];
  for (let index = 1; index < checkpoints.length; index += 1) {
    const before = checkpoints[index - 1];
    const after = checkpoints[index];
    for (const timeframe of RENDER_SOAK_TIMEFRAMES) {
      const diff = diffSoakTimeframe(before.timeframes[timeframe], after.timeframes[timeframe]);
      comparisons.push({ fromMs: before.offsetMs, toMs: after.offsetMs, timeframe, ...diff });
      const enrichmentAllowed = RENDER_SOAK_ALLOW_ENRICHMENT && before.offsetMs < 15 * 60 * 1000;
      const disallowed = diff.changedBars.filter((change) => (
        !enrichmentAllowed || !['fallback-enriched', 'enrichment-propagated'].includes(change.kind)
      ));
      check(disallowed.length === 0,
        `${RENDER_COIN} ${timeframe} completed anchored history is stable from ${before.offsetMs}ms to ${after.offsetMs}ms`,
        { diff, disallowed });
    }
  }

  const beforeRehydrate = checkpoints.at(-1);
  await switchCoin('BTC');
  await switchCoin(RENDER_COIN);
  const afterRehydrate = await captureSoakCheckpoint(RENDER_SOAK_MS, Date.now() - RENDER_SOAK_MS);
  const rehydrate = {};
  for (const timeframe of RENDER_SOAK_TIMEFRAMES) {
    rehydrate[timeframe] = diffSoakTimeframe(beforeRehydrate.timeframes[timeframe], afterRehydrate.timeframes[timeframe]);
    const disallowed = rehydrate[timeframe].changedBars;
    check(disallowed.length === 0, `${RENDER_COIN} ${timeframe} completed levels survive BTC round-trip`, {
      diff: rehydrate[timeframe], disallowed,
    });
    check(rehydrate[timeframe].completedNilAfter === 0,
      `${RENDER_COIN} ${timeframe} has no completed fallback buckets after soak`, rehydrate[timeframe]);
  }
  observations.push({
    label: `soak-summary:${RENDER_COIN}`,
    detail: { durationMs: RENDER_SOAK_MS, allowEnrichment: RENDER_SOAK_ALLOW_ENRICHMENT, comparisons, rehydrate },
  });
  await switchCoin('BTC');
  await setTimeframe('2h');
}

function closeValueMap(capture) {
  return new Map((capture?.closedRows || []).map((row) => [Number(row.close), Number(row.value)]));
}

function latestCommonClose(left, right) {
  const leftValues = closeValueMap(left);
  const rightValues = closeValueMap(right);
  const closes = [...leftValues.keys()].filter((close) => rightValues.has(close)).sort((a, b) => b - a);
  if (!closes.length) return null;
  const close = closes[0];
  return { close, left: leftValues.get(close), right: rightValues.get(close) };
}

async function validateTargetCvdRendering() {
  if (!RENDER_COIN) return;
  await switchCoin(RENDER_COIN);
  const passes = [];
  for (const order of [RENDER_TIMEFRAMES, [...RENDER_TIMEFRAMES].reverse()]) {
    const captures = {};
    for (const timeframe of order) {
      await setTimeframe(timeframe);
      const capture = await captureRenderedCvd(timeframe);
      captures[timeframe] = capture;
      const cvd = capture.debug?.indicators?.cvd;
      const tolerance = Math.max(1e-7, Math.abs(Number(capture.expectedLastValue || 0)) * 1e-12);
      check(cvd?.attached === true, `${RENDER_COIN} ${timeframe} rendered CVD is attached`, cvd);
      check(cvd?.rowCount === capture.candleCount, `${RENDER_COIN} ${timeframe} rendered CVD owns every closed candle`, {
        rendered: cvd?.rowCount, closed: capture.candleCount,
      });
      check(cvd?.lastTime === capture.expectedLastTime, `${RENDER_COIN} ${timeframe} rendered CVD tail owns the latest closed timestamp`, {
        rendered: cvd?.lastTime, closed: capture.expectedLastTime,
      });
      check(Number.isFinite(cvd?.lastValue) && Math.abs(cvd.lastValue - capture.expectedLastValue) <= tolerance,
        `${RENDER_COIN} ${timeframe} rendered CVD value matches canonical recomputation`, {
          rendered: cvd?.lastValue, expected: capture.expectedLastValue, tolerance,
        });
      check(cvd?.anchorTimeframe === '1W-MON00' && cvd?.anchorStartTime === 0,
        `${RENDER_COIN} ${timeframe} uses the weekly anchored-CVD contract`, cvd);
      check(cvd?.baselineVisible === true
        && cvd?.resetCount === capture.expectedResetCount
        && cvd?.lastResetTime === capture.expectedLastResetTime,
      `${RENDER_COIN} ${timeframe} plots every weekly reset at zero`, {
        rendered: cvd,
        expectedResetCount: capture.expectedResetCount,
        expectedLastResetTime: capture.expectedLastResetTime,
      });
      check(capture.completedNilCount === 0,
        `${RENDER_COIN} ${timeframe} has no completed fallback buckets in the visible anchor week`, capture.completedNilCount);
    }
    passes.push(captures);
  }

  for (let i = 0; i < RENDER_TIMEFRAMES.length; i += 1) {
    const lowTf = RENDER_TIMEFRAMES[i];
    const lowStep = renderTimeframeSeconds[lowTf];
    const stable = latestCommonClose(passes[0][lowTf], passes[1][lowTf]);
    check(Boolean(stable) && Math.abs(stable.left - stable.right) <= 1e-7,
      `${RENDER_COIN} ${lowTf} closed anchored level survives cache churn`, stable);
    for (let j = i + 1; j < RENDER_TIMEFRAMES.length; j += 1) {
      const highTf = RENDER_TIMEFRAMES[j];
      const highStep = renderTimeframeSeconds[highTf];
      if (!lowStep || !highStep || highStep % lowStep) continue;
      const common = latestCommonClose(passes[1][lowTf], passes[1][highTf]);
      const tolerance = common ? Math.max(1e-7, Math.abs(common.right) * 1e-12) : 0;
      check(Boolean(common) && Math.abs(common.left - common.right) <= tolerance,
        `${RENDER_COIN} ${lowTf}→${highTf} rendered anchored levels agree at a common close`, {
          ...common, tolerance,
        });
    }
  }
}

async function setCheckbox(id, checked) {
  await execute(`
    const input = document.getElementById(arguments[0]);
    input.checked = arguments[1];
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked;
  `, [id, checked]);
}

function derivedIndicatorFingerprint(debug = {}) {
  const indicators = debug.indicators || {};
  const rvwap30d = indicators.vwapBands?.instances?.['30D'] || {};
  return JSON.stringify({
    indicatorSource: debug.indicatorSource,
    rvwapIndicatorSource: debug.rvwapIndicatorSource,
    manualAnchoredVwap: {
      candleCount: indicators.manualAnchoredVwap?.candleCount,
      lastCandleTime: indicators.manualAnchoredVwap?.lastCandleTime,
      anchorCount: indicators.manualAnchoredVwap?.anchorCount,
    },
    monthlyVolumeProfile: {
      profileCount: indicators.monthlyVolumeProfile?.profileCount,
      lastBarTime: indicators.monthlyVolumeProfile?.lastBarTime,
    },
    cvd: {
      rowCount: indicators.cvd?.rowCount,
      lastTime: indicators.cvd?.lastTime,
      lastValue: indicators.cvd?.lastValue,
      resetCount: indicators.cvd?.resetCount,
      lastResetTime: indicators.cvd?.lastResetTime,
    },
    cvdOscillator: {
      rowCount: indicators.cvdOscillator?.rowCount,
      lastTime: indicators.cvdOscillator?.lastTime,
      lastValue: indicators.cvdOscillator?.lastValue,
    },
    rvwap30d: {
      rowCount: rvwap30d.rowCount,
      lastBarTime: rvwap30d.lastBarTime,
      lastCenterTime: rvwap30d.lastCenterTime,
      lastCenterValue: rvwap30d.lastCenterValue,
      centerCount: rvwap30d.centerCount,
      bandCount: rvwap30d.bandCount,
    },
  });
}

async function validateClosedCandleIndicatorStability() {
  await sleep(500);
  let before = await debugState();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const after = await debugState();
    const nativeAdvanced = Number(after.updateCount || 0) > Number(before.updateCount || 0)
      || Number(after.projectedCandleUpdateCount || 0) > Number(before.projectedCandleUpdateCount || 0);
    if (!nativeAdvanced) continue;
    if (after.indicatorSource?.signature !== before.indicatorSource?.signature
      || after.rvwapIndicatorSource?.signature !== before.rvwapIndicatorSource?.signature) {
      before = after; // a real bucket rolled; sample the next same-bucket update
      continue;
    }
    check(
      derivedIndicatorFingerprint(after) === derivedIndicatorFingerprint(before),
      'all derived indicators remain fixed during a forming-candle price update',
      {
        before: JSON.parse(derivedIndicatorFingerprint(before)),
        after: JSON.parse(derivedIndicatorFingerprint(after)),
        nativeUpdates: {
          before: before.updateCount,
          after: after.updateCount,
          projectedBefore: before.projectedCandleUpdateCount,
          projectedAfter: after.projectedCandleUpdateCount,
        },
      },
    );
    return;
  }
  check(false, 'observed a same-bucket native update for closed-candle indicator stability');
}

async function fetchJson(path, options) {
  const response = await fetch(`${APP}${path}`, options);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, headers: Object.fromEntries(response.headers), value };
}

async function dragChart(fromX, toX, fromY, toY = fromY) {
  const steps = 16;
  const pointerActions = [
    { type: 'pointerMove', duration: 0, x: fromX, y: fromY, origin: 'viewport' },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 16, x: fromX + Math.sign(toX - fromX || 1), y: fromY + Math.sign(toY - fromY), origin: 'viewport' },
  ];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    pointerActions.push({
      type: 'pointerMove',
      duration: 20,
      x: Math.round(fromX + (toX - fromX) * t),
      y: Math.round(fromY + (toY - fromY) * t),
      origin: 'viewport',
    });
  }
  pointerActions.push({ type: 'pointerUp', button: 0 });
  await wd('POST', `/session/${sessionId}/actions`, {
    actions: [{
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: pointerActions,
    }],
  });
  await wd('DELETE', `/session/${sessionId}/actions`);
}

async function wheelChart(x, y, deltaY, deltaX = 0) {
  await wd('POST', `/session/${sessionId}/actions`, {
    actions: [{
      type: 'wheel',
      id: 'chart-wheel',
      actions: [{
        type: 'scroll',
        duration: 0,
        x,
        y,
        deltaX,
        deltaY,
        origin: 'viewport',
      }],
    }],
  });
  await wd('DELETE', `/session/${sessionId}/actions`);
  await execute(`
    const x = arguments[0];
    const y = arguments[1];
    const deltaY = arguments[2];
    const deltaX = arguments[3];
    const wrap = document.getElementById('chartWrap');
    const canvas = wrap?.querySelector('canvas');
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      deltaX,
      deltaY,
      deltaMode: 0,
    };
    const event = new WheelEvent('wheel', opts);
    (canvas || wrap)?.dispatchEvent(event);
    return true;
  `, [x, y, deltaY, deltaX]);
}

async function chartPointerTarget() {
  return execute(`
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    const pane0 = Number(window.getChartDebugState?.().paneHeights?.[0] || rect.height);
    const y = rect.top + Math.min(pane0 * 0.42, rect.height * 0.34);
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      x: Math.round(rect.left + rect.width * 0.58),
      y: Math.round(y),
      historyFromX: Math.round(rect.left + rect.width * 0.22),
      historyToX: Math.round(rect.left + rect.width * 0.78),
    };
  `);
}

function logicalSpan(range) {
  return Number(range?.to) - Number(range?.from);
}

async function validateChartZoomAndScroll(label = 'navigation') {
  await waitForStableLoadedCandles(`${label} navigation baseline`, 12000).catch(() => null);
  const before = await debugState();
  const target = await chartPointerTarget();
  const beforeSpan = logicalSpan(before.visibleLogicalRange);
  const beforeSpacing = Number(before.timeScaleBarSpacing);
  const beforeCreate = Number(before.chartCreateCount);
  const beforeSeries = Number(before.seriesRecreateCount);
  const beforeRejected = Number(before.rejectedUpdateCount || 0);
  const beforeCandles = Number(before.exchangeCandleCount || 0);

  for (const deltaY of [-260, -260, -260, -260]) {
    await wheelChart(target.x, target.y, deltaY);
    await sleep(50);
  }
  await waitFor(
    `${label} wheel zoom-in tightens bar spacing`,
    `Number(window.getChartDebugState?.().timeScaleBarSpacing) > ${beforeSpacing + 0.02}
      || (Number(window.getChartDebugState?.().visibleLogicalRange?.to)
        - Number(window.getChartDebugState?.().visibleLogicalRange?.from)) < ${beforeSpan - 1}`,
    12000,
  );
  const zoomedIn = await debugState();
  check(
    Number(zoomedIn.timeScaleBarSpacing) > beforeSpacing + 0.02
      || logicalSpan(zoomedIn.visibleLogicalRange) < beforeSpan - 1,
    `${label} wheel zoom-in shows fewer bars`,
    {
      beforeSpacing,
      afterSpacing: zoomedIn.timeScaleBarSpacing,
      beforeRange: before.visibleLogicalRange,
      afterRange: zoomedIn.visibleLogicalRange,
    },
  );

  // Horizontal pan is asserted after zoom-out. Zoom-in keeps the live bar in
  // view, and timeScale.rightBarStaysOnScroll then holds that window put.
  const priceFrom = Number(zoomedIn.rightPriceScaleVisibleRange?.from);
  await dragChart(target.x, target.x, target.y, target.y + 90);
  await sleep(200);
  let pricePanned = await debugState();
  if (pricePanned.rightPriceScaleAutoScale !== false) {
    await execute(`
      const wrap = document.getElementById('chartWrap');
      const x = arguments[0];
      const y0 = arguments[1];
      const y1 = arguments[2];
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y0, button: 0, buttons: 1 }));
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y1, button: 0, buttons: 1 }));
      wrap.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y1, button: 0, buttons: 0 }));
      return true;
    `, [target.x, target.y, target.y + 110]);
    await sleep(200);
    pricePanned = await debugState();
  }
  const priceMoved = Number.isFinite(priceFrom)
    && Number.isFinite(Number(pricePanned.rightPriceScaleVisibleRange?.from))
    && Math.abs(Number(pricePanned.rightPriceScaleVisibleRange.from) - priceFrom) > 1e-8;
  check(
    priceMoved && pricePanned.rightPriceScaleAutoScale === false,
    `${label} vertical body-drag pans the price scale and leaves auto-scale off`,
    {
      before: zoomedIn.rightPriceScaleVisibleRange,
      after: pricePanned.rightPriceScaleVisibleRange,
      autoScale: pricePanned.rightPriceScaleAutoScale,
    },
  );

  const zoomedSpacing = Number(pricePanned.timeScaleBarSpacing);
  for (const deltaY of [280, 280]) {
    await wheelChart(target.x, target.y, deltaY);
    await sleep(60);
  }
  await waitFor(
    `${label} wheel zoom-out widens bar spacing`,
    `Number(window.getChartDebugState?.().timeScaleBarSpacing) < ${zoomedSpacing - 0.02}`,
    8000,
  );
  const zoomedOut = await debugState();
  check(
    Number(zoomedOut.timeScaleBarSpacing) < zoomedSpacing - 0.02,
    `${label} wheel zoom-out shows more bars`,
    {
      beforeSpacing: zoomedSpacing,
      afterSpacing: zoomedOut.timeScaleBarSpacing,
      afterRange: zoomedOut.visibleLogicalRange,
    },
  );

  const firstBeforeHistory = Number(zoomedOut.firstExchangeCandle?.t || 0);
  const fromBeforeHistory = Number(zoomedOut.visibleLogicalRange?.from);
  const toBeforeHistory = Number(zoomedOut.visibleLogicalRange?.to);
  const scrollBeforeHistory = Number(zoomedOut.timeScaleRightOffset);
  const timeWindowMovedFrom = (debug) => Math.abs(Number(debug?.visibleLogicalRange?.from) - fromBeforeHistory) > 0.4
    || Math.abs(Number(debug?.visibleLogicalRange?.to) - toBeforeHistory) > 0.4
    || (Number.isFinite(scrollBeforeHistory)
      && Number.isFinite(Number(debug?.timeScaleRightOffset))
      && Math.abs(Number(debug.timeScaleRightOffset) - scrollBeforeHistory) > 0.15);
  for (let i = 0; i < 4; i += 1) {
    await dragChart(target.historyFromX, target.historyToX, target.y);
    await sleep(80);
  }
  let scrolled = await debugState();
  if (!timeWindowMovedFrom(scrolled)) {
    for (const deltaX of [420, 420, 420, 420]) {
      await wheelChart(target.x, target.y, 0, deltaX);
      await sleep(60);
    }
    scrolled = await debugState();
  }
  await waitForStableLoadedCandles(`${label} after history pan`, 12000).catch(() => null);
  scrolled = await debugState();
  const timeWindowMoved = timeWindowMovedFrom(scrolled);
  const olderHistoryLoaded = Number(scrolled.firstExchangeCandle?.t) < firstBeforeHistory
    || Number(scrolled.exchangeCandleCount) > Number(zoomedOut.exchangeCandleCount);
  check(
    timeWindowMoved || olderHistoryLoaded,
    `${label} body-drag pans time and can load older history`,
    {
      beforeRange: zoomedOut.visibleLogicalRange,
      afterRange: scrolled.visibleLogicalRange,
      beforeScroll: scrollBeforeHistory,
      afterScroll: scrolled.timeScaleRightOffset,
      beforeHead: firstBeforeHistory,
      afterHead: scrolled.firstExchangeCandle?.t,
      barsBefore: scrolled.barsInfo?.barsBefore,
    },
  );
  check(
    Number(scrolled.exchangeCandleCount) >= beforeCandles,
    `${label} scrollback never drops already-loaded candles`,
    { before: beforeCandles, after: scrolled.exchangeCandleCount },
  );

  await execute(`
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }));
    window.jumpChartToLive();
    return true;
  `);
  await sleep(450);
  await execute('window.jumpChartToLive(); return true;');
  await waitFor(
    `${label} jump-to-live restores the live edge`,
    `(() => {
      const d = window.getChartDebugState?.() || {};
      const last = Number(d.lastSeriesMeta?.lastTime || 0);
      const visible = d.visibleTimeRange;
      const logical = d.visibleLogicalRange;
      const count = Number(d.exchangeCandleCount || 0);
      const lastVisible = last > 0 && Number(visible?.from) <= last && Number(visible?.to) >= last;
      const logicalLive = count > 0 && Number(logical?.to) >= count - 2;
      return lastVisible || logicalLive;
    })()`,
    12000,
  );
  const live = await debugState();
  const lastTime = Number(live.lastSeriesMeta?.lastTime || 0);
  const lastVisible = lastTime > 0
    && Number(live.visibleTimeRange?.from) <= lastTime
    && Number(live.visibleTimeRange?.to) >= lastTime;
  const logicalLive = Number(live.exchangeCandleCount) > 0
    && Number(live.visibleLogicalRange?.to) >= Number(live.exchangeCandleCount) - 2;
  check(
    (lastVisible || logicalLive) && live.rightPriceScaleAutoScale === true,
    `${label} jump-to-live shows the current bar and restores price auto-scale`,
    {
      lastTime,
      visibleTimeRange: live.visibleTimeRange,
      visibleLogicalRange: live.visibleLogicalRange,
      candles: live.exchangeCandleCount,
      autoScale: live.rightPriceScaleAutoScale,
    },
  );

  await execute('window.fitChartView(); return true;');
  await sleep(400);
  await execute('window.fitChartView(); return true;');
  await sleep(250);
  const fitted = await debugState();
  const fittedFrom = Number(fitted.visibleLogicalRange?.from);
  const fittedSlots = Number(fitted.visibleLogicalSlotCount);
  const fittedCandles = Number(fitted.exchangeCandleCount);
  check(
    fitted.overviewCoversLoadedCandles === true
      || fittedFrom <= 2
      || fittedSlots >= fittedCandles - 5
      || fittedSlots > beforeSpan + 20,
    `${label} Fit returns a complete-history overview`,
    {
      visible: fitted.visibleLogicalRange,
      overview: fitted.overviewLogicalRange,
      slots: fittedSlots,
      candles: fittedCandles,
    },
  );
  check(
    fitted.chartCreateCount === beforeCreate
      && fitted.seriesRecreateCount === beforeSeries
      && Number(fitted.rejectedUpdateCount || 0) === beforeRejected,
    `${label} zoom/pan never recreates the chart or rejects series updates`,
    {
      before: { chartCreateCount: beforeCreate, seriesRecreateCount: beforeSeries, rejectedUpdateCount: beforeRejected },
      after: {
        chartCreateCount: fitted.chartCreateCount,
        seriesRecreateCount: fitted.seriesRecreateCount,
        rejectedUpdateCount: fitted.rejectedUpdateCount,
      },
    },
  );
}

function vwapZoomFingerprint(debug = {}) {
  const manual = debug.indicators?.manualAnchoredVwap || {};
  const rolling = debug.indicators?.vwapBands || {};
  const rollingInstances = {};
  for (const lookback of rolling.enabledLookbacks || []) {
    const instance = rolling.instances?.[lookback] || {};
    rollingInstances[lookback] = {
      rowCount: instance.rowCount,
      renderedRowCount: instance.renderedRowCount,
      centerCount: instance.centerCount,
      bandCount: instance.bandCount,
      lastBarTime: instance.lastBarTime,
      lastCenterTime: instance.lastCenterTime,
      lastValues: instance.lastValues,
      dataSetCount: instance.dataSetCount,
      pointUpdateCount: instance.pointUpdateCount,
    };
  }
  return JSON.stringify({
    indicatorSource: debug.indicatorSource,
    rvwapIndicatorSource: debug.rvwapIndicatorSource,
    rvwapSource: {
      coin: debug.rvwapSource?.coin,
      interval: debug.rvwapSource?.interval,
      status: debug.rvwapSource?.status,
      count: debug.rvwapSource?.count,
      firstTime: debug.rvwapSource?.firstTime,
      lastTime: debug.rvwapSource?.lastTime,
    },
    manual: {
      candleCount: manual.candleCount,
      lastCandleTime: manual.lastCandleTime,
      anchorCount: manual.anchorCount,
      dataSetCount: manual.dataSetCount,
      lastRenderSignature: manual.lastRenderSignature,
      latestValuesByAnchor: manual.latestValuesByAnchor,
    },
    rolling: rollingInstances,
  });
}

function vwapValueFingerprint(debug = {}) {
  const manual = debug.indicators?.manualAnchoredVwap || {};
  const rolling = debug.indicators?.vwapBands || {};
  const rollingInstances = {};
  for (const lookback of rolling.enabledLookbacks || []) {
    const instance = rolling.instances?.[lookback] || {};
    rollingInstances[lookback] = {
      lastBarTime: instance.lastBarTime,
      lastCenterTime: instance.lastCenterTime,
      lastValues: instance.lastValues,
    };
  }
  return JSON.stringify({
    rvwapIndicatorTail: debug.rvwapIndicatorSource?.lastTime,
    rvwapSource: debug.rvwapSource,
    manual: {
      lastCandleTime: manual.lastCandleTime,
      anchorCount: manual.anchorCount,
      latestValuesByAnchor: manual.latestValuesByAnchor,
    },
    rolling: rollingInstances,
  });
}

function visibleVwapValues(debug = {}) {
  const visible = debug.visibleTimeRange;
  if (!visible) return [];
  const from = Number(visible.from);
  const to = Number(visible.to);
  const values = [];
  const add = (time, candidates) => {
    const resolvedTime = Number(time);
    if (!(resolvedTime >= from && resolvedTime <= to)) return;
    for (const [key, value] of Object.entries(candidates || {})) {
      if (key === 'time') continue;
      if (!Number.isFinite(value)) continue;
      values.push(Number(value));
    }
  };
  for (const latest of Object.values(
    debug.indicators?.manualAnchoredVwap?.latestValuesByAnchor || {}
  )) {
    if (latest) add(latest.time, latest);
  }
  const rolling = debug.indicators?.vwapBands || {};
  for (const lookback of rolling.enabledLookbacks || []) {
    const instance = rolling.instances?.[lookback];
    if (instance) add(instance.lastCenterTime, instance.lastValues);
  }
  return values;
}

async function validateVwapZoomStability() {
  const before = await debugState();
  const wrap = await execute(`
    const rect = document.getElementById('chartWrap').getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  `);
  const x = Math.round(wrap.left + wrap.width * 0.82);
  const y = Math.round(
    wrap.top + Math.min(Number(before.paneHeights?.[0] || wrap.height) * 0.45, wrap.height * 0.35)
  );
  const beforeSpacing = Number(before.timeScaleBarSpacing);
  const fingerprint = vwapZoomFingerprint(before);

  await wheelChart(x, y, -600);
  await waitFor(
    'real wheel zoom changes chart spacing',
    `Math.abs(Number(window.getChartDebugState?.().timeScaleBarSpacing) - ${beforeSpacing}) > 0.001`,
  );
  await sleep(500);
  const zoomedIn = await debugState();
  check(
    vwapZoomFingerprint(zoomedIn) === fingerprint,
    'real wheel zoom leaves AVWAP/RVWAP sources, timestamps, values, and data calls unchanged',
    {
      before: JSON.parse(fingerprint),
      after: JSON.parse(vwapZoomFingerprint(zoomedIn)),
    },
  );
  check(
    zoomedIn.rightPriceScaleAutoScale === true,
    'price-derived VWAP overlays retain native right-scale autoscaling',
    {
      autoScale: zoomedIn.rightPriceScaleAutoScale,
      range: zoomedIn.rightPriceScaleVisibleRange,
    },
  );
  const values = visibleVwapValues(zoomedIn);
  const priceRange = zoomedIn.rightPriceScaleVisibleRange;
  const rangeLow = Math.min(Number(priceRange?.from), Number(priceRange?.to));
  const rangeHigh = Math.max(Number(priceRange?.from), Number(priceRange?.to));
  check(
    values.length > 0
      && Number.isFinite(rangeLow)
      && Number.isFinite(rangeHigh)
      && values.every((value) => value >= rangeLow - 1e-8 && value <= rangeHigh + 1e-8),
    'visible AVWAP/RVWAP center and band values remain inside the native price scale after zoom',
    { values, priceRange },
  );
  check(
    zoomedIn.chartCreateCount === before.chartCreateCount
      && zoomedIn.seriesRecreateCount === before.seriesRecreateCount
      && zoomedIn.rejectedUpdateCount === before.rejectedUpdateCount,
    'wheel zoom reuses the chart and accepts no data updates',
    {
      before: {
        chartCreateCount: before.chartCreateCount,
        seriesRecreateCount: before.seriesRecreateCount,
        rejectedUpdateCount: before.rejectedUpdateCount,
      },
      after: {
        chartCreateCount: zoomedIn.chartCreateCount,
        seriesRecreateCount: zoomedIn.seriesRecreateCount,
        rejectedUpdateCount: zoomedIn.rejectedUpdateCount,
      },
    },
  );

  const zoomedInSpacing = Number(zoomedIn.timeScaleBarSpacing);
  await wheelChart(x, y, -600);
  await waitFor(
    'a second real wheel zoom changes chart spacing',
    `Math.abs(Number(window.getChartDebugState?.().timeScaleBarSpacing) - ${zoomedInSpacing}) > 0.001`,
  );
  await sleep(500);
  const zoomedFurtherIn = await debugState();
  check(
    vwapZoomFingerprint(zoomedFurtherIn) === fingerprint,
    'AVWAP/RVWAP remain invariant after a further real wheel zoom',
    {
      before: JSON.parse(fingerprint),
      after: JSON.parse(vwapZoomFingerprint(zoomedFurtherIn)),
    },
  );

  const zoomedFurtherInSpacing = Number(zoomedFurtherIn.timeScaleBarSpacing);
  // Reverse one of two inward zoom steps. This exercises zoom-out while staying
  // away from the overview boundary where infinite history legitimately loads.
  await wheelChart(x, y, 200);
  await waitFor(
    'real partial reverse wheel zoom changes chart spacing',
    `Math.abs(Number(window.getChartDebugState?.().timeScaleBarSpacing) - ${zoomedFurtherInSpacing}) > 0.001`,
  );
  await sleep(500);
  const zoomedOut = await debugState();
  check(
    vwapValueFingerprint(zoomedOut) === vwapValueFingerprint(zoomedFurtherIn),
    'AVWAP/RVWAP timestamps and values remain invariant after the reverse wheel zoom',
    {
      before: JSON.parse(vwapValueFingerprint(zoomedFurtherIn)),
      after: JSON.parse(vwapValueFingerprint(zoomedOut)),
    },
  );
}

async function main() {
  if (CDP) {
    cdpLifecycle = await ensureCdpEndpoint(CDP);
    CDP = cdpLifecycle.url;
  }
  let health = await fetchJson('/health');
  for (let attempt = 0; attempt < 5 && !(health.status === 200 && health.value?.status === 'ok'); attempt += 1) {
    await sleep(1000);
    health = await fetchJson('/health');
  }
  check(health.status === 200 && health.value?.status === 'ok', 'backend health is ok', health.value);
  check(health.value?.market_websocket === true, 'backend Hyperliquid WebSocket is connected', health.value);

  const session = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'safari',
        pageLoadStrategy: 'normal',
        'safari:automaticInspection': false,
        'safari:automaticProfiling': false,
      },
    },
  });
  sessionId = session.sessionId;
  await wd('POST', `/session/${sessionId}/window/rect`, { x: 20, y: 20, width: 1440, height: 1000 });
  await wd('POST', `/session/${sessionId}/url`, { url: APP });

  await waitFor(
    'initial chart',
    `document.readyState === 'complete'
      && window.getChartDebugState?.().hasChart === true
      && window.getChartDebugState?.().exchangeCandleCount > 0
      && window.getChartDebugState?.().selection?.chartSession?.status !== 'loading'`,
    60000,
  );
  await waitFor(
    'live DOM ladder',
    `document.querySelectorAll('#domLadderList .book-row').length >= 25`,
    60000,
  );
  await waitFor(
    'default RVWAP startup overlay',
    `window.getChartDebugState?.().indicators?.vwapBands?.attached === true`,
    30000,
  );
  await execute(`
    window.__pezSmokeErrors = [];
    window.addEventListener('error', (event) => window.__pezSmokeErrors.push(String(event.error?.stack || event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__pezSmokeErrors.push(String(event.reason?.stack || event.reason)));
    return true;
  `);

  const baseline = await browserSnapshot('baseline');
  check(baseline.debug?.libraryVersion === '5.2.1', 'Lightweight Charts version is exact-pinned', baseline.debug?.libraryVersion);
  check(baseline.debug?.lastInitError === '', 'chart initialized without fallback/error', baseline.debug?.lastInitError);
  check(baseline.debug?.chartCreateCount === 1, 'one chart instance owns the container', baseline.debug);
  check(baseline.debug?.hasCandleSeries === true, 'native candlestick series exists', baseline.debug);
  check(baseline.debug?.paneCount === 3, 'price, CVD, and oscillator panes are present', baseline.debug?.paneHeights);
  check(baseline.chartChildren > 0 && baseline.chartCanvasCount > 0, 'library rendered real browser canvases', baseline);
  check(baseline.overlayCanvasCount === 1, 'only one strategy compatibility canvas exists', baseline.overlayCanvasCount);
  check(!baseline.hasChartError, 'visible chart-error UI is absent', baseline);
  check(baseline.debug?.hasLivePriceLine === true, 'native live-price line is attached', baseline.debug);
  check(Number(baseline.debug?.livePriceLinePrice) > 0, 'native live-price line exposes its current price', baseline.debug);
  check(baseline.debug?.indicators?.cvd?.attached === true, 'CVD native series is attached', baseline.debug?.indicators);
  check(baseline.debug?.indicators?.cvdOscillator?.attached === true, 'oscillator native series is attached', baseline.debug?.indicators);
  await validateChartZoomAndScroll('baseline BTC 2h');
  check(
    baseline.debug?.indicators?.vwapBands?.attached === true
      && JSON.stringify(baseline.debug.indicators.vwapBands.enabledLookbacks) === JSON.stringify(['30D'])
      && JSON.stringify(baseline.debug.indicators.vwapBands.bandsEnabledLookbacks) === JSON.stringify(['30D'])
      && baseline.debug?.indicators?.monthlyVolumeProfile?.attached === false,
    '30D rolling RVWAP is attached with bands by default (volume profile off)',
    baseline.debug?.indicators,
  );
  const indicatorPanelStructure = await execute(`
    const panel = document.getElementById('indicatorsPanel');
    const debugIndicators = window.getChartDebugState?.().indicators || {};
    return {
      groupLabels: Array.from(panel?.querySelectorAll('.indicator-group-title') || []).map((el) => el.textContent.trim()),
      anchorLabel: panel?.querySelector('label[for="manualAnchoredVwapCheck"]')?.textContent.trim() || '',
      rvwapRows: panel?.querySelectorAll('.rvwap-row').length || 0,
      swatches: panel?.querySelectorAll('.rvwap-swatch').length || 0,
      rvwapChecks: Array.from(panel?.querySelectorAll('[data-change-action="onToggleRvwap"]') || []).map((el) => el.checked),
      rvwapArgs: Array.from(panel?.querySelectorAll('[data-change-action="onToggleRvwap"]') || []).map((el) => el.dataset.arg),
      bandChecks: Array.from(panel?.querySelectorAll('[id^="rvwap"][id$="BandsCheck"]') || []).map((el) => el.checked),
      rvwap365BandsCheck: document.getElementById('rvwap365dBandsCheck'),
      manualAnchorChecked: document.getElementById('manualAnchoredVwapCheck')?.checked,
      manualAnchorBandsCheck: document.getElementById('manualAnchoredVwapBandsCheck'),
      manualAnchorSigmaSelect: document.getElementById('manualAnchoredVwapSigmaSelect'),
      manualAnchorList: document.getElementById('manualAnchoredVwapList'),
      manualAnchorRows: panel?.querySelectorAll('.avwap-row').length || 0,
      monthlyProfileChecked: document.getElementById('monthlyVolumeProfileCheck')?.checked,
      priceProjectionChecked: document.getElementById('priceProjectionCheck')?.checked,
      priceProjectionHistoryCheck: document.getElementById('priceProjectionHistoryCheck'),
      priceProjectionHorizonSelect: document.getElementById('priceProjectionHorizonSelect'),
      priceProjectionStatus: document.getElementById('priceProjectionStatus')?.dataset.status || '',
      indicatorIntervals: window.appState?.connection?.marketSubscription?.indicatorIntervals || [],
      weeklyCheckboxPresent: Boolean(document.getElementById('anchoredVwapCheck')),
      weeklyActionPresent: Boolean(document.querySelector('[data-change-action="onToggleAnchoredVwap"]')),
      weeklyGlobalPresent: typeof window.onToggleAnchoredVwap === 'function',
      weeklyStatePresent: Object.prototype.hasOwnProperty.call(window.appState?.ui || {}, 'anchoredVwapVisible'),
      weeklyDiagnosticPresent: Object.prototype.hasOwnProperty.call(debugIndicators, 'anchoredVwap'),
    };
  `);
  check(
    indicatorPanelStructure.rvwapRows === 4
      && indicatorPanelStructure.swatches === 4
      && indicatorPanelStructure.rvwapChecks.length === 4
      && JSON.stringify(indicatorPanelStructure.rvwapChecks) === JSON.stringify([false, true, false, false])
      && JSON.stringify(indicatorPanelStructure.rvwapArgs) === JSON.stringify(['7D', '30D', '90D', '365D'])
      && indicatorPanelStructure.rvwap365BandsCheck == null
      && indicatorPanelStructure.bandChecks.length === 3
      && JSON.stringify(indicatorPanelStructure.bandChecks) === JSON.stringify([false, true, false])
      && indicatorPanelStructure.manualAnchorChecked === true
      && indicatorPanelStructure.monthlyProfileChecked === false
      && indicatorPanelStructure.manualAnchorRows === 0
      && indicatorPanelStructure.priceProjectionChecked === false
      && indicatorPanelStructure.priceProjectionHistoryCheck == null
      && indicatorPanelStructure.priceProjectionHorizonSelect == null
      && indicatorPanelStructure.priceProjectionStatus === 'disabled'
      && JSON.stringify(indicatorPanelStructure.indicatorIntervals) === JSON.stringify([])
      && indicatorPanelStructure.anchorLabel === 'Anchors'
      && JSON.stringify(indicatorPanelStructure.groupLabels) === JSON.stringify([
        'Anchored VWAP', 'Rolling VWAP', 'Other overlays', 'Price projection',
        '2-week path projection', 'Lower panes', 'Alerts',
      ]),
    'IND panel exposes 7D/30D/90D/365D RVWAPs and indicator controls with 30D default',
    indicatorPanelStructure,
  );
  check(
    indicatorPanelStructure.weeklyCheckboxPresent === false
      && indicatorPanelStructure.weeklyActionPresent === false
      && indicatorPanelStructure.weeklyGlobalPresent === false
      && indicatorPanelStructure.weeklyStatePresent === false
      && indicatorPanelStructure.weeklyDiagnosticPresent === false,
    'retired weekly anchored VWAP has no checkbox, action, state, or diagnostic surface',
    indicatorPanelStructure,
  );
  check(
    baseline.debug?.indicators?.priceProjection?.enabled === false
      && baseline.debug?.indicators?.priceProjection?.status === 'disabled'
      && baseline.debug?.indicators?.priceProjection?.seriesCount === 0,
    'price projection starts disabled without native series',
    baseline.debug?.indicators?.priceProjection,
  );
  await waitForStableLoadedCandles('price projection baseline', 12000).catch(() => null);
  await setCheckbox('priceProjectionCheck', true);
  await waitFor('UTC-month price projection resolved', `
    (() => {
      const pp = window.getChartDebugState?.().indicators?.priceProjection;
      if (!pp || !document.getElementById('priceProjectionStatus')?.dataset.status) return false;
      if (pp.status === 'unavailable') return pp.seriesCount === 0;
      if (pp.status !== 'ready') return false;
      return pp.seriesCount === 0 && Number(pp.occupancySliceCount || 0) > 0;
    })()
  `, 45000);
  const projectionMonth = (await debugState()).indicators.priceProjection;
  const projectionMonthValid = projectionMonth.status === 'ready'
    ? projectionMonth.attached === true
      && projectionMonth.model?.id === 'month-open-map-v1'
      && projectionMonth.evidenceStatus === 'unvalidated'
      && projectionMonth.monthCount >= 1
      && projectionMonth.horizonDays > 0
      && projectionMonth.horizonDays <= 31
      && projectionMonth.horizonBars > 0
      && projectionMonth.analogCount >= 8
      && (projectionMonth.originMode === 'month-open-live'
        || projectionMonth.originMode === 'month-open')
      && projectionMonth.lastProjectionTime > projectionMonth.anchorTime
    : [
      'insufficient-calibration',
      'insufficient-analogues',
      'insufficient-history',
      'no-profile-months',
      'horizon-too-long-for-timeframe',
      'horizon-not-aligned-to-timeframe',
    ].includes(projectionMonth.reason);
  check(
    projectionMonthValid,
    'UTC-month price projection renders profile-month fans or honestly rejects insufficient history',
    projectionMonth,
  );
  await sleep(1200);
  const projectionStable = (await debugState()).indicators.priceProjection;
  check(
    projectionStable.computeCount === projectionMonth.computeCount
      && projectionStable.anchorTime === projectionMonth.anchorTime
      && projectionStable.lastProjectionTime === projectionMonth.lastProjectionTime,
    'price projection does not repaint between confirmed candle closes',
    { before: projectionMonth, after: projectionStable },
  );
  await setCheckbox('priceProjectionCheck', false);
  await waitFor('price projection detach', `
    window.getChartDebugState?.().indicators?.priceProjection?.status === 'disabled'
      && window.getChartDebugState?.().indicators?.priceProjection?.attached === false
      && window.getChartDebugState?.().indicators?.priceProjection?.seriesCount === 0
  `);

  check(
    baseline.debug?.indicators?.weekPathProjection?.enabled === false
      && baseline.debug?.indicators?.weekPathProjection?.status === 'disabled',
    '2-week path projection starts disabled',
    baseline.debug?.indicators?.weekPathProjection,
  );
  await setCheckbox('weekPathProjectionCheck', true);
  await waitFor('2-week path projection resolved', `
    ['ready', 'unavailable'].includes(window.getChartDebugState?.().indicators?.weekPathProjection?.status)
      && document.getElementById('weekPathProjectionStatus')?.dataset.status
  `, 45000);
  const weekPath = (await debugState()).indicators.weekPathProjection;
  const weekPathValid = weekPath.status === 'ready'
    ? weekPath.seriesCount >= 5
      && weekPath.remainingBars > 0
      && weekPath.remainingDays >= 7
      && weekPath.lastProjectionTime > weekPath.anchorTime
      && (weekPath.weekEnd - weekPath.weekStart) === 14 * 24 * 3600
    : weekPath.status === 'unavailable'
      && [
        'insufficient-calibration',
        'insufficient-analogues',
        'insufficient-history',
        'horizon-too-long-for-timeframe',
        'horizon-not-aligned-to-timeframe',
        'unsupported-timeframe',
        'missing-week-open',
      ].includes(weekPath.reason);
  check(
    weekPathValid,
    '2-week path projection renders a multi-week fan or honestly rejects sample limits',
    weekPath,
  );
  await setCheckbox('weekPathProjectionCheck', false);
  await waitFor('2-week path projection detach', `
    window.getChartDebugState?.().indicators?.weekPathProjection?.status === 'disabled'
      || window.getChartDebugState?.().indicators?.weekPathProjection?.enabled === false
  `);

  check(baseline.hasDomAggregationControl === false, 'retired manual DOM multiplier control is absent', baseline);
  const topbarClearStructure = await execute(`
    const clear = document.querySelector('[data-action="clearMessagesAndDrawings"]');
    const hide = document.getElementById('hideValuesBtn');
    return {
      clearLabel: clear?.textContent?.trim() || '',
      clearTitle: clear?.title || '',
      hideLabel: hide?.textContent?.trim() || '',
      hideTitle: hide?.title || '',
      drawingClearPresent: Boolean(document.querySelector('#drawingToolsPanel [data-action="clearDrawings"]')),
    };
  `);
  check(
    topbarClearStructure.clearLabel === 'Clear'
      && topbarClearStructure.clearTitle === 'Clear messages and chart drawings'
      && topbarClearStructure.hideLabel === 'Hide $'
      && topbarClearStructure.hideTitle === 'Hide account dollar values'
      && topbarClearStructure.drawingClearPresent === false,
    'topbar exposes unified Clear and descriptive Hide $ controls',
    topbarClearStructure,
  );
  const privacyToggleState = await execute(`
    const hide = document.getElementById('hideValuesBtn');
    hide.click();
    const hidden = {
      label: hide.textContent.trim(),
      pressed: hide.getAttribute('aria-pressed'),
      title: hide.title,
    };
    hide.click();
    return {
      hidden,
      visible: {
        label: hide.textContent.trim(),
        pressed: hide.getAttribute('aria-pressed'),
        title: hide.title,
      },
    };
  `);
  check(
    privacyToggleState.hidden.label === 'Show $'
      && privacyToggleState.hidden.pressed === 'true'
      && privacyToggleState.hidden.title === 'Show account dollar values'
      && privacyToggleState.visible.label === 'Hide $'
      && privacyToggleState.visible.pressed === 'false'
      && privacyToggleState.visible.title === 'Hide account dollar values',
    'privacy toggle describes Hide $ and Show $ states',
    privacyToggleState,
  );

  const candleOverlayStructure = await execute(`
    const toggleBtn = document.getElementById('candleOverlayToggleBtn');
    const drawBtn = document.getElementById('drawingToggleBtn');
    const panel = document.getElementById('candleOverlayPanel');
    const panelControls = toggleBtn?.parentElement;
    const children = Array.from(panelControls?.children || []);
    const toggleIndex = children.indexOf(toggleBtn);
    const drawIndex = children.indexOf(drawBtn);
    const slider = document.getElementById('candleOverlayContrastSlider');
    const debug = window.getChartDebugState?.()?.candleOverlay || {};
    return {
      toggleExists: Boolean(toggleBtn),
      drawExists: Boolean(drawBtn),
      panelExists: Boolean(panel),
      sliderExists: Boolean(slider),
      isLeftOfDraw: toggleIndex !== -1 && drawIndex !== -1 && toggleIndex === drawIndex - 1,
      toggleText: toggleBtn?.textContent?.trim(),
      defaultMode: debug.mode,
      defaultBaseCandles: debug.baseCandles,
      defaultContrast: debug.contrast,
      defaultAttached: debug.attached,
    };
  `);
  check(
    candleOverlayStructure.toggleExists
      && candleOverlayStructure.drawExists
      && candleOverlayStructure.panelExists
      && candleOverlayStructure.sliderExists
      && candleOverlayStructure.isLeftOfDraw
      && ['off', 'renko'].includes(candleOverlayStructure.defaultMode)
      && typeof candleOverlayStructure.defaultContrast === 'number'
      && typeof candleOverlayStructure.defaultAttached === 'boolean',
    'candle overlay toggle is placed to the left of draw dropdown, starts off or with default overlay, and includes contrast control',
    candleOverlayStructure,
  );

  // Exercise candle overlay modes: toggle panel, switch to Heikin Ashi, Renko, then Off
  await execute(`
    const btn = document.getElementById('candleOverlayToggleBtn');
    btn?.click();
    return true;
  `);
  await waitFor('candle overlay panel open', `document.getElementById('candleOverlayPanel')?.dataset.open === 'true' || document.getElementById('candleOverlayToggleBtn')?.getAttribute('aria-expanded') === 'true'`);
  const panelOpen = await execute(`
    const panel = document.getElementById('candleOverlayPanel');
    const btn = document.getElementById('candleOverlayToggleBtn');
    return panel?.dataset.open === 'true' || btn?.getAttribute('aria-expanded') === 'true';
  `);
  check(panelOpen, 'candle overlay popover opens on toggle');

  await execute(`
    const haChip = document.querySelector('[data-action="selectCandleOverlayMode"][data-arg="heikin-ashi"]');
    if (haChip) haChip.click();
    else window.selectCandleOverlayMode?.('heikin-ashi');
    return true;
  `);
  await waitFor('heikin-ashi overlay attached', `window.getChartDebugState?.()?.candleOverlay?.mode === 'heikin-ashi' && (window.getChartDebugState?.()?.candleOverlay?.haCount || 0) > 0`);
  const haDebug = (await debugState())?.candleOverlay || {};
  check(
    haDebug.mode === 'heikin-ashi' && haDebug.baseCandles === 'dimmed' && haDebug.attached === true && haDebug.haCount > 0,
    'heikin-ashi overlay activates with dimmed base candles and attaches primitive to chart',
    haDebug,
  );

  await execute(`
    const renkoChip = document.querySelector('[data-action="selectCandleOverlayMode"][data-arg="renko"]');
    if (renkoChip) renkoChip.click();
    else window.selectCandleOverlayMode?.('renko');
    return true;
  `);
  await waitFor('renko overlay attached', `window.getChartDebugState?.()?.candleOverlay?.mode === 'renko' && (window.getChartDebugState?.()?.candleOverlay?.renkoBrickCount || 0) > 0`);
  const renkoDebug = (await debugState())?.candleOverlay || {};
  check(
    renkoDebug.mode === 'renko' && renkoDebug.baseCandles === 'dimmed' && renkoDebug.attached === true && renkoDebug.renkoBrickCount > 0,
    'renko overlay activates with dimmed base candles and attaches primitive to chart',
    renkoDebug,
  );

  await execute(`
    const bothChip = document.querySelector('[data-action="selectCandleOverlayMode"][data-arg="both"]');
    if (bothChip) bothChip.click();
    else window.selectCandleOverlayMode?.('both');
    return true;
  `);
  await waitFor('both overlays attached', `window.getChartDebugState?.()?.candleOverlay?.mode === 'both' && (window.getChartDebugState?.()?.candleOverlay?.haCount || 0) > 0 && (window.getChartDebugState?.()?.candleOverlay?.renkoBrickCount || 0) > 0`);
  const bothDebug = (await debugState())?.candleOverlay || {};
  check(
    bothDebug.mode === 'both' && bothDebug.attached === true && bothDebug.haCount > 0 && bothDebug.renkoBrickCount > 0,
    'both overlay mode activates both heikin-ashi and renko series concurrently',
    bothDebug,
  );

  const dimAllState = await execute(`
    const dimAllBtn = document.getElementById('candleOverlayDimAllBtn');
    if (dimAllBtn) dimAllBtn.click();
    const debug = window.getChartDebugState?.()?.candleOverlay || {};
    return {
      baseCandles: debug.baseCandles,
      haDimmed: debug.heikinAshi?.dimmed ?? debug.options?.heikinAshi?.dimmed,
      renkoDimmed: debug.renko?.dimmed ?? debug.options?.renko?.dimmed,
    };
  `);
  check(
    dimAllState.baseCandles === 'dimmed' && dimAllState.haDimmed === true && dimAllState.renkoDimmed === true,
    'dim all overlays button dims base candles, heikin-ashi, and renko simultaneously',
    dimAllState,
  );

  await execute(`
    const offChip = document.querySelector('[data-action="selectCandleOverlayMode"][data-arg="off"]');
    if (offChip) offChip.click();
    else window.selectCandleOverlayMode?.('off');
    const btn = document.getElementById('candleOverlayToggleBtn');
    if (document.getElementById('candleOverlayPanel')?.dataset.open === 'true') {
      btn?.click();
    }
    return true;
  `);
  await waitFor('candle overlay detached', `window.getChartDebugState?.()?.candleOverlay?.mode === 'off' && window.getChartDebugState?.()?.candleOverlay?.attached === false`);
  const offDebug = (await debugState())?.candleOverlay || {};
  check(
    offDebug.mode === 'off' && offDebug.attached === false,
    'candle overlay mode turns off and cleanly detaches primitive',
    offDebug,
  );

  check(baseline.domRowCount >= 25, 'adaptive DOM ladder renders its height-derived row window', baseline.domRowCount);
  const domSteps = baseline.domPrices.slice(1).map((price, index) => baseline.domPrices[index] - price);
  const firstDomStep = domSteps[0];
  check(
    Number.isFinite(firstDomStep)
      && firstDomStep > 0
      && domSteps.every((step) => Math.abs(step - firstDomStep) < Math.max(1e-9, firstDomStep * 1e-8)),
    'adaptive DOM ladder renders a uniform descending price grid',
    { firstDomStep, domPrices: baseline.domPrices },
  );

  // Compare a closed bar. The active tail can advance between the browser
  // snapshot and REST response even when both paths are perfectly correct.
  const baselineLast = baseline.debug.lastClosedExchangeCandle || baseline.debug.lastExchangeCandle;
  const rest = await fetchJson('/api/chart-candles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      coin: 'BTC',
      interval: baseline.debug.lastSeriesMeta.timeframe,
      startTime: Number(baselineLast.t) - (3 * 24 * 60 * 60 * 1000),
      endTime: Date.now(),
      urgency: 'visible',
    }),
  });
  const matching = Array.isArray(rest.value)
    ? rest.value.find((candle) => Number(candle.t) === Number(baselineLast.t))
    : null;
  check(rest.status === 200 && Boolean(matching), 'REST snapshot contains the rendered exchange tail', { status: rest.status, tail: baselineLast });
  check(
    matching && ['o', 'h', 'l', 'c', 'v', 'T', 's', 'i', 'n'].every((key) => String(matching[key]) === String(baselineLast[key])),
    'rendered candle preserves the complete Hyperliquid payload',
    { rendered: baselineLast, rest: matching },
  );

  // Run the longer soak after the point-in-time comparison.
  await validateTargetCvdSoak();

  const previewAnchorPrice = await execute(`
    const px = Number(
      window.getChartDebugState?.().livePriceLinePrice
        || window.getChartDebugState?.().livePriceLinePrice
        || window.getChartDebugState?.().lastExchangeCandle?.c
        || 0
    );
    window.showScalePreview([
      { limitPx: px * 0.99, isBuy: true, sz: 'smoke-a' },
      { limitPx: px * 1.01, isBuy: false, sz: 'smoke-b' },
    ]);
    return px;
  `);
  check(Number(previewAnchorPrice) > 0, 'preview smoke resolves a positive live chart price', previewAnchorPrice);
  await waitFor('preview lines attach', 'window.getChartDebugState?.().previewLineCount === 2');
  check((await debugState()).previewLineCount === 2, 'native preview price lines attach and dedupe');
  await execute('window.clearScalePreview(); return true;');
  await waitFor('preview lines clear', 'window.getChartDebugState?.().previewLineCount === 0');
  check((await debugState()).previewLineCount === 0, 'native preview price lines clean up');

  // Manual anchored VWAP: one-shot placement snaps to a historical pivot,
  // persists its exact event time, and owns independent line/band lifecycle.
  // Reset only this smoke-owned feature state so reruns against the same
  // isolated browser profile remain deterministic.
  await execute(`
    localStorage.removeItem('pez:manual-anchored-vwap:BTC');
    localStorage.removeItem('pez:manual-anchored-vwap:ETH');
    return true;
  `);
  await switchCoin('ETH');
  await switchCoin('BTC');
  await sleep(700);
  const manualArmImmediate = await execute(`
    document.getElementById('manualAnchoredVwapAddBtn').click();
    return {
      buttonPresent: Boolean(document.getElementById('manualAnchoredVwapAddBtn')),
      visibleState: window.appState?.ui?.manualAnchoredVwapVisible,
      placementState: window.appState?.ui?.manualAnchoredVwapPlacementActive,
      debug: window.getChartDebugState?.().indicators?.manualAnchoredVwap,
    };
  `);
  check(manualArmImmediate.debug?.placementActive === true,
    'manual VWAP add control arms placement synchronously', manualArmImmediate);
  await waitFor('manual VWAP placement armed', 'window.getChartDebugState?.().indicators?.manualAnchoredVwap?.placementActive === true');
  await execute(`
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + rect.width * 0.55,
      clientY: rect.top + window.getChartDebugState().paneHeights[0] * 0.38,
    }));
    return true;
  `);
  await waitFor('manual VWAP anchor commit', `
    window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchorCount === 1
      && window.getChartDebugState?.().indicators?.manualAnchoredVwap?.renderedAnchorCount === 1
      && window.getChartDebugState?.().indicators?.manualAnchoredVwap?.placementActive === false
  `);
  let manualState = (await debugState()).indicators.manualAnchoredVwap;
  check(manualState.attached && manualState.anchorCount === 1, 'manual pivot-anchored VWAP attaches after one chart click', manualState);
  const firstAnchor = await execute(`
    const saved = JSON.parse(localStorage.getItem('pez:manual-anchored-vwap:BTC') || '{}');
    const debugAnchor = window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchors?.[0] || {};
    return {
      time: Number(saved.anchors?.[0]?.time || 0),
      id: String(saved.anchors?.[0]?.id || debugAnchor.id || ''),
      bandsVisible: saved.anchors?.[0]?.bandsVisible === true,
      sigma: Number(saved.anchors?.[0]?.sigma || 0),
      listPresent: Boolean(document.getElementById('manualAnchoredVwapList')),
      rowCount: document.querySelectorAll('#indicatorsPanel .avwap-row').length,
    };
  `);
  check(firstAnchor.time > 0, 'manual VWAP persists an exact historical event timestamp', firstAnchor);
  check(
    firstAnchor.listPresent === false
      && firstAnchor.rowCount === 0
      && firstAnchor.bandsVisible === false
      && firstAnchor.sigma === 2,
    'new manual VWAP starts with bands hidden at 2σ and is not listed in IND',
    firstAnchor,
  );
  const manualAnchorTime = firstAnchor.time;
  const chartEditor = await execute(`
    const editor = document.querySelector('.avwap-anchor-editor');
    const bands = editor?.querySelector('[data-change-action="onToggleManualAnchoredVwapBands"]');
    const sigma = editor?.querySelector('[data-change-action="onChangeManualAnchoredVwapSigma"]');
    const style = editor ? window.getComputedStyle(editor) : null;
    return {
      present: Boolean(editor),
      visible: style?.display === 'flex',
      bandsChecked: bands?.checked === true,
      sigmaValue: sigma?.value || '',
      left: editor ? Number.parseFloat(editor.style.left || '0') : 0,
      top: editor ? Number.parseFloat(editor.style.top || '0') : 0,
    };
  `);
  check(
    chartEditor.present
      && chartEditor.visible
      && chartEditor.bandsChecked === false
      && chartEditor.sigmaValue === '2'
      && chartEditor.left > 0
      && chartEditor.top > 0,
    'selected anchor shows on-chart Bands and σ controls',
    chartEditor,
  );

  await execute(`
    const bands = document.querySelector('.avwap-anchor-editor [data-change-action="onToggleManualAnchoredVwapBands"]');
    bands.checked = true;
    bands.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await waitFor('manual VWAP bands show', `
    window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchors?.[0]?.bandsVisible === true
  `);
  await execute(`
    const select = document.querySelector('.avwap-anchor-editor [data-change-action="onChangeManualAnchoredVwapSigma"]');
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await waitFor('manual VWAP sigma change', `
    window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchors?.[0]?.sigma === 3
  `);
  manualState = (await debugState()).indicators.manualAnchoredVwap;
  check(
    manualState.anchors?.[0]?.bandsVisible === true && manualState.anchors?.[0]?.sigma === 3,
    'manual VWAP per-anchor band controls rewire live',
    manualState.anchors,
  );
  const persistedOptions = await execute(`
    const saved = JSON.parse(localStorage.getItem('pez:manual-anchored-vwap:BTC') || '{}');
    return {
      bandsVisible: saved.anchors?.[0]?.bandsVisible === true,
      sigma: Number(saved.anchors?.[0]?.sigma || 0),
    };
  `);
  check(
    persistedOptions.bandsVisible === true && persistedOptions.sigma === 3,
    'manual VWAP persists its own bands and sigma with the anchor',
    persistedOptions,
  );

  const manual4h = await setTimeframe('4h');
  check(manual4h.debug.indicators.manualAnchoredVwap.anchorCount === 1
    && manual4h.debug.indicators.manualAnchoredVwap.renderedAnchorCount === 1,
  'manual VWAP recalculates on a different timeframe', manual4h.debug.indicators.manualAnchoredVwap);
  const preservedAnchorTime = await execute(`
    const saved = JSON.parse(localStorage.getItem('pez:manual-anchored-vwap:BTC') || '{}');
    return Number(saved.anchors?.[0]?.time || 0);
  `);
  check(preservedAnchorTime === manualAnchorTime, 'manual VWAP preserves its exact event time across timeframes', { manualAnchorTime, preservedAnchorTime });
  await setTimeframe('2h');

  await execute(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); return true;`);
  await waitFor('manual VWAP selected-anchor delete', 'window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchorCount === 0');
  check((await debugState()).indicators.manualAnchoredVwap.anchorCount === 0, 'manual VWAP selected anchor deletes cleanly');

  await execute(`document.getElementById('manualAnchoredVwapAddBtn').click(); return true;`);
  await execute(`
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + rect.width * 0.48,
      clientY: rect.top + window.getChartDebugState().paneHeights[0] * 0.60,
    }));
    return true;
  `);
  await waitFor('manual VWAP replacement anchor commit', 'window.getChartDebugState?.().indicators?.manualAnchoredVwap?.anchorCount === 1');
  await switchCoin('ETH');
  check((await debugState()).indicators.manualAnchoredVwap.anchorCount === 0, 'manual VWAP anchors do not bleed across coins');
  await switchCoin('BTC');
  check((await debugState()).indicators.manualAnchoredVwap.anchorCount === 1, 'manual VWAP anchors restore when returning to their coin');

  await setCheckbox('monthlyVolumeProfileCheck', true);
  await waitFor('monthly profile attach', 'window.getChartDebugState?.().indicators?.monthlyVolumeProfile?.attached === true')
    .catch(async (error) => {
      const state = await execute(`
        return import('/src/state/store.js').then(({ AppState }) => ({
          checked: document.getElementById('monthlyVolumeProfileCheck')?.checked,
          visible: AppState.ui.monthlyVolumeProfileVisible,
          debug: window.getChartDebugState?.().indicators?.monthlyVolumeProfile,
        }));
      `);
      throw new Error(`${error.message}; monthlyState=${JSON.stringify(state)}; console=${JSON.stringify(browserConsole.slice(-20))}`);
    });
  check((await debugState()).indicators.monthlyVolumeProfile.attached, 'monthly volume-profile primitive attaches dynamically');
  await setCheckbox('sessionVwapDailyCheck', true);
  await waitFor('session VWAP daily attach', `
    window.getChartDebugState?.().indicators?.sessionVwap?.attached === true
      && window.getChartDebugState?.().indicators?.sessionVwap?.options?.daily === true
  `);
  check((await debugState()).indicators.sessionVwap.dailyCount > 0, 'session VWAP computes daily sessions');
  await setCheckbox('sessionVwapDailyCheck', false);

  await setCheckbox('liquidationClustersCheck', true);
  await waitFor('liquidation clusters attach', `
    window.getChartDebugState?.().indicators?.liquidationClusters?.attached === true
      && window.getChartDebugState?.().indicators?.liquidationClusters?.visible === true
  `);
  check((await debugState()).indicators.liquidationClusters.attached, 'liquidation clusters primitive attaches dynamically');
  await setCheckbox('liquidationClustersCheck', false);
  await setCheckbox('rvwap7dBandsCheck', true);
  await setCheckbox('rvwap30dBandsCheck', true);
  await setCheckbox('rvwap90dBandsCheck', true);
  await setCheckbox('rvwap7dCheck', true);
  await setCheckbox('rvwap30dCheck', true);
  await setCheckbox('rvwap90dCheck', true);
  await setCheckbox('rvwap365dCheck', true);
  await waitFor('7D and 30D RVWAP attach', `
    window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.attached === true
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['30D']?.attached === true
  `);
  await waitFor('dedicated 90D RVWAP source and bands attach before scroll', `
    window.getChartDebugState?.().rvwapSource?.status === 'ready'
      && window.getChartDebugState?.().rvwapSource?.interval === '4h'
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.bandCount > 0
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['30D']?.bandCount > 0
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['90D']?.attached === true
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['90D']?.centerCount > 0
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['90D']?.bandCount > 0
      && window.getChartDebugState?.().indicators?.vwapBands?.hasPendingWork === false
  `);
  await waitFor('dedicated 365D RVWAP centerline attaches without bands', `
    window.getChartDebugState?.().rvwapSource?.status === 'ready'
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['365D']?.attached === true
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['365D']?.centerCount > 0
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['365D']?.bandsVisible === false
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['365D']?.bandCount === 0
      && window.getChartDebugState?.().indicators?.vwapBands?.hasPendingWork === false
  `, 90000);
  const noScrollRvwap = await debugState();
  check(
    noScrollRvwap.rvwapSource.count >= 540
      && noScrollRvwap.rvwapSource.firstTime < noScrollRvwap.rvwapSource.lastTime
      && noScrollRvwap.indicators.vwapBands.instances['90D'].rowCount === noScrollRvwap.rvwapIndicatorSource.count
      && noScrollRvwap.rvwapIndicatorSource.excludedOpenCount >= 0
      && noScrollRvwap.indicators.vwapBands.instances['90D'].insufficientHistory === false,
    '90D RVWAP and bands render from the dedicated 4h source without scrollback',
    {
      source: noScrollRvwap.rvwapSource,
      instance: noScrollRvwap.indicators.vwapBands.instances['90D'],
    },
  );
  check(
    noScrollRvwap.rvwapSource.count >= 2190
      && noScrollRvwap.indicators.vwapBands.instances['365D'].rowCount === noScrollRvwap.rvwapIndicatorSource.count
      && noScrollRvwap.indicators.vwapBands.instances['365D'].centerCount > 0
      && noScrollRvwap.indicators.vwapBands.instances['365D'].bandCount === 0
      && noScrollRvwap.indicators.vwapBands.instances['365D'].bandsVisible === false
      && noScrollRvwap.indicators.vwapBands.instances['365D'].insufficientHistory === false,
    '365D RVWAP renders from the dedicated 4h source as a centerline without bands',
    {
      source: noScrollRvwap.rvwapSource,
      instance: noScrollRvwap.indicators.vwapBands.instances['365D'],
    },
  );
  check(
    JSON.stringify((await debugState()).indicators.vwapBands.enabledLookbacks) === JSON.stringify(['7D', '30D', '90D', '365D']),
    'multiple RVWAP presets render simultaneously',
  );
  const smokeRollingInstances = (await debugState()).indicators.vwapBands.instances;
  check(
    smokeRollingInstances['7D']?.chartLabel === '7D'
      && smokeRollingInstances['30D']?.chartLabel === '30D'
      && smokeRollingInstances['90D']?.chartLabel === '90D'
      && smokeRollingInstances['365D']?.chartLabel === '365D',
    'rolling VWAP presets expose chart labels on chart series',
    smokeRollingInstances,
  );
  check(
    smokeRollingInstances['7D']?.lineWidth === 1
      && smokeRollingInstances['30D']?.lineWidth === 2
      && smokeRollingInstances['90D']?.lineWidth === 3
      && smokeRollingInstances['365D']?.lineWidth === 4,
    'rolling VWAP presets have tiered line width separation (7D: 1, 30D: 2, 90D: 3, 365D: 4)',
    smokeRollingInstances,
  );
  await validateVwapZoomStability();
  await setCheckbox('rvwap90dCheck', false);
  await setCheckbox('rvwap365dCheck', false);
  await setCheckbox('rvwap7dBandsCheck', false);
  await waitFor('7D RVWAP bands hide independently', `
    window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.attached === true
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.bandsVisible === false
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['30D']?.bandsVisible === true
  `);
  check(
    (await debugState()).indicators.vwapBands.instances['7D'].attached,
    '7D RVWAP center remains attached while only its bands are hidden',
  );
  await setCheckbox('rvwap7dBandsCheck', true);
  await waitFor(
    '7D RVWAP bands restore independently',
    `window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.bandsVisible === true`,
  );
  await setCheckbox('rvwap30dCheck', false);
  await waitFor('30D RVWAP detach independently', `
    window.getChartDebugState?.().indicators?.vwapBands?.instances?.['7D']?.attached === true
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['30D']?.attached === false
  `);
  check((await debugState()).indicators.vwapBands.attached, 'one RVWAP remains attached after hiding another');
  await setCheckbox('rvwap7dCheck', false);
  await waitFor('all RVWAPs detach', 'window.getChartDebugState?.().indicators?.vwapBands?.attached === false');
  await setCheckbox('rvwap30dCheck', true);
  await waitFor('30D RVWAP reattach', `window.getChartDebugState?.().indicators?.vwapBands?.instances?.['30D']?.attached === true`);
  await execute(`
    const select = document.getElementById('cvdOscillatorLookbackSelect');
    select.value = '3D';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await waitFor('oscillator lookback', 'window.getChartDebugState?.().indicators?.cvdOscillator?.lookbackDays === 3');
  check((await debugState()).indicators.cvdOscillator.lookbackDays === 3, 'oscillator lookback rewires live');
  await validateClosedCandleIndicatorStability();

  // Indicator pane changes resize the chart. Let the runtime's intentional
  // resize-click guard expire before synthesizing a drawing placement.
  await sleep(700);
  await execute('window.clearDrawings(); return true;');
  // selectDrawingTool toggles: re-selecting the armed tool disarms it. Arm once
  // and keep-draw through both panes.
  await execute(`
    if (window.getChartDebugState?.()?.drawings?.main?.activeTool !== 'horizontal') {
      window.selectDrawingTool('horizontal');
    }
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    const x = rect.left + rect.width * 0.55;
    const y = rect.top + window.getChartDebugState().paneHeights[0] * 0.45;
    const opts = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    wrap.dispatchEvent(new MouseEvent('click', opts));
    return window.getChartDebugState?.()?.drawings?.main?.activeTool === 'horizontal';
  `);
  await waitFor('main drawing commit', 'window.getChartDebugState?.().drawings?.main?.drawingCount === 1');
  check((await debugState()).drawings.main.drawingCount === 1, 'price-pane primitive drawing commits');
  check((await debugState()).drawings.main.activeTool === 'horizontal', 'keep-drawing leaves horizontal armed after main commit');
  // Pane resize from the prior drawing can still settle; wait before the CVD hit-test.
  await sleep(700);
  await execute(`
    // Do NOT call selectDrawingTool again — it would toggle horizontal off.
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    const heights = window.getChartDebugState().paneHeights || [];
    const mainHeight = Number(heights[0]) || 0;
    const cvdHeight = Number(heights[1]) || 80;
    // Aim at the vertical center of the CVD pane, not the separator strip.
    const x = rect.left + rect.width * 0.50;
    const y = rect.top + mainHeight + Math.max(24, cvdHeight * 0.5);
    const opts = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    wrap.dispatchEvent(new MouseEvent('click', opts));
    return true;
  `);
  await waitFor('lower drawing commit', 'window.getChartDebugState?.().drawings?.cvd?.drawingCount === 1', 45000);
  check((await debugState()).drawings.cvd.drawingCount === 1, 'lower-pane primitive drawing routes to CVD');

  await switchCoin('ETH');
  check((await debugState()).drawings.main.drawingCount === 0, 'drawings do not bleed across coins');
  await switchCoin('BTC');
  check((await debugState()).drawings.main.drawingCount === 1, 'drawings restore when returning to their coin');
  await execute(`
    window.app.showToast('Unified clear smoke', false, { persist: true });
    document.querySelector('[data-action="clearMessagesAndDrawings"]').click();
    return true;
  `);
  await waitFor('unified topbar clear', `
    Object.values(window.getChartDebugState?.().drawings || {}).every((pane) => pane.drawingCount === 0)
      && (document.getElementById('toast-container')?.children.length || 0) === 0
  `);
  const unifiedClearState = await execute(`
    return {
      drawingCounts: Object.fromEntries(
        Object.entries(window.getChartDebugState?.().drawings || {})
          .map(([pane, value]) => [pane, value.drawingCount])
      ),
      toastCount: document.getElementById('toast-container')?.children.length || 0,
      storage: [
        'pez:drawings:BTC',
        'pez:drawings:BTC:cvd',
        'pez:drawings:BTC:osc',
      ].map((key) => [key, localStorage.getItem(key)]),
    };
  `);
  check(
    Object.values(unifiedClearState.drawingCounts).every((count) => count === 0)
      && unifiedClearState.toastCount === 0
      && unifiedClearState.storage.every(([, value]) => value == null),
    'topbar CLEAR removes toast messages and drawings from every pane',
    unifiedClearState,
  );

  for (const timeframe of ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '1w', '1M']) {
    const snap = await setTimeframe(timeframe);
    check(snap.debug.lastSeriesMeta.timeframe === timeframe, `timeframe ${timeframe} owns its native series`, snap.debug.lastSeriesMeta);
    check(snap.debug.exchangeCandleCount > 0, `timeframe ${timeframe} renders non-empty exchange candles`, snap.chartSession);
    check(snap.debug.canonicalInvalidCount === 0, `timeframe ${timeframe} canonical candles are valid`, snap.debug);
    check(snap.debug.canonicalDuplicateCount === 0 && snap.debug.canonicalOutOfOrderCount === 0, `timeframe ${timeframe} canonical candles stay strictly ordered`, snap.debug);
    const shouldHaveCvd = timeframe !== '1w' && timeframe !== '1M';
    check(snap.debug.indicators.cvd.attached === shouldHaveCvd, `timeframe ${timeframe} CVD lifecycle is correct`, snap.debug.indicators);
    check(snap.debug.indicators.cvdOscillator.attached === shouldHaveCvd, `timeframe ${timeframe} oscillator lifecycle is correct`, snap.debug.indicators);
    if (shouldHaveCvd) {
      check(snap.debug.indicators.cvd.rowCount === snap.debug.indicatorSource.count, `timeframe ${timeframe} CVD covers every closed candle`, {
        indicators: snap.debug.indicators,
        source: snap.debug.indicatorSource,
      });
      check(snap.debug.indicators.cvd.anchorTimeframe === '1W-MON00'
        && snap.debug.indicators.cvd.baselineVisible === true
        && snap.debug.indicators.cvd.resetCount > 0,
      `timeframe ${timeframe} exposes the canonical weekly zero baseline`, snap.debug.indicators.cvd);
      check(snap.debug.indicators.cvdOscillator.rowCount > 0, `timeframe ${timeframe} oscillator has computed history`, snap.debug.indicators);
    }
  }

  await setTimeframe('2h');
  for (const coin of ['ETH', 'SOL', 'xyz:GOLD', 'BTC']) {
    const snap = await switchCoin(coin);
    check(snap.debug.lastSeriesMeta.coin === coin, `${coin} series ownership is not stale`, snap.debug.lastSeriesMeta);
    check(snap.debug.lastSeriesMeta.length === snap.debug.exchangeCandleCount, `${coin} series metadata matches canonical candles`, snap.debug);
    check(snap.debug.lastInitError === '', `${coin} switch leaves chart healthy`, snap.debug.lastInitError);
    const displayCoin = coin.includes(':') ? coin.split(':')[1] : coin;
    check(snap.title.startsWith(displayCoin), `${coin} browser title follows the settled chart selection`, snap.title);
  }

  await validateTargetCvdRendering();
  await switchCoin('BTC');
  await setTimeframe('2h');

  await setCheckbox('rvwap90dCheck', true);
  await waitFor('90D RVWAP reattach before history navigation', `
    window.getChartDebugState?.().rvwapSource?.status === 'ready'
      && window.getChartDebugState?.().indicators?.vwapBands?.instances?.['90D']?.bandCount > 0
  `);
  const beforeHistory = await debugState();
  const rect = await execute(`
    const r = document.getElementById('chartWrap').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  `);
  for (let i = 0; i < 8; i += 1) {
    await dragChart(
      Math.round(rect.left + rect.width * 0.25),
      Math.round(rect.left + rect.width * 0.82),
      Math.round(rect.top + Math.min(beforeHistory.paneHeights[0] * 0.45, rect.height * 0.35)),
    );
    await sleep(150);
  }
  await sleep(1500);
  const afterHistory = await debugState();
  check(
    Number(afterHistory.firstExchangeCandle?.t) <= Number(beforeHistory.firstExchangeCandle?.t),
    'history navigation never loses the loaded head',
    { before: beforeHistory.firstExchangeCandle?.t, after: afterHistory.firstExchangeCandle?.t },
  );
  check(Number.isFinite(afterHistory.barsInfo?.barsBefore), 'barsInLogicalRange drives history-edge diagnostics', afterHistory.barsInfo);
  check(
    afterHistory.rvwapSource.interval === '4h'
      && afterHistory.rvwapSource.count === beforeHistory.rvwapSource.count
      && afterHistory.rvwapSource.firstTime === beforeHistory.rvwapSource.firstTime
      && afterHistory.indicators.vwapBands.instances['90D'].rowCount
        === beforeHistory.indicators.vwapBands.instances['90D'].rowCount
      && afterHistory.indicators.vwapBands.instances['90D'].centerCount
        >= beforeHistory.indicators.vwapBands.instances['90D'].centerCount
      && afterHistory.indicators.vwapBands.instances['90D'].bandCount
        >= beforeHistory.indicators.vwapBands.instances['90D'].bandCount
      && afterHistory.indicators.vwapBands.instances['90D'].lastCenterTime
        === beforeHistory.indicators.vwapBands.instances['90D'].lastCenterTime
      && afterHistory.indicators.vwapBands.instances['90D'].lastCenterValue
        === beforeHistory.indicators.vwapBands.instances['90D'].lastCenterValue
      && JSON.stringify(afterHistory.indicators.vwapBands.instances['90D'].lastValues)
        === JSON.stringify(beforeHistory.indicators.vwapBands.instances['90D'].lastValues),
    '90D RVWAP source and latest values stay stable while scrollback expands projected history',
    {
      beforeSource: beforeHistory.rvwapSource,
      afterSource: afterHistory.rvwapSource,
      beforeInstance: beforeHistory.indicators.vwapBands.instances['90D'],
      afterInstance: afterHistory.indicators.vwapBands.instances['90D'],
    },
  );
  // Use a user-owned live-edge range to prove responsive resize preserves the
  // inspected logical window instead of swapping in a different amount of data.
  await execute('window.jumpChartToLive(); return true;');

  // Scrollback can enqueue another cached-history prepend after the drag loop.
  // Capture the resize baseline only after that asynchronous merge has settled.
  const beforeResize = await waitForStableLoadedCandles('responsive resize baseline');
  await wd('POST', `/session/${sessionId}/window/rect`, { x: 20, y: 20, width: 600, height: 850 });
  await sleep(800);
  const mobile = await browserSnapshot('mobile-resize');
  check(mobile.debug.chartCreateCount === beforeResize.chartCreateCount, 'responsive resize reuses the chart instance', mobile.debug);
  const beforeResizeRange = beforeResize.visibleTimeRange;
  const afterResizeRange = mobile.debug.visibleTimeRange;
  check(
    beforeResizeRange
      && afterResizeRange
      && Math.abs(Number(afterResizeRange.from) - Number(beforeResizeRange.from))
        <= TIME_RANGE_TOLERANCE_SECONDS
      && Math.abs(Number(afterResizeRange.to) - Number(beforeResizeRange.to))
        <= TIME_RANGE_TOLERANCE_SECONDS,
    'responsive resize preserves the visible time range',
    {
      before: beforeResizeRange,
      after: afterResizeRange,
      toleranceSeconds: TIME_RANGE_TOLERANCE_SECONDS,
      logicalBefore: beforeResize.visibleLogicalRange,
      logicalAfter: mobile.debug.visibleLogicalRange,
    },
  );
  check(mobile.touchToolbarDisplay !== 'none', 'mobile chart action toolbar becomes visible', mobile.touchToolbarDisplay);

  await wd('POST', `/session/${sessionId}/window/rect`, { x: 20, y: 20, width: 600, height: 420 });
  await sleep(300);
  await execute(`document.getElementById('indicatorsToggleBtn').click(); return true;`);
  await waitFor('short-viewport IND panel open', `document.getElementById('indicatorsPanel')?.dataset.open === 'true'`);
  const shortIndicatorPanel = await execute(`
    const panel = document.getElementById('indicatorsPanel');
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      overflowY: style.overflowY,
    };
  `);
  check(
    shortIndicatorPanel.top >= 4 && shortIndicatorPanel.bottom <= shortIndicatorPanel.viewportHeight - 4,
    'short-viewport IND panel stays inside the viewport',
    shortIndicatorPanel,
  );
  check(
    shortIndicatorPanel.overflowY === 'auto'
      && shortIndicatorPanel.scrollHeight > shortIndicatorPanel.clientHeight,
    'short-viewport IND groups scroll internally without clipping',
    shortIndicatorPanel,
  );
  await execute(`document.getElementById('indicatorsToggleBtn').click(); return true;`);
  // Restore the desktop chart geometry before validating pane-aware price
  // picking. At the narrow layout, surrounding panels can legitimately leave
  // the three chart panes too short for a meaningful main-pane click target.
  await wd('POST', `/session/${sessionId}/window/rect`, { x: 20, y: 20, width: 1440, height: 1000 });
  await sleep(800);

  await setTimeframe('1m');
  check((await debugState()).exchangeCandleCount >= 100, 'cached 1m chart survives an exchange refresh throttle');
  // 1m pane attach can fire ResizeObserver; price-pick ignores clicks for 600ms
  // after a wrap resize so they are not confused with layout settling.
  await sleep(700);
  const pickResult = await execute(`
    const wrap = document.getElementById('chartWrap');
    const rect = wrap.getBoundingClientRect();
    const input = document.getElementById('priceInput');
    input.value = '12345.6789';
    const before = input.value;
    const paneHeight = window.getChartDebugState().paneHeights[0];
    const emit = (y) => wrap.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      altKey: true,
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + y,
    }));
    emit(paneHeight + 15);
    const afterLower = input.value;
    emit(Math.max(20, paneHeight * 0.5));
    return { before, afterLower, afterMain: input.value, paneHeight, wrapHeight: rect.height };
  `);
  check(pickResult.afterLower === pickResult.before, 'lower-pane click cannot become an order price', pickResult);
  check(pickResult.afterMain !== pickResult.before, 'main-pane click still picks a native series price', pickResult);

  await setTimeframe('2h');

  const projectionBefore = await debugState();
  const projectionAdvanced = await waitFor(
    'forming candle projection',
    `window.getChartDebugState?.().projectedCandleUpdateCount > ${projectionBefore.projectedCandleUpdateCount || 0}`,
    20000,
  ).catch(() => false);
  const firstProjection = await debugState();
  check(Boolean(projectionAdvanced), 'live price traffic reaches the forming candle projection', firstProjection);
  check(
    Number(firstProjection.projectedCandle?.c) === Number(firstProjection.livePriceLinePrice)
      && Number(firstProjection.projectedCandleSourcePrice) === Number(firstProjection.livePriceLinePrice),
    'forming candle close is locked to the native live-price line',
    firstProjection,
  );

  const firstProjectionPrice = Number(firstProjection.projectedCandleSourcePrice);
  const secondProjectionAdvanced = await waitFor(
    'forming candle price change',
    `window.getChartDebugState?.().projectedCandleUpdateCount > ${firstProjection.projectedCandleUpdateCount || 0}
      && window.getChartDebugState?.().projectedCandleSourcePrice !== ${JSON.stringify(firstProjectionPrice)}`,
    20000,
  ).catch(() => false);
  const secondProjection = await debugState();
  check(Boolean(secondProjectionAdvanced), 'forming candle receives successive live prices', secondProjection);
  if (secondProjectionAdvanced) {
    const secondPrice = Number(secondProjection.projectedCandleSourcePrice);
    check(
      Number(secondProjection.projectedCandle?.h) >= Math.max(firstProjectionPrice, secondPrice)
        && Number(secondProjection.projectedCandle?.l) <= Math.min(firstProjectionPrice, secondPrice),
      'forming candle wicks retain observed live-price extrema',
      { firstProjectionPrice, secondPrice, candle: secondProjection.projectedCandle },
    );
  }

  const updatesBefore = (await debugState()).authoritativeUpdateCount;
  const liveAdvanced = await waitFor(
    'live candle update',
    `window.getChartDebugState?.().authoritativeUpdateCount > ${updatesBefore}`,
    20000,
  ).catch(() => false);
  check(Boolean(liveAdvanced), 'WebSocket candle traffic reaches authoritative series.update()', { before: updatesBefore, after: (await debugState()).authoritativeUpdateCount });

  const churn = [
    ['ETH', '1m'], ['SOL', '5m'], ['xyz:GOLD', '15m'], ['BTC', '30m'], ['ETH', '4h'], ['BTC', '2h'],
  ];
  for (const [coin, timeframe] of churn) {
    await execute(`
      window.switchCoin(arguments[0]);
      const button = document.querySelector('[data-action="setTimeframe"][data-arg="' + arguments[1] + '"]');
      button?.click();
      return true;
    `, [coin, timeframe]);
    await sleep(90);
  }
  await waitFor(
    'rapid churn settles on BTC 2h',
    `window.getChartDebugState?.().selection?.coin === 'BTC'
      && window.getChartDebugState?.().selection?.timeframe === '2h'
      && window.getChartDebugState?.().lastSeriesMeta?.coin === 'BTC'
      && window.getChartDebugState?.().lastSeriesMeta?.timeframe === '2h'
      && window.getChartDebugState?.().exchangeCandleCount > 0`,
    60000,
  );
  const churnState = await debugState();
  check(churnState.lastSeriesMeta.coin === 'BTC' && churnState.lastSeriesMeta.timeframe === '2h', 'rapid churn cannot commit stale chart data', churnState.lastSeriesMeta);
  check(churnState.candleIntegrity?.activeRepair == null, 'rapid churn settles with no orphaned candle repair', churnState.candleIntegrity);
  check(churnState.canonicalInvalidCount === 0 && churnState.canonicalDuplicateCount === 0 && churnState.canonicalOutOfOrderCount === 0, 'rapid churn settles on a valid canonical series', churnState);
  check(churnState.chartCreateCount === 1, 'coin/timeframe churn never recreates the chart root', churnState);
  check(churnState.seriesRecreateCount > 0, 'coin/timeframe churn recreates only the main series', churnState.seriesRecreateCount);
  await validateChartZoomAndScroll('post-churn BTC 2h');

  const screenshot = await wd('GET', `/session/${sessionId}/screenshot`);
  check(typeof screenshot === 'string' && screenshot.length > 10000, 'real-browser screenshot renders non-empty chart output', screenshot?.length);

  const runtimeErrors = await execute('return window.__pezSmokeErrors || [];');
  check(runtimeErrors.length === 0 && pageErrors.length === 0, 'no runtime errors or unhandled rejections during smoke', { runtimeErrors, pageErrors });
  const activeCandleRecoveryWarnings = browserConsole.filter((entry) => (
    entry.type === 'warning'
    && entry.text.includes('[market] active candle recovery failed')
  ));
  check(activeCandleRecoveryWarnings.length === 0, 'no active candle recovery warnings during smoke', activeCandleRecoveryWarnings);
  const chartUpdateWarnings = browserConsole.filter((entry) => (
    ['warning', 'error'].includes(entry.type)
    && entry.text.includes('[chart] series.update() failed')
  ));
  check(chartUpdateWarnings.length === 0, 'no rejected Lightweight Charts series updates during smoke', chartUpdateWarnings);
  const resources = await execute(`
    return performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      transferSize: entry.transferSize,
      responseStatus: entry.responseStatus || 0,
    }));
  `);
  const failedResources = resources.filter((entry) => entry.responseStatus >= 400);
  const isRecoverableUpstreamFailure = (entry) => (
    entry.status === 502
    && (entry.url.endsWith('/api/hl') || entry.url.endsWith('/api/chart-candles'))
  );
  const resourceFailures = failedResources.map((entry) => ({ url: entry.name, status: entry.responseStatus }));
  const observedFailures = [...failedResponses, ...resourceFailures];
  const applicationFailures = observedFailures.filter((entry) => !isRecoverableUpstreamFailure(entry));
  check(applicationFailures.length === 0, 'no application/static resource loads returned HTTP errors', applicationFailures);
  const upstreamFailures = observedFailures.filter(isRecoverableUpstreamFailure);
  check(
    upstreamFailures.length === 0 || (
      runtimeErrors.length === 0
      && pageErrors.length === 0
      && chartUpdateWarnings.length === 0
      && Number(churnState.chartCreateCount) === 1
      && Number(churnState.exchangeCandleCount) > 100
    ),
    'transient upstream throttles recover without corrupting chart state',
    { upstreamFailures, failedResources, rejectedUpdateCount: churnState.rejectedUpdateCount },
  );

  for (const deadPath of ['/app.js', '/bot.js', '/swing_detector.js', '/strategies/chart-layers.js', '/vendor/lightweight-charts/dist/lightweight-charts.standalone.production.mjs']) {
    const response = await fetch(`${APP}${deadPath}`);
    check(response.status === 404, `dead runtime route ${deadPath} is removed`, response.status);
  }

  const removedAccountStream = await fetch(`${APP}/api/account-stream`);
  check(removedAccountStream.status === 404, 'retired multiplexed account stream is unavailable', removedAccountStream.status);
  const removedNewsPost = await fetch(`${APP}/api/news-config`, { method: 'POST' });
  check(removedNewsPost.status === 404, 'retired news-config POST is unavailable', removedNewsPost.status);
  const readableNewsConfig = await fetchJson('/api/news-config');
  check(readableNewsConfig.status === 200, 'news provider configuration remains readable', readableNewsConfig.status);

  const journalSummary = await fetchJson('/api/journal/summary');
  check(journalSummary.status === 200 && typeof journalSummary.value?.totalEntries === 'number', 'execution journal summary endpoint is active', journalSummary.status);
  const journalExecutions = await fetchJson('/api/journal/executions?limit=10');
  check(journalExecutions.status === 200 && Array.isArray(journalExecutions.value?.entries), 'execution journal records endpoint is active', journalExecutions.status);

  const workerStats = await execute('return window.getIndicatorWorkerStats ? window.getIndicatorWorkerStats() : null;');
  check(workerStats !== null && typeof workerStats?.totalJobs === 'number', 'indicator worker pipeline is active and diagnostic stats accessible', workerStats);

  const metrics = await fetch(`${APP}/metrics`).then((response) => response.text());
  check(/pez_candle_serve_total/.test(metrics), 'candle-store metrics are exposed');
  check(/pez_market_upstream_subscriptions/.test(metrics), 'market subscription metrics are exposed');

  const final = await browserSnapshot('final');
  observations.push({ label: 'summary', detail: {
    finalCoin: final.coin,
    finalTimeframe: final.timeframe,
    setDataCount: final.debug.setDataCount,
    updateCount: final.debug.updateCount,
    reconciliationSetDataCount: final.debug.reconciliationSetDataCount,
    rejectedUpdateCount: final.debug.rejectedUpdateCount,
    chartCreateCount: final.debug.chartCreateCount,
    seriesRecreateCount: final.debug.seriesRecreateCount,
    candleCount: final.debug.exchangeCandleCount,
    recoveredUpstreamFailures: failedResponses.filter((entry) => entry.status === 502).length,
  } });
}

try {
  await main();
} catch (error) {
  failures.push({ label: 'smoke execution completed', detail: error.stack || error.message });
} finally {
  if (sessionId) {
    await execute(`
      for (const key of [
        'pez:manual-anchored-vwap:BTC',
        'pez:manual-anchored-vwap:ETH',
        'pez:drawings:BTC',
        'pez:drawings:BTC:cvd',
        'pez:drawings:BTC:osc',
        'pez:drawings:ETH',
        'pez:drawings:ETH:cvd',
        'pez:drawings:ETH:osc',
      ]) localStorage.removeItem(key);
      return true;
    `).catch(() => {});
    await wd('DELETE', `/session/${sessionId}`).catch(() => {});
  }
  await cdpLifecycle.cleanup().catch(() => {});
}

process.stdout.write(`${JSON.stringify({
  ok: failures.length === 0,
  passed: observations.length,
  failures,
  observations,
}, null, 2)}\n`);

if (failures.length > 0) process.exitCode = 1;
