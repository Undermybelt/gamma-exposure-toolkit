"""Emit the compact level string the Pine indicator parses.

Wire format — an extension of the `price,label,kind;...` scheme used by the
"GEX Daily Levels" script, with an added metadata header and expiry-suffixed
kinds so 0DTE / weekly / monthly walls coexist on one chart:

    M:key=value,key=value|L:price,label,kind;price,label,kind;...

Kind codes are `base` + expiry suffix, where the suffix is `0` (0DTE), `w`
(weekly), `m` (monthly), or empty (all expiries combined). Base names are
deliberately chosen so none ends in `0`/`w`/`m`, so the Pine parser can strip
the suffix by testing the last character alone:

    res / sup      call wall / put wall        (res0, resw, resm, res)
    flip           gamma flip                  (flip0, flipw, flipm, flip)
    gwall          gamma wall                  (gwall0, gwallw, gwallm, gwall)
    vtrig          vol trigger
    hgex           dominant absolute-gamma strike
    gpos / gneg    most positive / negative net-GEX strike

Expiry-independent kinds carry no suffix:

    mpain          max pain, computed here from open interest
    oic / oip      largest call-OI / put-OI strike
    oimax          largest total-OI strike
    emh / eml      expected-move band from spot
    ivh / ivl      1-day implied range from ATM IV

Prices are absolute levels in the symbol's own units. There is no scaling and
no basis shift: gexdash serves SPX, NDX, QQQ, SPY and IWM as independent
option chains, so each symbol's string is charted on that same symbol.
"""

from __future__ import annotations

import math

from .snapshot import Snapshot

SUFFIX = {"0dte": "0", "weekly": "w", "monthly": "m", "all": ""}
TAG = {"0dte": "0DTE", "weekly": "W", "monthly": "M", "all": "ALL"}

# Which per-bucket levels are emitted, as (attribute, base kind, label stem).
# Base kinds never end in 0/w/m so the Pine parser can strip the suffix by
# testing the last character alone.
BUCKET_LEVELS = (
    ("call_wall", "res", "CW"),
    ("put_wall", "sup", "PW"),
    ("gex_flip", "flip", "FLIP"),
    ("gamma_wall", "gwall", "GW"),
    ("vol_trigger", "vtrig", "VT"),
    ("hgex", "hgex", "HGEX"),
    ("gpos", "gpos", "G+"),
    ("gneg", "gneg", "G-"),
)


def _fmt(price: float, symbol: str) -> str:
    """Two decimals for ETFs, whole points for the big indices."""
    return f"{price:.2f}" if symbol in ("QQQ", "SPY", "IWM") else f"{price:.0f}"


def _compact(value: float) -> str:
    """Human-scale a GEX total: 1.54B / -223M / 12.4K."""
    magnitude = abs(value)
    for divisor, unit in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if magnitude >= divisor:
            return f"{value / divisor:.2f}{unit}"
    return f"{value:.0f}"


def emit(
    snapshot: Snapshot,
    *,
    buckets: tuple[str, ...] = ("0dte", "weekly", "monthly", "all"),
    include_oi: bool = True,
    include_bands: bool = True,
) -> str:
    reference = snapshot.buckets.get("all") or next(iter(snapshot.buckets.values()))

    meta = [
        f"sym={snapshot.symbol}",
        f"spot={_fmt(snapshot.spot, snapshot.symbol)}",
        f"state={snapshot.market_state}",
        f"basis={snapshot.session_basis}",
        f"asof={snapshot.updated_at}",
        f"src={snapshot.data_source or 'unknown'}",
        f"ng={_compact(reference.total_gex)}",
        f"iv={reference.atm_iv:.2f}",
    ]
    if snapshot.realized_vol is not None:
        meta.append(f"rv={snapshot.realized_vol:.2f}")
    if reference.oi_pc_ratio is not None:
        meta.append(f"oipc={reference.oi_pc_ratio}")
    # gexdash's own pc_ratio is flow-weighted and goes out of range between
    # sessions (observed -39.79 on a premarket QQQ snapshot). Only pass it
    # through when it is a plausible ratio; `oipc` above is the durable one.
    if 0.0 < reference.pc_ratio < 20.0:
        meta.append(f"pcr={reference.pc_ratio:.2f}")
    for expiry in buckets:
        bucket = snapshot.buckets.get(expiry)
        if bucket and bucket.usable:
            meta.append(f"ng{SUFFIX[expiry] or 'a'}={_compact(bucket.total_gex)}")

    levels: list[str] = []

    def push(price: float | None, label: str, kind: str) -> None:
        # A level at or below zero is a parse artefact, never a real strike.
        if price is None or not math.isfinite(price) or price <= 0:
            return
        levels.append(f"{_fmt(price, snapshot.symbol)},{label},{kind}")

    for expiry in buckets:
        bucket = snapshot.buckets.get(expiry)
        if bucket is None or not bucket.usable:
            continue
        suffix, tag = SUFFIX[expiry], TAG[expiry]
        for attribute, base, stem in BUCKET_LEVELS:
            push(getattr(bucket, attribute), f"{stem} {tag}", f"{base}{suffix}")

    if include_oi:
        push(reference.max_pain, "MaxPain", "mpain")
        push(reference.call_oi_wall, "CallOI", "oic")
        push(reference.put_oi_wall, "PutOI", "oip")
        push(reference.total_oi_wall, "OI Max", "oimax")

    if include_bands:
        move = reference.expected_move
        if move:
            push(snapshot.spot + move, "EM High", "emh")
            push(snapshot.spot - move, "EM Low", "eml")
        if reference.atm_iv > 0:
            # 1-day 1-sigma range from annualised ATM IV, 252 trading days.
            daily = snapshot.spot * (reference.atm_iv / 100.0) / math.sqrt(252.0)
            push(snapshot.spot + daily, "IV High", "ivh")
            push(snapshot.spot - daily, "IV Low", "ivl")

    return "M:" + ",".join(meta) + "|L:" + ";".join(levels)
