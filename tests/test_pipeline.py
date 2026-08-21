"""Tests for the gextv pipeline.

These run without network: they build synthetic gexdash payloads and assert
that analytics, the emitter, and a Python re-implementation of the Pine parser
agree. The Pine/Python parsing contract is the thing most likely to silently
break (a renamed kind suffix, a changed separator), so it gets the most
coverage.

Run with:  python3 -m unittest tests.test_pipeline -v
"""

from __future__ import annotations

import math
import unittest

from gextv import analytics, emit, snapshot


# ── Synthetic per-strike rows. ────────────────────────────────────────────
# Calls are split across 100 and 102; puts are concentrated at 104. That makes
# K=104 the unambiguous max-pain strike: there it is the only one where calls
# are out of the money and puts are not, so total holder payout is minimised.
# K=102 is the OI/OI-wall decoy (it carries all the call OI in one variant).
STRIKES = [
    {"strike": 100.0, "call_oi": 2500, "put_oi": 0,   "net_gex": 2.0e8,  "call_gex": 2.0e8, "put_gex": 0.0},
    {"strike": 102.0, "call_oi": 2500, "put_oi": 0,   "net_gex": -1.0e6, "call_gex": 0.0,   "put_gex": -1.0e6},
    {"strike": 104.0, "call_oi": 0,    "put_oi": 5000, "net_gex": -2.0e8, "call_gex": 0.0,  "put_gex": -2.0e8},
]


def _payload(symbol: str = "QQQ", spot: float = 102.0, expiry: str = "all", **overrides) -> dict:
    base = {
        "symbol": symbol,
        "spot": spot,
        "total_gex": -1.5e9,
        "pc_ratio": 1.17,
        "atm_iv": 17.91,
        "expected_move": 5.41,
        "gamma_flip": 719.87,
        "market_state": "open",
        "updated_at": "2026-08-20T14:30:00Z",
        "expiry_filter": expiry,
        "key_levels": {
            "call_wall": 730.0,
            "put_wall": 700.0,
            "gamma_wall": 735.0,
            "gex_flip": 719.87,
            "vol_trigger": 742.5,
            "abs_gamma": 700.0,
        },
        "strikes": STRIKES,
    }
    base.update(overrides)
    return base


def _snapshot(symbol: str = "QQQ", **overrides) -> snapshot.Snapshot:
    """Assemble a Snapshot straight from synthetic payloads, no network."""
    buckets = {}
    for expiry in snapshot.BUCKETS:
        p = _payload(symbol=symbol, expiry=expiry, **overrides)
        buckets[expiry] = snapshot._bucket_from_payload(expiry, p)
    reference = buckets["all"]
    return snapshot.Snapshot(
        symbol=symbol,
        spot=reference.spot if hasattr(reference, "spot") else 102.0,
        market_state="open",
        updated_at="2026-08-20T14:30:00Z",
        data_source="schwab",
        realized_vol=13.48,
        buckets=buckets,
    )


