// content.js — injected into tradingview.com.
//
// Flow: pick symbol → 「加载并复制」 (or the auto-poll tick) asks the background
// worker for the level string and copies it to the clipboard. That is the whole
// job — no DOM writing. Auto-fill into the indicator's settings textarea was
// removed in v0.5: TradingView's framework-controlled fields made programmatic
// fill + auto-OK too fragile to be worth it (dialog focus fights, obfuscated
// DOM, OK-button heuristics), so the extension now always lands the string in
// the clipboard and you paste it into the indicator yourself.
//
// EVENT ISOLATION: our floating panel lives outside TradingView's settings
// dialog, and TradingView closes that dialog whenever a pointer/keyboard event
// originates outside it. panelGuard() below intercepts panel-originated events
// at the window capture phase — before any TradingView handler can see them —
// and routes the panel's own actions by delegation (stopping propagation at
// window also prevents the panel's own element-level listeners from firing, so
// delegation in the guard is the only way to handle them).
//
// CONTEXT LIFETIME: reloading or updating the extension orphans this script
// inside the still-open tab; every chrome.* call from it then throws
// "Extension context invalidated." extAlive() guards each chrome call site,
// kills the poll timer on first failure, and tells the user to refresh.

const DEFAULT_SYMBOL_KEY = "gextv:defaultSymbol";
const POSITION_KEY = "gextv:panelPos"; // {x, y}
const COLLAPSED_KEY = "gextv:panelCollapsed";
const POLL_KEY = "gextv:pollMin";      // 0 = off, else minutes
const PANEL_ID = "gextv-bridge-panel";

// Module state shared by the guard and the UI.
let panelEl = null;
let currentSymbol = "QQQ";
let toggleCollapse = null;
let drag = null;
let pollTimer = null;
let pollBusy = false;

// ── extension-context guard ───────────────────────────────────────────────
// Reloading/updating the extension orphans the content script already living
// in this tab: every chrome.* binding then throws "Extension context
// invalidated." (seen at the symbol-select's storage.set). extAlive() checks
// the context once per call and, on the first failure, tears the poll timer
// down and points the user at the real fix — a page refresh. setStatus below
// is plain DOM, so it still works from an orphaned script.
let ctxDead = false;
function extAlive() {
  if (ctxDead) return false;
  try {
    if (!chrome.runtime || !chrome.runtime.id) throw new Error("context gone");
    return true;
  } catch {
    ctxDead = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setStatus("⚠ 扩展已重载或更新 — 请刷新 TradingView 页面后再用", "#EF5350");
    return false;
  }
}

// ── persistence helpers ───────────────────────────────────────────────────
function loadDefaultSymbol() {
  return new Promise(resolve => {
    if (!extAlive()) { resolve("QQQ"); return; }
    chrome.storage.local.get(DEFAULT_SYMBOL_KEY, r =>
      resolve(r[DEFAULT_SYMBOL_KEY] || "QQQ"));
  });
}
function saveDefaultSymbol(sym) {
  if (!extAlive()) return;
  currentSymbol = sym;
  chrome.storage.local.set({ [DEFAULT_SYMBOL_KEY]: sym });
}
function loadState() {
  return new Promise(resolve => {
    if (!extAlive()) { resolve({ pos: null, collapsed: false }); return; }
    chrome.storage.local.get(
      [POSITION_KEY, COLLAPSED_KEY], r => resolve({
        pos: r[POSITION_KEY] || null,
        collapsed: r[COLLAPSED_KEY] || false,
      }));
  });
}
function savePos(pos) { if (extAlive()) chrome.storage.local.set({ [POSITION_KEY]: pos }); }
function saveCollapsed(c) { if (extAlive()) chrome.storage.local.set({ [COLLAPSED_KEY]: c }); }

// ── clipboard ─────────────────────────────────────────────────────────────
// navigator.clipboard needs a focused document; the hidden-textarea +
// execCommand path is the fallback (and the only one that can work in odd
// embedding contexts). Both fail while the tab is backgrounded — the next
// tick after you switch back re-copies.
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    return ok;
  }
}

function setStatus(text, color) {
  const el = document.getElementById("gextv-status");
  if (el) { el.textContent = text; el.style.color = color || "#787B86"; }
}

