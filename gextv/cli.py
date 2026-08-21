"""Command line entry point: fetch gexdash, print the string, copy it."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from . import client, emit, snapshot


def _copy(text: str) -> bool:
    try:
        subprocess.run(["pbcopy"], input=text.encode(), check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def _report(snap: snapshot.Snapshot) -> str:
    age = snap.age_minutes
    lines = [
        f"{snap.symbol}  spot {snap.spot}  state={snap.market_state} "
        f"({snap.session_basis})  src={snap.data_source}"
        + (f"  age={age}min" if age is not None else ""),
    ]
    for name, bucket in snap.buckets.items():
        if not bucket.usable:
            lines.append(f"  {name:<8} unusable (all key levels null)")
            continue
        lines.append(
            f"  {name:<8} CW {bucket.call_wall}  PW {bucket.put_wall}  "
            f"flip {round(bucket.gex_flip, 2) if bucket.gex_flip else None}  "
            f"maxpain {bucket.max_pain}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gextv",
        description=(
            "Fetch dealer gamma exposure from gexdash.com and emit the level "
            "string for the TradingView indicator in pine/."
        ),
    )
    parser.add_argument("symbol", help=f"one of: {', '.join(client.SUPPORTED)}")
    parser.add_argument(
        "--expiry",
        action="append",
        choices=list(snapshot.BUCKETS),
        help="expiry bucket to include; repeatable. Default: all four.",
    )
    parser.add_argument("--no-oi", action="store_true", help="drop max pain and OI walls")
    parser.add_argument("--no-bands", action="store_true", help="drop EM and IV bands")
    parser.add_argument("--no-copy", action="store_true", help="do not touch the clipboard")
    parser.add_argument("--json", action="store_true", help="dump the normalised snapshot instead")
    parser.add_argument("--quiet", action="store_true", help="print only the level string")
    args = parser.parse_args(argv)

    try:
        snap = snapshot.fetch(args.symbol)
    except client.GexdashError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(snap, default=lambda o: o.__dict__, indent=2))
        return 0

    buckets = tuple(args.expiry) if args.expiry else snapshot.BUCKETS
    payload = emit.emit(
        snap,
        buckets=buckets,
        include_oi=not args.no_oi,
        include_bands=not args.no_bands,
    )

    if not args.quiet:
        print(_report(snap), file=sys.stderr)
        print(f"  string length: {len(payload)} chars", file=sys.stderr)
    print(payload)
    if not args.no_copy and not args.quiet and _copy(payload):
        print("  copied to clipboard — paste into the indicator's GEX Data field", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