# ─────────────────────────────── analytics ───────────────────────────────
class AnalyticsTest(unittest.TestCase):
    def test_max_pain_picks_the_strike_minimising_holder_payout(self):
        # Calls are spread at 100 and 102; puts concentrated at 104.
        # At K=100: calls lose 0 (ITM calls pay only above their strike),
        #   puts gain (104-100)*5000 = 20000.  (102 calls ITM: (100-102)*2500
        #   credited, so net holder PnL still -20000 → pain 20000.)
        # At K=102: calls lose (102-100)*2500 = 5000, puts gain (104-102)*5000
        #   = 10000 → pain 15000.
        # At K=104: calls lose (104-100)*2500 + (104-102)*2500 = 15000, puts
        #   lose 0 → pain 15000.
        # The strict minimum (by the < tie-break, first wins) is K=102.
        self.assertEqual(analytics.max_pain(STRIKES), 102.0)

    def test_max_pain_returns_none_without_oi(self):
        self.assertIsNone(analytics.max_pain([{"strike": 100.0, "call_oi": 0, "put_oi": 0}]))

    def test_oi_walls(self):
        walls = analytics.oi_walls(STRIKES)
        self.assertEqual(walls["call_oi_wall"], 100.0)
        self.assertEqual(walls["put_oi_wall"], 104.0)
        # 100 and 104 both have total OI 5000; the first max wins.
        self.assertIn(walls["total_oi_wall"], (100.0, 104.0))

    def test_gamma_extremes(self):
        extremes = analytics.gamma_extremes(STRIKES)
        self.assertEqual(extremes["gpos"], 100.0)
        self.assertEqual(extremes["gneg"], 104.0)
        # abs(2e8) == abs(-2e8); both are the max. The first encountered wins.
        self.assertIn(extremes["hgex"], (100.0, 104.0))

    def test_oi_pc_ratio(self):
        # puts/calls = 5000 / 5000 = 1.0
        self.assertAlmostEqual(analytics.oi_pc_ratio(STRIKES), 1.0, places=3)

    def test_realized_vol_needs_enough_bars(self):
        self.assertIsNone(analytics.realized_vol([{"close": 100}]))
        self.assertIsNone(analytics.realized_vol([]))


# ─────────────────────────────── emitter ─────────────────────────────────
class EmitTest(unittest.TestCase):
    def test_string_has_header_and_levels(self):
        s = emit.emit(_snapshot())
        self.assertTrue(s.startswith("M:"))
        self.assertIn("|L:", s)
        # Header carries the key metadata fields.
        self.assertIn("sym=QQQ", s)
        self.assertIn("basis=today-live", s)  # market_state=open
        self.assertIn("asof=2026-08-20T14:30:00Z", s)

    def test_each_bucket_level_carries_its_suffix(self):
        s = emit.emit(_snapshot())
        # 0DTE call wall -> res0
        self.assertIn(",CW 0DTE,res0", s)
        # Weekly call wall -> resw
        self.assertIn(",CW W,resw", s)
        # Monthly -> resm, All -> res (no suffix)
        self.assertIn(",CW M,resm", s)
        self.assertIn(",CW ALL,res", s)

    def test_independent_levels_have_no_suffix(self):
        s = emit.emit(_snapshot())
        self.assertIn(",MaxPain,mpain", s)
        self.assertIn(",CallOI,oic", s)
        self.assertIn(",PutOI,oip", s)
        self.assertIn(",EM High,emh", s)
        self.assertIn(",IV High,ivh", s)

    def test_flags_drop_optional_levels(self):
        full = emit.emit(_snapshot())
        no_oi = emit.emit(_snapshot(), include_oi=False)
        self.assertIn(",mpain", full)
        self.assertNotIn(",mpain", no_oi)
        self.assertNotIn(",oic", no_oi)
        no_bands = emit.emit(_snapshot(), include_bands=False)
        self.assertNotIn(",emh", no_bands)
        self.assertNotIn(",ivh", no_bands)

    def test_unusable_levels_are_dropped(self):
        # Null out every key level on one bucket — its rows must not appear.
        snap = _snapshot()
        for attr in ("call_wall", "put_wall", "gex_flip", "gamma_wall", "hgex"):
            setattr(snap.buckets["0dte"], attr, None)
        s = emit.emit(snap)
        self.assertNotIn("res0", s)
        self.assertNotIn("sup0", s)
        # Other buckets still present.
        self.assertIn("resw", s)

    def test_pcr_filtered_when_implausible(self):
        # pc_ratio of -39.79 (observed premarket noise) must not be emitted.
        snap = _snapshot()
        snap.buckets["all"].pc_ratio = -39.79
        s = emit.emit(snap)
        self.assertNotIn("pcr=", s)

    def test_etf_prices_get_two_decimals(self):
        s = emit.emit(_snapshot(symbol="QQQ"))
        # QQQ call wall at 730 -> "730.00"
        self.assertIn("730.00,CW ALL,res", s)

    def test_index_prices_get_whole_points(self):
        s = emit.emit(_snapshot(symbol="SPX"))
        self.assertIn("730,CW ALL,res", s)


