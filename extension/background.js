// background.js — MV3 service worker.
//
// Why the fetch lives here and not in content.js: Chrome's docs are explicit
// that content scripts are bound by the *page's* origin, so a content script
// on tradingview.com cannot fetch gexdash.com even with host_permissions. The
// service worker, by contrast, can make cross-origin requests freely as long
// as the host is declared in host_permissions (it is). So the content script
// only sends a symbol name here; the worker does the fetching and hands back
// the finished level string. The content script never sees raw gexdash JSON
// and never constructs a URL — only a whitelisted symbol is accepted.

const SUPPORTED = ["SPX", "NDX", "QQQ", "SPY", "IWM", "RUT"];
const EXPIRIES = ["0dte", "weekly", "monthly", "all"];
const SPOT_BOUNDS = {
  SPX: [2000, 40000], NDX: [8000, 150000], SPY: [200, 4000],
  QQQ: [150, 4000], IWM: [80, 1500], RUT: [800, 15000],
};
const SUFFIX = { "0dte": "0", "weekly": "w", "monthly": "m", "all": "" };
const TAG = { "0dte": "0DTE", "weekly": "W", "monthly": "M", "all": "ALL" };
const BUCKET_LEVELS = [
  ["call_wall", "res", "CW"], ["put_wall", "sup", "PW"],
  ["gex_flip", "flip", "FLIP"], ["gamma_wall", "gwall", "GW"],
  ["vol_trigger", "vtrig", "VT"], ["hgex", "hgex", "HGEX"],
  ["gpos", "gpos", "G+"], ["gneg", "gneg", "G-"],
];
const BUCKETS = ["0dte", "weekly", "monthly", "all"];

async function fetchJson(path) {
  const resp = await fetch("https://gexdash.com" + path, {
    headers: { "User-Agent": "gamma-exposure-toolkit-ext/0.1" },
  });
  if (!resp.ok) throw new Error(`gexdash ${path} -> HTTP ${resp.status}`);
  return resp.json();
}

// ── analytics (ported from gextv/analytics.py — keep in sync) ───────────────
function num(row, key) {
  const v = row[key];
  return typeof v === "number" ? v : 0;
}

function maxPain(strikes) {
  const rows = strikes.filter(r => num(r, "call_oi") || num(r, "put_oi"));
  if (rows.length < 3) return null;
  let best = null, bestPain = Infinity;
  for (const cand of rows) {
    const k = num(cand, "strike");
    let pain = 0;
    for (const r of rows) {
      const s = num(r, "strike");
      if (k > s) pain += num(r, "call_oi") * (k - s);
      else if (s > k) pain += num(r, "put_oi") * (s - k);
    }
    if (pain < bestPain) { bestPain = pain; best = k; }
  }
  return best;
}

function oiWalls(strikes) {
  if (!strikes.length) return { call_oi_wall: null, put_oi_wall: null, total_oi_wall: null };
  let call = strikes[0], put = strikes[0], total = strikes[0];
  for (const r of strikes) {
    if (num(r, "call_oi") > num(call, "call_oi")) call = r;
    if (num(r, "put_oi") > num(put, "put_oi")) put = r;
    if (num(r, "call_oi") + num(r, "put_oi") > num(total, "call_oi") + num(total, "put_oi")) total = r;
  }
  return {
    call_oi_wall: num(call, "call_oi") ? num(call, "strike") : null,
    put_oi_wall: num(put, "put_oi") ? num(put, "strike") : null,
    total_oi_wall: (num(total, "call_oi") + num(total, "put_oi")) ? num(total, "strike") : null,
  };
}

function gammaExtremes(strikes) {
  const rows = strikes.filter(r => num(r, "net_gex"));
  if (!rows.length) return { gpos: null, gneg: null, hgex: null };
  let pos = rows[0], neg = rows[0], abs = rows[0];
  for (const r of rows) {
    if (num(r, "net_gex") > num(pos, "net_gex")) pos = r;
    if (num(r, "net_gex") < num(neg, "net_gex")) neg = r;
    if (Math.abs(num(r, "net_gex")) > Math.abs(num(abs, "net_gex"))) abs = r;
  }
  return {
    gpos: num(pos, "net_gex") > 0 ? num(pos, "strike") : null,
    gneg: num(neg, "net_gex") < 0 ? num(neg, "strike") : null,
    hgex: num(abs, "strike"),
  };
}

function oiPcRatio(strikes) {
  let calls = 0, puts = 0;
  for (const r of strikes) { calls += num(r, "call_oi"); puts += num(r, "put_oi"); }
  return calls ? Math.round(puts / calls * 1000) / 1000 : null;
}

// ── bucket + snapshot assembly (ported from gextv/snapshot.py) ──────────────
function bucketFromPayload(expiry, payload) {
  const levels = payload.key_levels || {};
  const strikes = payload.strikes || [];
  const ext = gammaExtremes(strikes);
  const walls = oiWalls(strikes);
  return {
    expiry,
    call_wall: levels.call_wall,
    put_wall: levels.put_wall,
    gamma_wall: levels.gamma_wall,
    gex_flip: levels.gex_flip || payload.gamma_flip,
    vol_trigger: levels.vol_trigger,
    abs_gamma: levels.abs_gamma,
    total_gex: payload.total_gex || 0,
    pc_ratio: payload.pc_ratio || 0,
    atm_iv: payload.atm_iv || 0,
    expected_move: payload.expected_move,
    max_pain: maxPain(strikes),
    oi_pc_ratio: oiPcRatio(strikes),
    call_oi_wall: walls.call_oi_wall,
    put_oi_wall: walls.put_oi_wall,
    total_oi_wall: walls.total_oi_wall,
    gpos: ext.gpos, gneg: ext.gneg, hgex: ext.hgex,
  };
}

