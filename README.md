# gamma-exposure-toolkit

Pulls dealer gamma-exposure (GEX) levels for **SPX / NDX / QQQ / SPY / IWM** from the public [gexdash.com](https://www.gexdash.com/) API (Schwab option-chain data, no auth, no key) and emits a single compact string you paste into a TradingView Pine indicator.

Four expiry buckets — **0DTE / Weekly / Monthly / All** — ride in one string, so all three wall sets plot on the same chart in one call.

> gexdash always serves its most recent snapshot: during US regular hours that's the live chain; outside RTH it's the previous close carried forward. The CLI labels which one you got (`today-live` vs `prior-close`) and that label rides into the Pine panel, so a stale paste reads as stale on the chart.

## Quick start

```bash
# One symbol → prints the string + copies it to the clipboard (macOS pbcopy)
python3 -m gextv.cli QQQ

# Then paste into the indicator's "GEX data string" field in TradingView.
```

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
pine/
  GEXLevels_gexdash.pine   # the TradingView indicator (paste the string into it)
tests/
  test_pipeline.py         # analytics + emitter + Pine↔Python parser contract (offline)
```

## The Pine indicator

Open `pine/GEXLevels_gexdash.pine` in the TradingView Pine editor, add it to a chart, and paste the CLI's output into the **GEX data string** field. Settings let you:

- toggle each expiry bucket independently (0DTE / Weekly / Monthly / All),
- set the line style + width per bucket,
- toggle max pain, OI walls, expected move, IV bands,
- show a legend/abbreviation panel in any of the four corners — it carries the snapshot status (live vs prior-close) and a glossary of every short code, so a viewer who didn't author the string can still read the chart.

## What this deliberately does *not* do

- **No ES/NQ futures directly.** gexdash serves index/ETF option chains, not futures chains. The toolkit's `ict-engine` sibling repo shifts SPX/NDX levels onto ES/NQ by a basis; this standalone toolkit keeps prices in the symbol's own units so each string is charted on that same symbol. If you want ES/NQ futures gamma, either chart ES and use an SPX string + the `ict-engine` basis shift, or add a futures adapter.
- **No fabricated confidence fields.** The TLADe-style "Hold: 80% | Break: 20%" probabilities some Pine scripts show are not in gexdash's data, so they are not emitted. A confidence number a trader can't audit is worse than none.
- **No silent fallback on bad input.** gexdash returns HTTP 200 for arbitrary equity tickers (it has no symbol whitelist server-side), so a typo like `ES` would hand back Eversource Energy's chain. The client refuses unlisted symbols before any request, and refuses any payload whose returned symbol / expiry / spot don't match what was asked for.

## Tests

```bash
python3 -m unittest tests.test_pipeline -v
```

19 tests, all offline (synthetic payloads; no network). The `PineContractTest` suite re-implements the Pine parser's `f_baseKind`/`f_bucketOf` logic in Python and asserts every emitted kind round-trips — so renaming a kind suffix breaks the tests before it breaks the chart.

## License & data source

Code: MIT. Data: pulled live from gexdash.com's public API; respect its free-tier usage — this toolkit makes one request per expiry bucket per symbol and backs off on failure. Don't hammer it.
