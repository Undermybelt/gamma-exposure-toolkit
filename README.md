# gamma-exposure-toolkit

Pulls dealer gamma-exposure (GEX) levels for **SPX / NDX / QQQ / SPY / IWM** from the public [gexdash.com](https://www.gexdash.com/) API (Schwab option-chain data, no auth, no key) and emits a single compact string you paste into a TradingView Pine indicator.

Four expiry buckets — **0DTE / Weekly / Monthly / All** — ride in one string, so all three wall sets plot on the same chart in one call.

> gexdash always serves its most recent snapshot: during US regular hours that's the live chain; outside RTH it's the previous close carried forward. The CLI labels which one you got (`today-live` vs `prior-close`) and that label rides into the Pine panel, so a stale paste reads as stale on the chart.

## Two ways to get the string into the indicator

### A. CLI (copy-paste)

```bash
python3 -m gextv.cli QQQ     # prints + copies the string
# paste into the indicator's "GEX data string" field in TradingView
```

### B. Chrome extension (one-click)

For no-copy-paste: load `extension/` as an unpacked extension. It fetches gexdash from its background worker, builds the **same** level string the CLI does, and fills the indicator's data field with one click (clipboard fallback if it cannot find the field). It can also **auto-poll** — default every 1 minute, since gexdash's own snapshot refreshes every 30 s — and an optional **full-auto** mode reopens the settings dialog and clicks OK for you, so the chart refreshes end-to-end with zero manual steps. See `extension/README.md`.

Why a bridge is needed: TradingView's Pine sandbox cannot reach `gexdash.com` — Pine has no HTTP-fetch primitive, only `request.security` for exchange data. The indicator itself stays a pure string-parsing Pine script; the bridge (CLI or extension) does the network work that Pine is not allowed to do.

Output (QQQ, evening snapshot):
```
QQQ  spot 709.32  state=closed (prior-close)  src=schwab  age=12.3min
  0dte     CW 710.0  PW 700.0  flip 720.24  maxpain 707.0
  weekly   CW 730.0  PW 700.0  flip 716.19  maxpain 715.0
  monthly  CW 710.0  PW 700.0  flip 719.41  maxpain 705.0
  all      CW 710.0  PW 700.0  flip 716.77  maxpain 710.0
  string length: 963 chars
  copied to clipboard — paste into the indicator's GEX Data field
```

## Install

No external dependencies — stdlib only. From the repo root:

```bash
export PYTHONPATH="$PWD"        # or: pip install -e . once you add a setup
python3 -m gextv.cli QQQ
```

`pyproject.toml` / `setup.py` is intentionally absent in this first cut; add one if you want `gextv` on `PATH`.

## CLI reference

```
gextv <symbol> [options]
  symbol            one of: SPX NDX QQQ SPY IWM  (case-insensitive)

  --expiry 0dte     only emit this bucket; repeatable (default: all four)
  --no-oi           drop max pain and OI walls
  --no-bands        drop expected-move and IV 1-day bands
  --no-copy         do not touch the clipboard
  --json            dump the normalised snapshot as JSON instead of the string
  --quiet           print only the level string
```

## What you get on the chart

For each expiry bucket (0DTE solid / Weekly dashed / Monthly dotted / All thick, all user-configurable):

| kind | meaning |
|---|---|
| `res` / `sup` | Call wall / Put wall |
| `flip` | Gamma flip (zero-gamma) |
| `gwall` | Gamma wall |
| `vtrig` | Vol trigger |
| `hgex` | Dominant absolute-gamma strike (session's main magnet) |
| `gpos` / `gneg` | Most positive / most negative net-GEX strike |

Independent of expiry:

| kind | meaning |
|---|---|
| `mpain` | Max pain — computed locally from open interest (gexdash exposes no max-pain field) |
| `oic` / `oip` / `oimax` | Largest call-OI / put-OI / total-OI strike |
| `emh` / `eml` | Expected-move band from spot |
| `ivh` / `ivl` | 1-day 1-sigma range from annualised ATM IV |

## Wire format

```
M:sym=QQQ,spot=709.32,state=closed,basis=prior-close,asof=...,src=schwab,ng=-5.39B,iv=19.85,rv=13.86,oipc=1.22,ng0=...,ngw=...,ngm=...,nga=...
|L:price,label,kind;price,label,kind;...
```

- **`M:` header** — metadata for the Pine panel: symbol, spot, market state, live/prior-close basis, timestamp, data source, net gamma, IV, RV, OI put/call, and per-bucket net gamma.
- **`L:` body** — `price,label,kind` rows. Kinds carry an expiry suffix (`0` / `w` / `m` / none) so the Pine parser can colour and style by bucket. Base kind names never end in `0`/`w`/`m`, so the suffix is unambiguous.

## Layout

```
gextv/
  client.py     # gexdash API client + validation (whitelist, spot bounds, expiry guard)
  analytics.py  # max pain, OI walls, gamma extremes, RV — all from the per-strike array
  snapshot.py   # normalised multi-expiry Snapshot
  emit.py       # emits the wire-format string
  cli.py        # command-line entry point (prints + pbcopy)
extension/
  manifest.json   # MV3 manifest; host_permissions = gexdash.com only
  background.js  # service worker — fetches gexdash, runs ported analytics+emitter
  content.js     # injects panel on tradingview.com, fills the indicator textarea
  panel.css      # panel styling
  README.md      # install + use
pine/
  GEXLevels_gexdash.pine   # the TradingView indicator (paste the string into it)
tests/
  test_pipeline.py         # analytics + emitter + Pine↔Python parser contract (offline)
```

The extension's `background.js` ports `analytics.py` + `emit.py` to JS so the CLI and the extension emit byte-identical strings. Comments there mark the ports; keep them in sync when you change the Python.

## The Pine indicator

Open `pine/GEXLevels_gexdash.pine` in the TradingView Pine editor, add it to a chart, and paste the CLI's output into the **GEX data string** field. Settings let you:

- toggle each expiry bucket independently (0DTE / Weekly / Monthly / All), or flip the whole chart to a single bucket with the 只显示 quick switch (仅0DTE / 仅Weekly / 仅Monthly / 仅All). Pine tables can't receive clicks, so the switch lives in settings — the panel header shows the active focus.
- set the line style + width per bucket,
- toggle max pain, OI walls, expected move, IV bands,
- convert levels into the chart's own price space (`价位换算`). **自动** resolves in a fixed order: same instrument as the data → raw prices (option strikes are absolute; a post-snapshot gap must not drag them); futures charts → symbol-pair table keyed on the data symbol × the chart's root (`syminfo.root`) with the exact contract scale plus an additive basis shift (NDX→NQ ×1, NDX→MNQ ×0.1, SPX→ES ×1, SPY→MES ×1, QQQ→NQ ×40); anything else → ratio conversion (chart close ÷ data spot, spread ≈ 0), which self-calibrates ETF↔index tracking drift. **手动** takes your own multiplier + spread and works even when the string has no parsable spot; **关闭** renders raw data prices. The debug row shows `图<symbol>·数据<sym>·<mode>×<mult>` so a mis-scaled paste is diagnosable from a screenshot.
- show a legend/abbreviation panel in any of the four corners — it carries the snapshot status (live vs prior-close), the snapshot time in **UTC-4** together with the data's age (「分前 / 时前」， amber past 2 h), net gamma, IV/RV and a glossary of every short code. The whole board has a configurable background colour (`面板底色`) so it stays readable on any theme. Spot is intentionally not displayed anywhere on the chart.
- stagger labels on **both axes**: near-adjacent labels alternate above/below the line *and* cascade right by `横向错开间距` bars each, so an overlap run reads as an ordered diagonal instead of a vertical stack,
- move the debug row to any corner (`调试行位置`) — it reports parse/conversion state without spot readouts.

## What this deliberately does *not* do

- **No futures option chains.** gexdash serves index/ETF option chains, not futures chains — so the GEX itself is always computed from SPX/NDX/QQQ/SPY/IWM options. What the indicator *does* do is land those levels on a futures chart: the v12 pair table maps them onto ES/MES/NQ/MNQ at the exact contract scale with the live basis as the additive shift, so an NDX string reads correctly on an NQ or MNQ chart without any manual math.
- **No fabricated confidence fields.** The TLADe-style "Hold: 80% | Break: 20%" probabilities some Pine scripts show are not in gexdash's data, so they are not emitted. A confidence number a trader can't audit is worse than none.
- **No silent fallback on bad input.** gexdash returns HTTP 200 for arbitrary equity tickers (it has no symbol whitelist server-side), so a typo like `ES` would hand back Eversource Energy's chain. The client refuses unlisted symbols before any request, and refuses any payload whose returned symbol / expiry / spot don't match what was asked for.

## Tests

```bash
python3 -m unittest tests.test_pipeline -v
```

24 tests, all offline (synthetic payloads; no network). The `PineContractTest` suite re-implements the Pine parser's `f_baseKind`/`f_bucketOf` logic in Python and asserts every emitted kind round-trips — so renaming a kind suffix breaks the tests before it breaks the chart. `PineConversionContractTest` mirrors the v12 price-space conversion decision tree (pair table → ratio → raw) the same way.

## License & data source

Code: MIT. Data: pulled live from gexdash.com's public API; respect its free-tier usage — this toolkit makes one request per expiry bucket per symbol and backs off on failure. Don't hammer it.