// ── load + copy ───────────────────────────────────────────────────────────
async function doFetchAndCopy(prefix, isAutoTick = false) {
  if (pollBusy) return;
  if (!extAlive()) return;
  pollBusy = true;
  setStatus(prefix + "正在从 gexdash 获取…", "#3B82F6");
  chrome.runtime.sendMessage({ type: "fetchGex", symbol: currentSymbol }, async (resp) => {
    try {
      if (chrome.runtime.lastError) {
        setStatus(prefix + "扩展错误: " + chrome.runtime.lastError.message, "#EF5350");
        return;
      }
      if (!resp || !resp.ok) {
        setStatus(prefix + (resp && resp.error ? "错误: " + resp.error : "获取失败"), "#EF5350");
        return;
      }

      const copied = await copyToClipboard(resp.string);
      const hh = new Date().toTimeString().slice(0, 5);
      if (copied) {
        setStatus(`✓ ${hh} ${prefix}已复制 ${resp.snapshot.symbol}（${resp.snapshot.basis}）到剪贴板 — 粘贴进指标后点 OK`,
          "#26A69A");
      } else {
        setStatus(isAutoTick
          ? `⚠ ${hh} 获取成功但页面在后台，剪贴板写入失败 — 切回本页后下个周期自动重试`
          : "✗ 复制失败 — 页面失焦或剪贴板被占用，点一下页面再试", "#F0B90B");
      }
    } finally {
      pollBusy = false;
    }
  });
}

function onLoadClick() {
  return doFetchAndCopy("");
}

// ── auto-poll ─────────────────────────────────────────────────────────────
// Re-fetches on an interval so the clipboard always holds the freshest level
// string. gexdash refreshes its snapshot every 30s; the default is 1 minute.
function applyPoll(min) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (min > 0) {
    pollTimer = setInterval(() => doFetchAndCopy("[自动] ", true), min * 60000);
    doFetchAndCopy("[自动] ", true);
    setStatus(`自动刷新已开启：每 ${min} 分钟，最新字符串自动进剪贴板`, "#3B82F6");
  }
}

// ── drag (module-level; started from the guard, moved/ended on document) ──
function startDrag(e) {
  if (!panelEl) return;
  const r = panelEl.getBoundingClientRect();
  drag = { sx: e.clientX, sy: e.clientY, px: r.left, py: r.top };
  e.preventDefault(); // no text selection while dragging
}
function onDragMove(e) {
  if (!drag || !panelEl) return;
  let x = drag.px + (e.clientX - drag.sx);
  let y = drag.py + (e.clientY - drag.sy);
  const r = panelEl.getBoundingClientRect();
  x = Math.min(Math.max(8, x), window.innerWidth - r.width - 8);
  y = Math.min(Math.max(8, y), window.innerHeight - r.height - 8);
  panelEl.style.left = x + "px";
  panelEl.style.top = y + "px";
  panelEl.style.right = "auto";
}
function onDragEnd() {
  if (!drag || !panelEl) return;
  drag = null;
  const r = panelEl.getBoundingClientRect();
  savePos({ x: r.left, y: r.top });
}
document.addEventListener("pointermove", onDragMove);
document.addEventListener("pointerup", onDragEnd);

// ── EVENT ISOLATION GUARD ─────────────────────────────────────────────────
// Runs on window capture — the first possible interception point, ahead of
// every TradingView listener on document or below. Panel-originated events are
// stopped (so TradingView never interprets them as "clicked outside the
// dialog") and the panel's actions are dispatched here by delegation.
const GUARDED_EVENTS = [
  "pointerdown", "mousedown", "click", "touchstart",
  "contextmenu", "keydown", "keypress", "keyup",
];