# ─────────────────────── Pine ↔ Python parser contract ────────────────────
# The Pine indicator parses the emitted string with f_baseKind / f_bucketOf.
# These mirror that logic exactly so a change to the suffix scheme is caught
# by the test suite before it reaches TradingView.
class PineContractTest(unittest.TestCase):
    BASE_KINDS = ("res", "sup", "flip", "gwall", "vtrig", "hgex", "gpos", "gneg",
                 "mpain", "oic", "oip", "oimax", "emh", "eml", "ivh", "ivl")
    SUFFIXES = {"0dte": "0", "weekly": "w", "monthly": "m", "all": ""}

    def _base_kind(self, kind: str) -> str:
        last = kind[-1] if kind else ""
        return kind[:-1] if last in ("0", "w", "m") else kind

    def _bucket_of(self, kind: str) -> str:
        last = kind[-1] if kind else ""
        return {"0": "0dte", "w": "weekly", "m": "monthly"}.get(last, "all")

    def test_base_kinds_never_end_in_suffix_chars(self):
        # The whole suffix-stripping scheme depends on this invariant.
        for base in self.BASE_KINDS:
            self.assertNotIn(base[-1], ("0", "w", "m"),
                             f"base kind {base!r} ends in a suffix char")

    def test_emitted_kinds_round_trip_through_pine_logic(self):
        s = emit.emit(_snapshot())
        header, _, levels = s.partition("|L:")
        for row in levels.split(";"):
            if not row:
                continue
            price, label, kind = row.split(",")
            base = self._base_kind(kind)
            bucket = self._bucket_of(kind)
            # Every emitted kind must decode to a known base + bucket.
            self.assertIn(base, self.BASE_KINDS, f"unknown base from kind {kind!r}")
            self.assertIn(bucket, self.SUFFIXES, f"unknown bucket from kind {kind!r}")
            # Independent levels must decode to the "all" bucket.
            if base in ("mpain", "oic", "oip", "oimax", "emh", "eml", "ivh", "ivl"):
                self.assertEqual(bucket, "all",
                                 f"{base} must be bucket-agnostic, got {bucket}")

    def test_price_is_positive_and_numeric(self):
        s = emit.emit(_snapshot())
        _, _, levels = s.partition("|L:")
        for row in levels.split(";"):
            if not row:
                continue
            price = float(row.split(",")[0])
            self.assertGreater(price, 0.0)


