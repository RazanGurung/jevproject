#!/usr/bin/env node

// Exhaustive, non-funded UI accuracy and latency gate.
//
// The harness uses Opera/Chromium's built-in DevTools protocol so it adds no
// browser-driver dependency. Start the production server and an isolated Opera
// instance first; see docs/LIVE_VALIDATION_RUNBOOK.md.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ensureCdpEndpoint, resolveCdpUrl } from './lib/cdp-browser.mjs';

import {
  ACTION_ATTRIBUTES,
  DIRECT_CONTROL_IDS,
  DYNAMIC_ACTIONS,
  MUTATING_API_PATHS,
  expectedStaticVariantKeys,
} from '../web/src/bootstrap/ui-action-manifest.js';

const APP_URL = process.env.PEZ_URL || 'http://127.0.0.1:5001';
let CDP_URL = resolveCdpUrl() || 'http://127.0.0.1:9222';
let cdpLifecycle = { cleanup: async () => {} };
const ITERATIONS = Math.max(3, Number.parseInt(process.env.PEZ_PERF_ITERATIONS || '30', 10) || 30);
const REPORT_DIR = process.env.PEZ_PERF_REPORT_DIR || '';
const SOAK_MS = Math.max(0, Number.parseInt(process.env.PEZ_PERF_SOAK_MS || '0', 10) || 0);
const LOCAL_P95_BUDGET_MS = 50;
const LOCAL_MAX_BUDGET_MS = 100;
const WARM_COMMIT_P95_BUDGET_MS = 50;
const WARM_READY_P95_BUDGET_MS = 250;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function summarizeSamples(samples) {
  const values = samples.map((sample) => Number(sample.durationMs)).filter(Number.isFinite);
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    maxMs: Number(Math.max(0, ...values).toFixed(2)),
  };
}

function pathnameOf(rawUrl) {
  try { return new URL(rawUrl).pathname; } catch { return ''; }
}