function panelGuard(e) {
  const t = e.target;
  if (!t || !t.closest || !panelEl) return;
  if (!t.closest("#" + PANEL_ID)) return;

  // Blind TradingView (and anything else) to this event.
  e.stopPropagation();
  e.stopImmediatePropagation();

  // Keep focus inside the TradingView dialog: preventDefault on pointerdown
  // stops the browser from moving focus to our controls. Clicks still fire.
  // Exception: the <select> needs its native default to open the dropdown.
  if ((e.type === "pointerdown" || e.type === "mousedown") && !t.closest("select")) {
    e.preventDefault();
  }

  if (e.type === "click") {
    if (t.closest("#gextv-load")) {
      onLoadClick();
    } else if (t.closest(".gextv-collapse") && toggleCollapse) {
      toggleCollapse();
    }
  } else if (e.type === "pointerdown") {
    if (!t.closest("button, select") && t.closest(".gextv-header")) startDrag(e);
  }
}
GUARDED_EVENTS.forEach(type => window.addEventListener(type, panelGuard, true));

// ── panel ─────────────────────────────────────────────────────────────────
async function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const state = await loadState();

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panelEl = panel;
  if (state.pos) {
    panel.style.left = state.pos.x + "px";
    panel.style.top = state.pos.y + "px";
    panel.style.right = "auto";
  }

  // Header row = drag handle + collapse toggle.
  const header = document.createElement("div");
  header.className = "gextv-header";

  const title = document.createElement("span");
  title.className = "gextv-title";
  title.textContent = "GEXdash bridge";
  header.appendChild(title);

  const collapse = document.createElement("button");
  collapse.className = "gextv-collapse";
  collapse.title = "收起面板";
  collapse.textContent = "—";
  header.appendChild(collapse);
  panel.appendChild(header);

  // Body (collapsible).
  const body = document.createElement("div");
  body.className = "gextv-body";
  if (state.collapsed) body.style.display = "none";

  const select = document.createElement("select");
  for (const sym of ["SPX", "NDX", "QQQ", "SPY", "IWM", "RUT"]) {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = sym;
    select.appendChild(opt);
  }
  body.appendChild(select);

  const btn = document.createElement("button");
  btn.textContent = "加载并复制";
  btn.id = "gextv-load";
  body.appendChild(btn);

  // Auto-poll interval picker.
  const poll = document.createElement("select");
  poll.title = "自动刷新：定时拉新数据并复制到剪贴板（gexdash 每30秒更新，1分钟足够）";
  for (const [val, label] of [["0", "自动刷新：关"], ["1", "自动刷新：每1分钟"], ["5", "自动刷新：每5分钟"], ["15", "自动刷新：每15分钟"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    poll.appendChild(opt);
  }
  body.appendChild(poll);

  const status = document.createElement("div");
  status.id = "gextv-status";
  status.textContent = "就绪 — 「加载并复制」或开自动刷新，字符串自动进剪贴板";
  body.appendChild(status);

  panel.appendChild(body);
  document.body.appendChild(panel);

  toggleCollapse = () => {
    const show = body.style.display === "none";
    body.style.display = show ? "flex" : "none";
    collapse.textContent = show ? "—" : "+";
    collapse.title = show ? "收起面板" : "展开面板";
    saveCollapsed(!show);
  };
  if (state.collapsed) {
    body.style.display = "none";
    collapse.textContent = "+";
  }

  // 'change' is not a guarded event, so plain listeners work for the selects.
  select.addEventListener("change", () => saveDefaultSymbol(select.value));
  poll.addEventListener("change", () => {
    if (!extAlive()) return;
    const min = parseInt(poll.value, 10) || 0;
    chrome.storage.local.set({ [POLL_KEY]: min });
    applyPoll(min);
  });
  loadDefaultSymbol().then(sym => { select.value = sym; currentSymbol = sym; });
  if (extAlive()) chrome.storage.local.get([POLL_KEY], r => {
    // Default to 1 minute (gexdash refreshes every 30s) until the user saves
    // an explicit choice; an explicit 关 (0) stays off.
    const min = r[POLL_KEY] === undefined ? 1 : r[POLL_KEY];
    poll.value = String(min);
    if (min > 0) applyPoll(min);
  });
}

let installed = false;
function tryInstall() {
  if (installed || !document.body) return;
  buildPanel();
  installed = true;
}
tryInstall();
const pushState = history.pushState;
history.pushState = function (...args) {
  const r = pushState.apply(this, args);
  setTimeout(tryInstall, 600);
  return r;
};
window.addEventListener("popstate", () => setTimeout(tryInstall, 600));
