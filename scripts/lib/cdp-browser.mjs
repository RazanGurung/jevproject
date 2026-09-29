#!/usr/bin/env node
// Shared Opera/Chromium CDP bootstrap for smoke harnesses.
// If 127.0.0.1:9222 (or PEZ_CDP_URL) is already serving DevTools, use it.
// Otherwise launch Opera (then Chrome/Chromium) with an isolated profile.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveCdpUrl() {
  if (process.env.PEZ_CDP_URL === '') return '';
  return process.env.PEZ_CDP_URL || DEFAULT_CDP_URL;
}

export function browserCandidates() {
  return [
    process.env.PEZ_BROWSER,
    '/Applications/Opera.app/Contents/MacOS/Opera',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((path) => path && existsSync(path));
}

async function cdpVersion(url, timeoutMs = 800) {
  const response = await fetch(`${String(url).replace(/\/$/, '')}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`CDP version ${response.status}`);
  return response.json();
}

function parseCdpTarget(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port) || 9222,
    };
  } catch {
    return { host: '127.0.0.1', port: 9222 };
  }
}

async function cleanupLaunch(child, profile) {
  if (child?.pid && !child.killed) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(400);
  if (child?.pid) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}

export async function ensureCdpEndpoint(cdpUrl, { timeoutMs = 25000 } = {}) {
  const noop = { url: cdpUrl || '', launched: false, cleanup: async () => {} };
  if (!cdpUrl) return noop;

  try {
    await cdpVersion(cdpUrl);
    return noop;
  } catch {
    // Launch below unless the operator forbade it.
  }

  if (/^(1|true)$/i.test(process.env.PEZ_CDP_NO_LAUNCH || '')) {
    throw new Error(`CDP not reachable at ${cdpUrl} (PEZ_CDP_NO_LAUNCH=1)`);
  }

  const binary = browserCandidates()[0];
  if (!binary) {
    throw new Error(
      `CDP not reachable at ${cdpUrl} and no Opera/Chrome binary found. `
      + 'Start one with --remote-debugging-port=9222 or set PEZ_BROWSER.',
    );
  }

  const { host, port } = parseCdpTarget(cdpUrl);
  const profile = await mkdtemp(join(tmpdir(), 'pez-opera-smoke-'));
  const child = spawn(binary, [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
    '--remote-allow-origins=*',
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: false,
  });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanupLaunch(child, profile);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      await cleanup();
      throw new Error(`${binary} exited ${child.exitCode} before CDP became ready at ${cdpUrl}`);
    }
    try {
      await cdpVersion(cdpUrl);
      return { url: cdpUrl, launched: true, cleanup, binary, profile };
    } catch {
      await sleep(200);
    }
  }
  await cleanup();
  throw new Error(`CDP did not become ready at ${cdpUrl} within ${timeoutMs}ms after launching ${binary}`);
}