function bucketUsable(b) {
  return [b.call_wall, b.put_wall, b.gex_flip, b.gamma_wall, b.hgex]
    .some(v => v !== null && v !== undefined);
}

// ── emitter (ported from gextv/emit.py — keep in sync) ─────────────────────
function fmtPrice(p, symbol) {
  return ["QQQ", "SPY", "IWM"].includes(symbol) ? p.toFixed(2) : p.toFixed(0);
}

function compact(v) {
  const m = Math.abs(v);
  for (const [d, u] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (m >= d) return (v / d).toFixed(2) + u;
  }
  return v.toFixed(0);
}

function emit(snap, { includeOsi = true, includeBands = true } = {}) {
  const ref = snap.buckets.all || Object.values(snap.buckets)[0];
  const meta = [
    `sym=${snap.symbol}`,
    `spot=${fmtPrice(snap.spot, snap.symbol)}`,
    `state=${snap.market_state}`,
    `basis=${snap.basis}`,
    `asof=${snap.updated_at}`,
    `src=${snap.data_source || "unknown"}`,
    `ng=${compact(ref.total_gex)}`,
    `iv=${ref.atm_iv.toFixed(2)}`,
  ];
  if (snap.realized_vol != null) meta.push(`rv=${snap.realized_vol.toFixed(2)}`);
  if (ref.oi_pc_ratio != null) meta.push(`oipc=${ref.oi_pc_ratio}`);
  if (ref.pc_ratio > 0 && ref.pc_ratio < 20) meta.push(`pcr=${ref.pc_ratio.toFixed(2)}`);
  for (const e of BUCKETS) {
    const b = snap.buckets[e];
    if (b && bucketUsable(b)) meta.push(`ng${SUFFIX[e] || "a"}=${compact(b.total_gex)}`);
  }

  const levels = [];
  function push(price, label, kind) {
    if (price == null || !isFinite(price) || price <= 0) return;
    levels.push(`${fmtPrice(price, snap.symbol)},${label},${kind}`);
  }
  for (const e of BUCKETS) {
    const b = snap.buckets[e];
    if (!b || !bucketUsable(b)) continue;
    for (const [attr, base, stem] of BUCKET_LEVELS) {
      push(b[attr], `${stem} ${TAG[e]}`, `${base}${SUFFIX[e]}`);
    }
  }
  if (includeOsi) {
    push(ref.max_pain, "MaxPain", "mpain");
    push(ref.call_oi_wall, "CallOI", "oic");
    push(ref.put_oi_wall, "PutOI", "oip");
    push(ref.total_oi_wall, "OI Max", "oimax");
  }
  if (includeBands) {
    if (ref.expected_move) {
      push(snap.spot + ref.expected_move, "EM High", "emh");
      push(snap.spot - ref.expected_move, "EM Low", "eml");
    }
    if (ref.atm_iv > 0) {
      const daily = snap.spot * (ref.atm_iv / 100) / Math.sqrt(252);
      push(snap.spot + daily, "IV High", "ivh");
      push(snap.spot - daily, "IV Low", "ivl");
    }
  }
  return "M:" + meta.join(",") + "|L:" + levels.join(";");
}

// ── snapshot fetch with the same guards as the Python client ────────────────
async function fetchSnapshot(symbol) {
  symbol = (symbol || "").trim().toUpperCase();
  if (!SUPPORTED.includes(symbol)) {
    throw new Error(`${symbol} not whitelisted. Supported: ${SUPPORTED.join(", ")}`);
  }
  const [health, ...bucketPayloads] = await Promise.all(
    [fetchJson("/api/health"), ...EXPIRIES.map(e => fetchJson(`/api/gex/${symbol}?expiry=${e}`))]
  );
  const payloads = {};
  EXPIRIES.forEach((e, i) => { payloads[e] = bucketPayloads[i]; });

  // Validate each payload the same way the Python client does.
  for (const e of EXPIRIES) {
    const p = payloads[e];
    if ((p.symbol || "").toUpperCase() !== symbol)
      throw new Error(`asked ${symbol}, server answered ${p.symbol}`);
    if (p.expiry_filter !== e)
      throw new Error(`asked expiry=${e}, server answered ${p.expiry_filter} (fallback)`);
    const spot = p.spot;
    const [lo, hi] = SPOT_BOUNDS[symbol];
    if (typeof spot !== "number" || spot < lo || spot > hi)
      throw new Error(`${symbol} spot ${spot} outside sane band — wrong instrument`);
  }

  const reference = payloads.all;
  const buckets = {};
  for (const e of EXPIRIES) buckets[e] = bucketFromPayload(e, payloads[e]);

  if (!Object.values(buckets).some(bucketUsable)) {
    throw new Error(`${symbol}: all buckets null (snapshot ${reference.updated_at}, state ${reference.market_state}) — gexdash has not refreshed this symbol yet`);
  }

  const basis = ["open", "regular"].includes(reference.market_state) ? "today-live" : "prior-close";
  return {
    symbol, spot: reference.spot, market_state: reference.market_state,
    updated_at: reference.updated_at, data_source: health.data_source,
    realized_vol: null, basis, buckets,
  };
}

// ── message router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "fetchGex" && typeof msg.symbol === "string") {
    fetchSnapshot(msg.symbol).then(snap => {
      sendResponse({ ok: true, snapshot: snap, string: emit(snap) });
    }).catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async response
  }
});
