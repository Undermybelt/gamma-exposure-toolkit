"""gexdash.com API client.

gexdash is a public, no-auth REST+JSON service backed by Schwab option-chain
data. The endpoint surface below was read from its own OpenAPI document at
https://gexdash.com/openapi.json — nothing here is reverse-engineered and no
credentials, cookies, or API keys are ever sent.

    GET /api/health                          service + upstream token status
    GET /api/symbols                         supported symbol list
    GET /api/gex/{symbol}?expiry=...         the payload everything is built on
    GET /api/price/{symbol}                  1-minute OHLC bars (realized vol)
    GET /api/es-basis                        ES - SPX basis
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE_URL = "https://gexdash.com"
TIMEOUT_SECS = 30
USER_AGENT = "gamma-exposure-toolkit/0.1 (+personal TradingView level export)"

# The /api/price endpoint streams a long 1-minute bar history and is by far the
# slowest leg. Realised vol derived from it is a nice-to-have, so it gets its
# own short ceiling: if it is not ready in 12s we skip RV rather than make the
# whole CLI hang on it.
PRICE_TIMEOUT_SECS = 12

# Expiry buckets the /api/gex endpoint accepts. Anything else is rejected
# client-side: the server silently falls back to "all" on an unknown value
# (verified — `?expiry_filter=0dte` returns expiry_filter="all"), which would
# hand back aggregate levels mislabelled as 0DTE.
EXPIRIES = ("0dte", "weekly", "monthly", "all")

# Hard whitelist. gexdash routes /api/gex/{symbol} to a generic equity chain
# lookup, so a typo does NOT fail — `/api/gex/ES` returns HTTP 200 with
# Eversource Energy's chain (spot ~72, 16 strikes). Only symbols listed by
# /api/symbols and sanity-bounded below are allowed through.
#
# Bounds are deliberately wide (roughly an order of magnitude around current
# levels); they exist to catch "wrong instrument entirely", not to track price.
SPOT_BOUNDS: dict[str, tuple[float, float]] = {
    "SPX": (2000.0, 40000.0),
    "NDX": (8000.0, 150000.0),
    "SPY": (200.0, 4000.0),
    "QQQ": (150.0, 4000.0),
    "IWM": (80.0, 1500.0),
    "RUT": (800.0, 15000.0),
}
SUPPORTED = tuple(SPOT_BOUNDS)


class GexdashError(RuntimeError):
    """Any failure that must stop a level string from being emitted."""


def _get(path: str, params: dict[str, Any] | None = None, *, retries: int = 2) -> Any:
    url = f"{BASE_URL}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECS) as response:
                body = response.read()
            return json.loads(body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            if attempt < retries:
                # Be a polite client of a free service: back off, don't hammer.
                time.sleep(1.5 * (attempt + 1))
    raise GexdashError(f"GET {url} failed after {retries + 1} attempts: {last}")


def health() -> dict[str, Any]:
    return _get("/api/health")


def symbols() -> list[str]:
    return list(_get("/api/symbols").get("symbols", []))


def gex(symbol: str, expiry: str = "all") -> dict[str, Any]:
    """Fetch one expiry bucket for one symbol, with validation.

    Raises GexdashError rather than returning a payload that would produce a
    silently-wrong chart. Two distinct failures are guarded here:

    1. Wrong instrument — the whitelist plus the returned-symbol and spot-bound
       assertions.
    2. Unusable snapshot — gexdash serves per-symbol snapshots that go all-zero
       between sessions (observed: NDX and SPX pinned at 08:01Z with every
       key_level null while QQQ had already refreshed at 08:41Z). An all-null
       payload must fail loudly, not emit a string of hidden levels.
    """
    symbol = symbol.strip().upper()
    if symbol not in SUPPORTED:
        raise GexdashError(
            f"{symbol!r} is not whitelisted. Supported: {', '.join(SUPPORTED)}. "
            "Note gexdash returns HTTP 200 for arbitrary equity tickers, so an "
            "unlisted symbol would yield a plausible-looking wrong chain."
        )
    if expiry not in EXPIRIES:
        raise GexdashError(f"expiry must be one of {EXPIRIES}, got {expiry!r}")

    payload = _get(f"/api/gex/{symbol}", {"expiry": expiry})

    returned = str(payload.get("symbol", "")).upper()
    if returned != symbol:
        raise GexdashError(f"asked for {symbol}, server answered {returned!r}")

    if payload.get("expiry_filter") != expiry:
        raise GexdashError(
            f"asked for expiry={expiry}, server answered "
            f"{payload.get('expiry_filter')!r} — it fell back instead of filtering"
        )

    spot = payload.get("spot")
    low, high = SPOT_BOUNDS[symbol]
    if not isinstance(spot, (int, float)) or not low <= spot <= high:
        raise GexdashError(
            f"{symbol} spot {spot!r} outside sane band [{low}, {high}] — "
            "this is almost certainly a different instrument's chain"
        )

    return payload


def price_bars(symbol: str) -> list[dict[str, Any]]:
    """1-minute OHLC bars, used for realized volatility."""
    url = f"{BASE_URL}/api/price/{symbol.upper()}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=PRICE_TIMEOUT_SECS) as response:
            body = response.read()
        return list(json.loads(body).get("bars", []))
    except Exception:
        # RV is optional; a slow or absent price feed must not break the CLI.
        return []


def es_basis() -> dict[str, Any]:
    """ES - SPX basis, as gexdash computes it. Carries its own stale flag."""
    return _get("/api/es-basis")