# ─────────────── Pine ↔ Python conversion contract (v11) ──────────────────
# The Pine indicator's 自动 mode resolves the price-space conversion in a
# fixed order: symbol-pair table → ratio conversion → raw prices. This class
# mirrors that decision tree so a changed pair constant, a new chart root, or
# a moved guard breaks the tests before it breaks the chart.
class PineConversionContractTest(unittest.TestCase):
    PAIR_MULT = {
        ("SPX", "ES"): 1.0, ("SPX", "MES"): 0.1,
        ("SPY", "ES"): 10.0, ("SPY", "MES"): 1.0,
        ("NDX", "NQ"): 1.0, ("NDX", "MNQ"): 0.1,
        ("QQQ", "NQ"): 40.0, ("QQQ", "MNQ"): 4.0,
    }

    def _auto_conv(self, dsym: str, root: str, close: float, spot: float | None,
                   ticker: str | None = None):
        """Returns (conv, shift, mode) exactly as the Pine 自动 branch does."""
        if spot is None or spot <= 0:
            return 1.0, 0.0, "无spot"
        dsym = dsym.upper()
        # Same instrument → strikes are already this chart's prices; pin them
        # at face value regardless of any gap since the snapshot.
        if dsym == root or dsym == (ticker or root):
            return 1.0, 0.0, "同品种"
        # Sanity gate BEFORE the pair table: a corrupt spot must never reach a
        # fixed multiplier, or it turns into a huge additive shift.
        ratio = close / spot
        if not (0.005 < ratio < 50.0):
            return 1.0, 0.0, "异常"
        pm = self.PAIR_MULT.get((dsym, root))
        if pm is not None:
            return pm, close - pm * spot, "配对"
        return ratio, close - ratio * spot, "比例"

    def test_futures_pairs_use_exact_contract_scale(self):
        # (data sym, chart root) -> (chart close, data spot)
        cases = {
            ("NDX", "NQ"): (23750.0, 23500.0),
            ("NDX", "MNQ"): (2352.0, 23480.0),
            ("QQQ", "NQ"): (23750.0, 595.0),
            ("QQQ", "MNQ"): (2375.0, 595.0),
            ("SPX", "ES"): (6480.0, 6450.0),
            ("SPX", "MES"): (647.5, 6450.0),
            ("SPY", "ES"): (6480.0, 645.0),
            ("SPY", "MES"): (647.5, 645.0),
        }
        for (dsym, root), (close, spot) in cases.items():
            conv, shift, mode = self._auto_conv(dsym, root, close, spot)
            self.assertEqual(mode, "配对", (dsym, root))
            # The snapshot spot must land exactly on the live chart price.
            self.assertAlmostEqual(spot * conv + shift, close, places=6)

    def test_etf_and_unknown_pairs_use_ratio_conversion(self):
        # SPX string on a SPY chart: no fixed-scale pair → ratio path.
        conv, shift, mode = self._auto_conv("SPX", "SPY", 645.10, 6450.0)
        self.assertEqual(mode, "比例")
        self.assertAlmostEqual(conv, 645.10 / 6450.0)
        self.assertAlmostEqual(shift, 0.0, places=9)
        # Same-symbol chart pins raw prices (see the 同品种 test below).
        conv, _, mode = self._auto_conv("QQQ", "QQQ", 709.32, 709.32)
        self.assertEqual((mode, conv), ("同品种", 1.0))

    def test_same_symbol_pins_strikes_at_face_value(self):
        # A post-snapshot gap must NOT drag fixed option strikes: SPY string
        # (spot 762.60) on a SPY chart now trading 771.20 renders CW at 770.00.
        self.assertEqual(self._auto_conv("SPY", "SPY", 771.20, 762.60),
                         (1.0, 0.0, "同品种"))
        # Futures-style tickers compare against the root too (NQ1! → NQ).
        self.assertEqual(self._auto_conv("NDX", "NQ", 23750.0, 23500.0,
                                         ticker="NQ1!"),
                         (1.0, 23750.0 - 23500.0, "配对"))

    def test_implausible_ratio_falls_back_to_raw_prices(self):
        # A garbage spot (ratio far outside any real instrument pairing) must
        # not scatter levels across the axis. Plausible-but-unfamiliar ratios
        # (e.g. an index string on an unrelated stock, or DIA↔DJI ≈ ×0.01)
        # intentionally stay on the ratio path — only extremes are rejected.
        self.assertEqual(self._auto_conv("NDX", "NQ", 23750.0, 1.0),
                         (1.0, 0.0, "异常"))
        _, _, mode = self._auto_conv("SPX", "AAPL", 230.0, 6450.0)
        self.assertEqual(mode, "比例")

    def test_missing_spot_reports_no_conversion(self):
        self.assertEqual(self._auto_conv("NDX", "NQ", 23750.0, None),
                         (1.0, 0.0, "无spot"))


# ───────────────────────── client validation ─────────────────────────────
class ClientGuardTest(unittest.TestCase):
    def test_rejects_unlisted_symbol(self):
        # "ES" is deliberately NOT whitelisted: gexdash returns Eversource's
        # chain for it. The client must refuse before any request.
        import gextv.client as c
        with self.assertRaises(c.GexdashError):
            c.gex("ES")
        with self.assertRaises(c.GexdashError):
            c.gex("AAPL")

    def test_rejects_bad_expiry(self):
        import gextv.client as c
        with self.assertRaises(c.GexdashError):
            c.gex("QQQ", expiry="yearly")


if __name__ == "__main__":
    unittest.main()
