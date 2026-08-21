"""Normalised multi-expiry snapshot — the single intermediate every emitter reads."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import analytics, client

BUCKETS = ("0dte", "weekly", "monthly", "all")


@dataclass
class Bucket:
    """One expiry bucket's levels and totals."""

    expiry: str
    call_wall: float | None
    put_wall: float | None
    gamma_wall: float | None
    gex_flip: float | None
    vol_trigger: float | None
    abs_gamma: float | None
    total_gex: float
    pc_ratio: float
    atm_iv: float
    expected_move: float | None
    max_pain: float | None
    oi_pc_ratio: float | None
    call_oi_wall: float | None
    put_oi_wall: float | None
    total_oi_wall: float | None
    gpos: float | None
    gneg: float | None
    hgex: float | None

    @property
    def usable(self) -> bool:
        """True when at least one dealer-gamma level actually resolved.

        A bucket where every key level is null is a between-sessions husk, not
        a flat market: emitting it would render as "no levels" on the chart and
        read as information rather than as absence of data.
        """
        return any(
            value is not None
            for value in (
                self.call_wall,
                self.put_wall,
                self.gex_flip,
                self.gamma_wall,
                self.hgex,
            )
        )


@dataclass
class Snapshot:
    symbol: str
    spot: float
    market_state: str
    updated_at: str
    data_source: str | None
    realized_vol: float | None
    buckets: dict[str, Bucket] = field(default_factory=dict)

    @property
    def session_basis(self) -> str:
        """Which session the numbers describe.

        gexdash always serves its most recent snapshot. During RTH that is
        today's live chain; outside RTH it is the previous close, carried
        forward. `market_state` is the server's own label, and it is stamped
        into every emitted string so a stale paste is visible on the chart
        rather than being mistaken for live positioning.
        """
        return "today-live" if self.market_state in ("open", "regular") else "prior-close"

    @property
    def age_minutes(self) -> float | None:
        try:
            stamp = datetime.fromisoformat(self.updated_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return None
        return round((datetime.now(timezone.utc) - stamp).total_seconds() / 60.0, 1)


def _bucket_from_payload(expiry: str, payload: dict[str, Any]) -> Bucket:
    levels = payload.get("key_levels") or {}
    strikes = payload.get("strikes") or []
    extremes = analytics.gamma_extremes(strikes)
    walls = analytics.oi_walls(strikes)
    return Bucket(
        expiry=expiry,
        call_wall=levels.get("call_wall"),
        put_wall=levels.get("put_wall"),
        gamma_wall=levels.get("gamma_wall"),
        gex_flip=levels.get("gex_flip") or payload.get("gamma_flip"),
        vol_trigger=levels.get("vol_trigger"),
        abs_gamma=levels.get("abs_gamma"),
        total_gex=float(payload.get("total_gex") or 0.0),
        pc_ratio=float(payload.get("pc_ratio") or 0.0),
        atm_iv=float(payload.get("atm_iv") or 0.0),
        expected_move=payload.get("expected_move"),
        max_pain=analytics.max_pain(strikes),
        oi_pc_ratio=analytics.oi_pc_ratio(strikes),
        call_oi_wall=walls["call_oi_wall"],
        put_oi_wall=walls["put_oi_wall"],
        total_oi_wall=walls["total_oi_wall"],
        gpos=extremes["gpos"],
        gneg=extremes["gneg"],
        hgex=extremes["hgex"],
    )


def fetch(symbol: str, *, buckets: tuple[str, ...] = BUCKETS, with_rv: bool = True) -> Snapshot:
    """Fetch every expiry bucket for one symbol and normalise it.

    Raises GexdashError when no bucket is usable — better a loud failure than a
    level string that quietly renders an empty chart.
    """
    symbol = symbol.strip().upper()
    health = client.health()
    payloads = {expiry: client.gex(symbol, expiry) for expiry in buckets}
    reference = payloads.get("all") or next(iter(payloads.values()))

    realized = None
    if with_rv:
        try:
            # RV is a nice-to-have: never block a fetch or drag the whole CLI on
            # it. The /api/price endpoint is the slowest leg (it streams a long
            # 1-minute bar history), so fetch it with a short timeout and treat
            # any failure as "no RV this time".
            realized = analytics.realized_vol(
                client.price_bars(symbol), minutes_per_year=252 * 390
            )
        except Exception:
            realized = None

    snapshot = Snapshot(
        symbol=symbol,
        spot=float(reference["spot"]),
        market_state=str(reference.get("market_state") or "unknown"),
        updated_at=str(reference.get("updated_at") or ""),
        data_source=health.get("data_source"),
        realized_vol=realized,
        buckets={
            expiry: _bucket_from_payload(expiry, payload)
            for expiry, payload in payloads.items()
        },
    )

    if not any(bucket.usable for bucket in snapshot.buckets.values()):
        raise client.GexdashError(
            f"{symbol}: every expiry bucket came back with null key levels "
            f"(snapshot {snapshot.updated_at}, state {snapshot.market_state}). "
            "gexdash has not refreshed this symbol yet — refusing to emit a "
            "string that would render as an empty chart."
        )
    return snapshot