async function connectCdp() {
  const response = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`CDP target creation failed: ${response.status}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result || {});
      return;
    }
    for (const handler of eventHandlers.get(message.method) || []) {
      Promise.resolve(handler(message.params || {})).catch(() => {});
    }
  });

  function call(method, params = {}) {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP socket closed'));
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, handler) {
    const handlers = eventHandlers.get(method) || [];
    handlers.push(handler);
    eventHandlers.set(method, handlers);
  }

  return { target, socket, call, on };
}

let activeCdp = null;

async function main() {
  cdpLifecycle = await ensureCdpEndpoint(CDP_URL);
  CDP_URL = cdpLifecycle.url || CDP_URL;
  const cdp = await connectCdp();
  activeCdp = cdp;
  const runtimeErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  const interceptedMutations = [];
  const failures = [];

  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    runtimeErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || 'Runtime exception');
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args = [] }) => {
    if (!['error', 'assert'].includes(type)) return;
    consoleErrors.push(args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });
  cdp.on('Network.responseReceived', ({ response }) => {
    const path = pathnameOf(response?.url || '');
    if (Number(response?.status) >= 400 && !MUTATING_API_PATHS.includes(path)) {
      failedResponses.push({ status: response.status, url: response.url });
    }
  });
  cdp.on('Fetch.requestPaused', async (event) => {
    const path = pathnameOf(event.request?.url || '');
    const method = String(event.request?.method || 'GET').toUpperCase();
    if (!MUTATING_API_PATHS.includes(path) || method === 'GET' || method === 'HEAD') {
      await cdp.call('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    interceptedMutations.push({
      path,
      method: event.request.method,
      postData: event.request.postData || '',
    });
    const body = Buffer.from(JSON.stringify({
      ok: true,
      status: 'mocked',
      message: 'Non-funded UI performance fixture',
      orders: [],
      statuses: [],
    })).toString('base64');
    await cdp.call('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body,
    });
  });

  await Promise.all([
    cdp.call('Page.enable'),
    cdp.call('Runtime.enable'),
    cdp.call('Network.enable'),
    cdp.call('Performance.enable'),
    cdp.call('Fetch.enable', { patterns: [{ urlPattern: `${new URL(APP_URL).origin}/api/*` }] }),
  ]);

  async function evaluate(expression) {
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value;
  }

  async function waitFor(expression, timeoutMs = 30_000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
  }

  async function browserMetrics() {
    const { metrics = [] } = await cdp.call('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    return {
      nodes: values.Nodes || 0,
      listeners: values.JSEventListeners || 0,
      heapUsed: values.JSHeapUsedSize || 0,
      documents: values.Documents || 0,
    };
  }

  const loadStartedAt = Date.now();
  await cdp.call('Page.navigate', { url: APP_URL });
  await waitFor(`document.readyState === 'complete' && typeof window.switchCoin === 'function'`, 60_000);
  await waitFor(`(() => { const splash = document.getElementById('startup-splash'); return !splash || splash.classList.contains('hidden') || getComputedStyle(splash).display === 'none'; })()`, 90_000);

  await evaluate(`
    (() => {
      window.__pezPerfAudit = { actionKeys: [], longTasks: [] };
      window.__PEZ_PERF_ENABLED__ = true;
      const attrs = ${JSON.stringify(ACTION_ATTRIBUTES)};
      const record = (event, attr) => {
        const target = event.target?.closest?.('[' + attr + ']');
        if (!target) return;
        const action = target.getAttribute(attr) || '';
        const arg = target.getAttribute('data-arg') || '';
        window.__pezPerfAudit.actionKeys.push(attr + ':' + action + ':' + arg);
      };
      document.addEventListener('click', (event) => record(event, 'data-action'), true);
      document.addEventListener('input', (event) => record(event, 'data-input-action'), true);
      document.addEventListener('change', (event) => record(event, 'data-change-action'), true);
      document.addEventListener('submit', (event) => record(event, 'data-submit-action'), true);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') record(event, 'data-enter-action');
      }, true);
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__pezPerfAudit.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }
        });
        observer.observe({ type: 'longtask' });
        window.__pezPerfAudit.longTaskObserver = observer;
      } catch {}
    })()
  `);
  const baselineMetrics = await browserMetrics();

  const desktop = await evaluate(`
    (async () => {
      const iterations = ${ITERATIONS};
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const samples = [];
      const run = async (name, action, validate = () => true) => {
        const started = performance.now();
        action();
        await twoFrames();
        samples.push({ name, durationMs: performance.now() - started, ok: Boolean(validate()) });
      };
      for (let index = 0; index < iterations; index += 1) {
        await run('settings', () => document.getElementById('settingsToggleBtn').click());
        await run('settings', () => document.getElementById('settingsToggleBtn').click());
        await run('movers', () => document.getElementById('moversToggleBtn').click());
        await run('movers', () => document.getElementById('moversToggleBtn').click());
        await run('trade-panel', () => document.getElementById('tradingToggleBtn').click());
        await run('trade-panel', () => document.getElementById('tradingToggleBtn').click());
        for (const tab of ['orders', 'trades', 'fills', 'positions']) {
          await run('bottom-' + tab, () => document.querySelector('.bottom-tab[data-tab="' + tab + '"]').click(),
            () => document.querySelector('.bottom-tab[data-tab="' + tab + '"]').classList.contains('active'));
        }
      }
      for (const category of ['crypto', 'indices', 'commodities', 'stocks', 'fx', 'watchlist']) {
        const selector = '[data-action="toggleCoinDropdown"][data-arg="' + category + '"]';
        await run('market-picker-' + category, () => document.querySelector(selector).click());
        await run('market-picker-' + category, () => document.querySelector(selector).click());
      }
      return samples;
    })()
  `);

  const symbolSwitches = await evaluate(`
    (async () => {
      const coins = ['BTC', 'ETH', 'SOL', 'xyz:GOLD'];
      // A real p95 needs enough warm samples to reject a one-off scheduler
      // interruption. The default 30-iteration gate yields 20 warm switches.
      const cycles = Math.max(3, Math.min(6, Math.ceil(${ITERATIONS} / 5)));
      const samples = [];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let cycle = 0; cycle < cycles; cycle += 1) for (const coin of coins) {
        const displayCoin = coin.includes(':') ? coin.split(':').pop() : coin;
        const started = performance.now();
        window.switchCoin(coin);
        await twoFrames();
        const commitMs = performance.now() - started;
        let ready = false;
        while (performance.now() - started < 10_000) {
          const debug = window.getChartDebugState?.();
          if (document.getElementById('chartTitle')?.textContent === displayCoin
            && debug?.selection?.coin === coin
            && debug?.selection?.chartSession?.coin === coin
            && debug?.selection?.chartSession?.status === 'ready'
            && debug?.exchangeCandleCount > 0) {
            ready = true;
            break;
          }
          await sleep(25);
        }
        const debug = window.getChartDebugState?.() || {};
        samples.push({
          coin,
          cycle,
          commitMs,
          readyMs: performance.now() - started,
          ready,
          candleCount: debug.exchangeCandleCount || 0,
          invalid: debug.canonicalInvalidCount || 0,
          duplicates: debug.canonicalDuplicateCount || 0,
          outOfOrder: debug.canonicalOutOfOrderCount || 0,
          rejectedUpdates: debug.rejectedUpdateCount || 0,
          selection: debug.selection || null,
        });
      }
      return samples;
    })()
  `);

  await evaluate(`window.switchCoin('BTC')`);
  await waitFor(`window.getChartDebugState?.().selection?.coin === 'BTC' && window.getChartDebugState?.().selection?.chartSession?.status === 'ready'`, 15_000);
  const timeframeSwitches = await evaluate(`
    (async () => {
      const values = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '1w', '1M'];
      const samples = [];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const value of values) {
        const button = [...document.querySelectorAll('.tf-group button')].find((node) => node.textContent.trim() === value);
        const started = performance.now();
        button.click();
        await twoFrames();
        const commitMs = performance.now() - started;
        let ready = false;
        while (performance.now() - started < 10_000) {
          const debug = window.getChartDebugState?.();
          if (button.classList.contains('active')
            && debug?.selection?.timeframe === value
            && debug?.selection?.chartSession?.timeframe === value
            && debug?.selection?.chartSession?.status === 'ready'
            && debug?.exchangeCandleCount > 0) {
            ready = true;
            break;
          }
          await sleep(25);
        }
        const debug = window.getChartDebugState?.() || {};
        samples.push({ value, commitMs, readyMs: performance.now() - started, ready,
          invalid: debug.canonicalInvalidCount || 0,
          duplicates: debug.canonicalDuplicateCount || 0,
          outOfOrder: debug.canonicalOutOfOrderCount || 0,
          selection: debug.selection || null });
      }
      return samples;
    })()
  `);

  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  const mobile = await evaluate(`
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const iterations = ${ITERATIONS};
      const samples = [];
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let index = 0; index < iterations; index += 1) {
        for (const view of ['book', 'news', 'trade', 'account', 'chart']) {
          const button = document.querySelector('.mobile-dock-btn[data-arg="' + view + '"]');
          const started = performance.now();
          button.click();
          await twoFrames();
          samples.push({ name: 'mobile-' + view, durationMs: performance.now() - started,
            ok: button.classList.contains('active') && document.getElementById('mainLayout').dataset.mobileView === view });
        }
      }
      return samples;
    })()
  `);
  await cdp.call('Emulation.clearDeviceMetricsOverride');

  // Exercise every static action once. Repeated latency gates above cover the
  // common navigation surfaces; this pass is an exhaustive wiring/exception
  // check, with exchange-changing requests intercepted by Fetch.requestPaused.
  const exhaustive = await evaluate(`
    (async () => {
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const attrs = ${JSON.stringify(ACTION_ATTRIBUTES)};
      const directIds = ${JSON.stringify(DIRECT_CONTROL_IDS)};
      const dynamicActions = new Set(${JSON.stringify(DYNAMIC_ACTIONS)});
      const results = [];
      const seen = new Set();
      const assignSafeValue = (element) => {
        if (element.type === 'checkbox' || element.type === 'radio') element.checked = !element.checked;
        else if (element.type === 'range' || element.type === 'number') {
          const min = Number(element.min || 0); const max = Number(element.max || min + 10);
          element.value = String(Number.isFinite(max) ? Math.max(min, Math.min(max, min + 1)) : 1);
        } else if (element.tagName === 'SELECT' && element.options.length) {
          element.selectedIndex = Math.min(1, element.options.length - 1);
        }
      };
      for (const attr of attrs) {
        const elements = [...document.querySelectorAll('[' + attr + ']')];
        for (const element of elements) {
          const action = element.getAttribute(attr) || '';
          const arg = element.getAttribute('data-arg') || '';
          const key = attr + ':' + action + ':' + arg;
          const coverageKey = attr === 'data-action' && dynamicActions.has(action)
            ? attr + ':' + action + ':<dynamic>'
            : key;
          if (seen.has(coverageKey)) continue;
          seen.add(coverageKey);
          const started = performance.now();
          try {
            assignSafeValue(element);
            if (attr === 'data-action') element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            else if (attr === 'data-input-action') element.dispatchEvent(new Event('input', { bubbles: true }));
            else if (attr === 'data-change-action') element.dispatchEvent(new Event('change', { bubbles: true }));
            else if (attr === 'data-submit-action') element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await twoFrames();
            results.push({ key: coverageKey, durationMs: performance.now() - started, ok: true });
          } catch (error) {
            results.push({ key: coverageKey, durationMs: performance.now() - started, ok: false, error: String(error?.message || error) });
          }
        }
      }
      for (const id of directIds) {
        const element = document.getElementById(id);
        const started = performance.now();
        if (!element) {
          results.push({ key: 'direct:' + id, durationMs: 0, ok: false, error: 'missing control' });
          continue;
        }
        try {
          assignSafeValue(element);
          if (element.tagName === 'FORM') element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          else if (element.tagName === 'INPUT' || element.tagName === 'SELECT') {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          } else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await twoFrames();
          results.push({ key: 'direct:' + id, durationMs: performance.now() - started, ok: true });
        } catch (error) {
          results.push({ key: 'direct:' + id, durationMs: performance.now() - started, ok: false, error: String(error?.message || error) });
        }
      }
      return results;
    })()
  `);

  // Dynamic market actions above deliberately create switch churn. Restore the
  // final ownership in two serial steps so a trailing cancelled request cannot
  // race the timeframe selection.
  await sleep(500);
  await evaluate(`window.switchCoin('BTC')`);
  await waitFor(`(() => { const debug = window.getChartDebugState?.(); return debug?.selection?.coin === 'BTC' && debug?.selection?.chartSession?.coin === 'BTC' && debug?.selection?.chartSession?.status === 'ready' && debug?.exchangeCandleCount > 0; })()`, 30_000);
  await evaluate(`([...document.querySelectorAll('.tf-group button')].find((node) => node.textContent.trim() === '2h'))?.click()`);
  await waitFor(`(() => { const debug = window.getChartDebugState?.(); return debug?.selection?.coin === 'BTC' && debug?.selection?.timeframe === '2h' && debug?.selection?.chartSession?.coin === 'BTC' && debug?.selection?.chartSession?.timeframe === '2h' && debug?.selection?.chartSession?.status === 'ready' && debug?.exchangeCandleCount > 0; })()`, 30_000);

  let soak = null;
  if (SOAK_MS > 0) {
    const soakBaseline = await browserMetrics();
    const soakActions = await evaluate(`
      (async () => {
        const deadline = performance.now() + ${SOAK_MS};
        const views = ['chart', 'book', 'news', 'trade', 'account'];
        const tabs = ['orders', 'trades', 'fills', 'positions'];
        let actions = 0;
        while (performance.now() < deadline) {
          const view = views[actions % views.length];
          document.querySelector('.mobile-dock-btn[data-arg="' + view + '"]')?.click();
          document.querySelector('.bottom-tab[data-tab="' + tabs[actions % tabs.length] + '"]')?.click();
          actions += 2;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return actions;
      })()
    `);
    await cdp.call('HeapProfiler.collectGarbage').catch(() => {});
    const soakFinal = await browserMetrics();
    const growth = (before, after) => before > 0 ? ((after - before) / before) * 100 : 0;
    soak = {
      durationMs: SOAK_MS,
      actions: soakActions,
      baseline: soakBaseline,
      final: soakFinal,
      growthPct: {
        nodes: growth(soakBaseline.nodes, soakFinal.nodes),
        listeners: growth(soakBaseline.listeners, soakFinal.listeners),
        heapUsed: growth(soakBaseline.heapUsed, soakFinal.heapUsed),
        documents: growth(soakBaseline.documents, soakFinal.documents),
      },
    };
    for (const [name, value] of Object.entries(soak.growthPct)) {
      if (value > 10) failures.push(`soak ${name} growth ${value.toFixed(2)}% > 10%`);
    }
  }

  const finalMetrics = await browserMetrics();

  const pageState = await evaluate(`
    (() => {
      const navigation = performance.getEntriesByType('navigation')[0] || {};
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime]));
      const debug = window.getChartDebugState?.() || {};
      return {
        navigation: {
          domInteractiveMs: navigation.domInteractive || 0,
          domContentLoadedMs: navigation.domContentLoadedEventEnd || 0,
          loadMs: navigation.loadEventEnd || 0,
          observedReadyMs: ${Date.now()} - ${loadStartedAt},
        },
        paints,
        actionKeys: [...new Set(window.__pezPerfAudit?.actionKeys || [])].sort(),
        longTasks: window.__pezPerfAudit?.longTasks || [],
        dom: {
          nodes: ${finalMetrics.nodes},
          listeners: ${finalMetrics.listeners},
        },
        heapUsed: ${finalMetrics.heapUsed},
        chart: {
          candleCount: debug.exchangeCandleCount || 0,
          invalid: debug.canonicalInvalidCount || 0,
          duplicates: debug.canonicalDuplicateCount || 0,
          outOfOrder: debug.canonicalOutOfOrderCount || 0,
          rejectedUpdates: debug.rejectedUpdateCount || 0,
          setDataCount: debug.setDataCount || 0,
          updateCount: debug.updateCount || 0,
        },
        chartPhases: window.__PEZ_CHART_PHASES__ || [],
        transportMetrics: window.transportMetrics || null,
      };
    })()
  `);

  const grouped = {};
  for (const sample of [...desktop, ...mobile]) {
    (grouped[sample.name] ||= []).push(sample);
    if (!sample.ok) failures.push(`${sample.name}: state assertion failed`);
  }
  const latency = Object.fromEntries(Object.entries(grouped).map(([name, samples]) => [name, summarizeSamples(samples)]));
  for (const [name, stats] of Object.entries(latency)) {
    if (stats.p95Ms > LOCAL_P95_BUDGET_MS) failures.push(`${name}: p95 ${stats.p95Ms}ms > ${LOCAL_P95_BUDGET_MS}ms`);
    if (stats.maxMs > LOCAL_MAX_BUDGET_MS) failures.push(`${name}: max ${stats.maxMs}ms > ${LOCAL_MAX_BUDGET_MS}ms`);
  }

  const warmSymbolCommits = symbolSwitches.filter((sample) => sample.ready && sample.cycle > 0).map((sample) => ({ durationMs: sample.commitMs }));
  const warmSymbolReady = symbolSwitches.filter((sample) => sample.ready && sample.cycle > 0).map((sample) => ({ durationMs: sample.readyMs }));
  const symbolCommitStats = summarizeSamples(warmSymbolCommits);
  const symbolReadyStats = summarizeSamples(warmSymbolReady);
  if (symbolCommitStats.count >= 20 && symbolCommitStats.p95Ms > WARM_COMMIT_P95_BUDGET_MS) failures.push(`symbol commit p95 ${symbolCommitStats.p95Ms}ms`);
  if (symbolReadyStats.count >= 20 && symbolReadyStats.p95Ms > WARM_READY_P95_BUDGET_MS) failures.push(`symbol ready p95 ${symbolReadyStats.p95Ms}ms`);

  for (const sample of [...symbolSwitches, ...timeframeSwitches]) {
    if (!sample.ready) {
      failures.push(`${sample.coin || sample.value}: chart did not become ready within 10s`);
      const expectedCoin = sample.coin || 'BTC';
      const expectedTimeframe = sample.value || sample.selection?.timeframe;
      const ownsTarget = sample.selection?.coin === expectedCoin
        && (!expectedTimeframe || sample.selection?.timeframe === expectedTimeframe)
        && sample.selection?.chartSession?.coin === expectedCoin
        && (!expectedTimeframe || sample.selection?.chartSession?.timeframe === expectedTimeframe);
      if (!ownsTarget) failures.push(`${sample.coin || sample.value}: stale chart ownership`);
    }
    if (sample.invalid || sample.duplicates || sample.outOfOrder || sample.rejectedUpdates) {
      failures.push(`${sample.coin || sample.value}: candle/chart integrity failed`);
    }
  }
  for (const sample of exhaustive) {
    if (!sample.ok) failures.push(`${sample.key}: ${sample.error || 'control missing'}`);
  }

  const expectedVariants = expectedStaticVariantKeys();
  const exercised = new Set(pageState.actionKeys);
  for (const key of expectedVariants) {
    if (!exercised.has(key)) failures.push(`${key}: action was not exercised`);
  }
  if (pageState.longTasks.some((entry) => entry.duration > 50)) failures.push('main-thread long task exceeded 50ms');
  if (pageState.chart.invalid || pageState.chart.duplicates || pageState.chart.outOfOrder || pageState.chart.rejectedUpdates) {
    failures.push('final chart integrity failed');
  }
  if (runtimeErrors.length) failures.push(`${runtimeErrors.length} runtime exception(s)`);
  if (failedResponses.length) failures.push(`${failedResponses.length} failed non-mutation response(s)`);

  const report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    appUrl: APP_URL,
    iterations: ITERATIONS,
    soak,
    browserMetrics: { baseline: baselineMetrics, final: finalMetrics },
    budgets: {
      localP95Ms: LOCAL_P95_BUDGET_MS,
      localMaxMs: LOCAL_MAX_BUDGET_MS,
      warmCommitP95Ms: WARM_COMMIT_P95_BUDGET_MS,
      warmReadyP95Ms: WARM_READY_P95_BUDGET_MS,
    },
    coverage: {
      expectedStaticVariants: expectedVariants.length,
      exercisedStaticVariants: expectedVariants.filter((key) => exercised.has(key)).length,
      dynamicActions: DYNAMIC_ACTIONS,
      directControls: DIRECT_CONTROL_IDS.length,
    },
    latency,
    symbolCommit: symbolCommitStats,
    symbolReady: symbolReadyStats,
    symbolSwitches,
    timeframeSwitches,
    pageState,
    interceptedMutations,
    runtimeErrors,
    consoleErrors,
    failedResponses,
    failures,
  };

  if (REPORT_DIR) {
    const directory = resolve(REPORT_DIR);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'ui-performance.json'), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = [
      '# PEZ UI performance report',
      '',
      `- Result: **${report.ok ? 'PASS' : 'FAIL'}**`,
      `- Static action coverage: ${report.coverage.exercisedStaticVariants}/${report.coverage.expectedStaticVariants}`,
      `- Iterations: ${ITERATIONS}`,
      `- Runtime errors: ${runtimeErrors.length}`,
      `- Intercepted mutation requests: ${interceptedMutations.length}`,
      '',
      '## Latency',
      '',
      '| Interaction | p50 | p95 | max |',
      '|---|---:|---:|---:|',
      ...Object.entries(latency).map(([name, stats]) => `| ${name} | ${stats.p50Ms}ms | ${stats.p95Ms}ms | ${stats.maxMs}ms |`),
      '',
      '## Failures',
      '',
      ...(failures.length ? failures.map((failure) => `- ${failure}`) : ['- None']),
      '',
    ].join('\n');
    await writeFile(resolve(directory, 'ui-performance.md'), markdown);
  }

  console.log(JSON.stringify(report, null, 2));
  await cdp.call('Page.close').catch(() => {});
  cdp.socket.close();
  activeCdp = null;
  await cdpLifecycle.cleanup().catch(() => {});
  if (!report.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  activeCdp?.call('Page.close').catch(() => {});
  activeCdp?.socket?.close();
  await cdpLifecycle.cleanup().catch(() => {});
  process.exit(1);
});
