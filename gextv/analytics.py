"""Derived metrics computed locally from the gexdash per-strike array.

Everything here is arithmetic over data gexdash actually returns. Fields that
some Pine formats want but gexdash does not provide — notably the "Hold: 80% |
Break: 20%" probabilities in the TLADe scripts — are deliberately absent rather
than invented, because a fabricated confidence number is the one output a
trader would act on and could not audit.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

Strike = dict[str, Any]


def _f(row: Strike, key: str) -> float:
    value = row.get(key)
    return float(value) if isinstance(value, (int, float)) else 0.0


def max_pain(strikes: Iterable[Strike]) -> float | None:
    """Strike minimising total option-holder payout at expiry.

    pain(K) = Σ_S call_oi(S)·max(0, K−S) + put_oi(S)·max(0, S−K)

    Computed from open interest, which gexdash provides per strike; gexdash
    itself exposes no max-pain field. O(n²) over ~250-400 strikes is trivial.
    """
    rows = [row for row in strikes if _f(row, "call_oi") or _f(row, "put_oi")]
    if len(rows) < 3:
        return None
    best_strike: float | None = None
    best_pain = math.inf
    for candidate in rows:
        k = _f(candidate, "strike")
        pain = 0.0
        for row in rows:
            s = _f(row, "strike")
            if k > s:
                pain += _f(row, "call_oi") * (k - s)
            elif s > k:
                pain += _f(row, "put_oi") * (s - k)
        if pain < best_pain:
            best_pain = pain
            best_strike = k
    return best_strike


def oi_walls(strikes: Iterable[Strike]) -> dict[str, float | None]:
    """Largest open-interest strikes.

    These are positioning walls, distinct from the gamma walls: OI says where
    contracts are parked, GEX says where dealer hedging pressure concentrates.
    They often disagree, and the disagreement is the informative part.
    """
    rows = list(strikes)
    if not rows:
        return {"call_oi_wall": None, "put_oi_wall": None, "total_oi_wall": None}
    call = max(rows, key=lambda r: _f(r, "call_oi"))
    put = max(rows, key=lambda r: _f(r, "put_oi"))
    total = max(rows, key=lambda r: _f(r, "call_oi") + _f(r, "put_oi"))
    return {
        "call_oi_wall": _f(call, "strike") if _f(call, "call_oi") else None,
        "put_oi_wall": _f(put, "strike") if _f(put, "put_oi") else None,
        "total_oi_wall": _f(total, "strike")
        if (_f(total, "call_oi") + _f(total, "put_oi"))
        else None,
    }


def gamma_extremes(strikes: Iterable[Strike]) -> dict[str, float | None]:
    """Most positive / most negative / largest-absolute net-GEX strikes."""
    rows = [row for row in strikes if _f(row, "net_gex")]
    if not rows:
        return {"gpos": None, "gneg": None, "hgex": None}
    positive = max(rows, key=lambda r: _f(r, "net_gex"))
    negative = min(rows, key=lambda r: _f(r, "net_gex"))
    absolute = max(rows, key=lambda r: abs(_f(r, "net_gex")))
    return {
        "gpos": _f(positive, "strike") if _f(positive, "net_gex") > 0 else None,
        "gneg": _f(negative, "strike") if _f(negative, "net_gex") < 0 else None,
        "hgex": _f(absolute, "strike"),
    }


def oi_pc_ratio(strikes: Iterable[Strike]) -> float | None:
    """Put/call ratio by open interest.

    gexdash's own `pc_ratio` is volume/premium-weighted and reads 0.0 outside
    the session; the OI-based ratio survives the close, so the two are reported
    side by side rather than one overwriting the other.
    """
    calls = sum(_f(row, "call_oi") for row in strikes)
    puts = sum(_f(row, "put_oi") for row in strikes)
    return round(puts / calls, 3) if calls else None


def realized_vol(bars: list[dict[str, Any]], *, minutes_per_year: int = 252 * 390) -> float | None:
    """Annualised realised volatility (%) from 1-minute closes.

    Used only to fill the `rv` field the SYNC&TRADE panel expects; gexdash
    returns implied vol (`atm_iv`) but no realised counterpart.
    """
    closes = [float(bar["close"]) for bar in bars if bar.get("close")]
    if len(closes) < 30:
        return None
    returns = [
        math.log(curr / prev)
        for prev, curr in zip(closes, closes[1:])
        if prev > 0 and curr > 0
    ]
    if len(returns) < 30:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return round(math.sqrt(variance) * math.sqrt(minutes_per_year) * 100.0, 2)
