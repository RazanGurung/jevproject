"""HTTP clients for the CVD validation harness.

Stdlib-only. Two data planes:
  - Hyperliquid mainnet info endpoint (ground truth, no auth).
  - The local pez server's /api/hl proxy (what the frontend actually sees,
    including the server-computed cvdDelta when the candle store is warm).

Mainnet notes mirrored from the Go server:
  - candleSnapshot responses are capped at ~5000 candles and truncate the
    HEAD of the range, so requests are chunked to stay under the cap
    (cmd/server/main.go upstreamCandleCap).
  - request weight ~= 20 + candles/60 (candlecache/store.go
    passthroughCandleWeight); the shared per-IP budget is ~1200/min and the
    running app is using the same IP, so the harness keeps a conservative
    budget of its own.
"""

import json
import time
import urllib.error
import urllib.request

MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info"
STORE_HEADER = "X-PEZ-Candle-Store"
CHUNK_CANDLES = 4500

INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
    "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
    "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000,
}


class WeightBudget:
    """Sliding one-minute upstream weight budget."""

    def __init__(self, max_per_min):
        self.max_per_min = max(1, int(max_per_min))
        self.events = []  # (timestamp, weight)

    def spend(self, weight):
        now = time.monotonic()
        self.events = [(t, w) for t, w in self.events if now - t < 60]
        used = sum(w for _, w in self.events)
        if used + weight > self.max_per_min and self.events:
            wait = 60 - (now - self.events[0][0]) + 0.1
            if wait > 0:
                time.sleep(wait)
            self.events = [(t, w) for t, w in self.events
                           if time.monotonic() - t < 60]
        self.events.append((time.monotonic(), weight))


def _post_json(url, body, headers=None, timeout=30, retries=4):
    """POST JSON with exponential backoff on 429/5xx/network errors.

    Returns (decoded_json, response_headers).
    """
    payload = json.dumps(body).encode()
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                # resp.headers is an HTTPMessage: .get() is case-insensitive
                # (Go canonicalizes X-PEZ-Candle-Store to X-Pez-Candle-Store).
                return json.loads(resp.read().decode()), resp.headers
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"POST {url} failed after {retries} attempts: {last_err}")


class MainnetClient:
    """Ground-truth candle fetches against the public mainnet info endpoint."""

    def __init__(self, budget=None, url=MAINNET_INFO_URL):
        self.url = url
        self.budget = budget or WeightBudget(300)

    def info(self, body, expected_candles=0):
        self.budget.spend(20 + expected_candles // 60)
        data, _ = _post_json(self.url, body)
        return data

    def candles(self, coin, interval, start_ms, end_ms):
        """Fetch [start_ms, end_ms) candles, chunked under the upstream cap."""
        step = INTERVAL_MS[interval]
        out = {}
        chunk_ms = CHUNK_CANDLES * step
        t = start_ms
        while t < end_ms:
            chunk_end = min(t + chunk_ms, end_ms)
            expected = (chunk_end - t) // step
            batch = self.info({
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval,
                        "startTime": t, "endTime": chunk_end},
            }, expected_candles=expected)
            for c in batch or []:
                out[int(c["t"])] = c
            t = chunk_end
        return [out[t] for t in sorted(out)]


class LocalClient:
    """Fetches through the local pez server's /api/hl proxy.

    Store-served responses carry the X-PEZ-Candle-Store header and cvdDelta
    on the candles; a passthrough response has neither and must not be
    scored as an enrichment failure. A passthrough itself kicks the server's
    WarmOnDemand, so retrying after a wait usually lands on the store.
    """

    def __init__(self, base_url, api_token=None, warm_retries=3,
                 warm_wait_s=45):
        self.url = base_url.rstrip("/") + "/api/hl"
        self.headers = {}
        if api_token:
            self.headers["Authorization"] = f"Bearer {api_token}"
        self.warm_retries = warm_retries
        self.warm_wait_s = warm_wait_s

    def candles(self, coin, interval, start_ms, end_ms, warm_retries=None):
        """Returns (candles, store_served: bool). Retries until store-warm.

        ``warm_retries`` lets the runner avoid multiplying a full source-warm
        wait across every display timeframe after readiness has already been
        established.  The client default remains the documented cold-store
        retry behavior.
        """
        body = {"type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval,
                        "startTime": start_ms, "endTime": end_ms}}
        retries = self.warm_retries if warm_retries is None else max(
            1, int(warm_retries))
        for attempt in range(retries):
            data, headers = _post_json(self.url, body, headers=self.headers)
            if headers.get(STORE_HEADER) == "1":
                return data or [], True
            if attempt < retries - 1:
                time.sleep(self.warm_wait_s)
        return data or [], False
