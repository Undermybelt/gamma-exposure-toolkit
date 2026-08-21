// content.js — injected into tradingview.com.
//
// Flow: pick symbol → 「加载并填入」 asks the background worker for the level
// string, ALWAYS copies it to the clipboard (guaranteed fallback), then tries
// to write it into the indicator's "GEX data string" textarea.
//
// Write target, in priority order:
//   1. the textarea bound via 「绑定输入框」 pick mode — the user clicks the
//      field once and we hold the reference for this page load. Robust against
//      any TradingView DOM change, because the user, not a selector, chooses.
//   2. heuristics: textarea whose attributes or nearby title text mention GEX
//   3. the largest visible textarea (while the settings dialog is open it
//      hosts the only large one)
//
// If every write misses, the clipboard copy has already succeeded — paste
// manually. Note no fill is possible unless the indicator's settings dialog
// is open; the status line says so when we cannot find a field.
//
// EVENT ISOLATION: TradingView closes its settings dialog whenever a
// pointer/keyboard event originates outside the dialog. Our floating panel is
// outside it, so every panel click used to close the dialog before a fill
// could run. panelGuard() below intercepts panel-originated events at the
// window capture phase — before any TradingView handler can see them — and
// routes the panel's own actions by delegation (stopping propagation at window
// also prevents the panel's own element-level listeners from firing, so
// delegation in the guard is the only way to handle them).

const DEFAULT_SYMBOL_KEY = "gextv:defaultSymbol";
const POSITION_KEY = "gextv:panelPos"; // {x, y}
const COLLAPSED_KEY = "gextv:panelCollapsed";
const POLL_KEY = "gextv:pollMin";      // 0 = off, else minutes
const AUTO_KEY = "gextv:autoFull";     // full-auto: open settings + click OK
const PANEL_ID = "gextv-bridge-panel";

// Module state shared by the guard and the UI.
let panelEl = null;
let currentSymbol = "QQQ";
let toggleCollapse = null;
let drag = null;
let boundTarget = null; // element reference, valid until page reload
let openerEl = null;    // indicator settings (⚙) button, for full-auto reopen
let autoFull = false;   // full-auto mode: fill + auto-OK, reopening via openerEl
let pickMode = false;
let pollTimer = null;
let pollBusy = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── persistence helpers ───────────────────────────────────────────────────
function loadDefaultSymbol() {
  return new Promise(resolve => chrome.storage.local.get(DEFAULT_SYMBOL_KEY, r =>
    resolve(r[DEFAULT_SYMBOL_KEY] || "QQQ")));
}
function saveDefaultSymbol(sym) {
  currentSymbol = sym;
  chrome.storage.local.set({ [DEFAULT_SYMBOL_KEY]: sym });
}
function loadState() {
  return new Promise(resolve => chrome.storage.local.get(
    [POSITION_KEY, COLLAPSED_KEY], r => resolve({
      pos: r[POSITION_KEY] || null,
      collapsed: r[COLLAPSED_KEY] || false,
    })));
}
function savePos(pos) { chrome.storage.local.set({ [POSITION_KEY]: pos }); }
function saveCollapsed(c) { chrome.storage.local.set({ [COLLAPSED_KEY]: c }); }

// ── clipboard ─────────────────────────────────────────────────────────────
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

// ── textarea discovery ────────────────────────────────────────────────────
function isVisible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function boxArea(el) {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

// querySelectorAll that also descends into shadow roots. Only used when the
// plain lookups fail, so the O(all-elements) walk is rare.
function deepQueryAll(selector) {
  const out = [];
  const walk = (root) => {
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
}

function findGexTextarea() {
  const tas = Array.from(document.querySelectorAll("textarea"));

  // 1. Strongest signal: the field itself carries a GEX hint.
  for (const ta of tas) {
    const hay = `${ta.placeholder || ""} ${ta.getAttribute("aria-label") || ""} ${ta.name || ""} ${ta.id || ""}`;
    if (/gex/i.test(hay)) return ta;
  }

  // 2. Nearby title text: TradingView renders the input title ("GEX data
  //    string") as a sibling label inside a shared row container. Climb a few
  //    ancestors and look for it; require the field to be visible so hidden
  //    templates don't win.
  for (const ta of tas) {
    if (!isVisible(ta)) continue;
    let row = ta.parentElement;
    for (let i = 0; i < 8 && row && row !== document.body; i++) {
      if (/gex/i.test(row.textContent || "")) return ta;
      row = row.parentElement;
    }
  }

  // 3. Last resort: the largest visible textarea. While the indicator settings
  //    dialog is open it hosts the only multi-line field on the page.
  const vis = tas.filter(isVisible);
  if (vis.length) return vis.reduce((a, b) => (boxArea(b) > boxArea(a) ? b : a));

  // 4. Everything above missed — maybe the dialog lives in a shadow root.
  const deep = deepQueryAll("textarea").filter(isVisible);
  if (deep.length) return deep.reduce((a, b) => (boxArea(b) > boxArea(a) ? b : a));

  return null;
}

// ── writing the value ─────────────────────────────────────────────────────
// TradingView's settings fields are framework-controlled. Assigning .value
// directly often gets ignored or reverted. execCommand("insertText") goes
// through the browser's real editing pipeline (beforeinput/input events, undo
// stack), which every framework observes — it is the most reliable programmatic
// "typing". Native setter + dispatched events remain as fallback, and we
// verify the result either way.
function setTextareaValue(ta, value) {
  try {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, value); } catch {}
    if (!inserted || ta.value !== value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    }
    ta.blur();
    return ta.value === value;
  } catch {
    return false;
  }
}

// ── pick mode: bind the target field by clicking it ───────────────────────
function setStatus(text, color) {
  const el = document.getElementById("gextv-status");
  if (el) { el.textContent = text; el.style.color = color || "#787B86"; }
}

function onPickClick(e) {
  // Two kinds of targets: the data textarea (fill target) or the indicator's
  // ⚙ settings button (opener, used by full-auto to reopen the dialog).
  const ta = e.target.closest && e.target.closest("textarea");
  const btn = !ta && e.target.closest && e.target.closest("button");
  if (ta) {
    boundTarget = ta;
    setStatus("已绑定输入框 ✓ 打开设置后点「加载并填入」", "#26A69A");
  } else if (btn) {
    openerEl = btn;
    setStatus("已绑定设置按钮 ⚙ 全自动模式将经它打开设置", "#26A69A");
  } else {
    setStatus("没点到输入框或⚙按钮，已退出绑定模式", "#F0B90B");
  }
  exitPickMode();
  // Do not preventDefault: let the click focus the field as usual.
}

function onPickKey(e) {
  if (e.key === "Escape") {
    exitPickMode();
    setStatus("已取消绑定（Esc）");
  }
}

function enterPickMode() {
  if (pickMode) return;
  pickMode = true;
  setStatus("绑定模式：点数据输入框，或点指标的⚙按钮（全自动用）；Esc 取消", "#3B82F6");
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
}

function exitPickMode() {
  pickMode = false;
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
}

// ── load + fill ───────────────────────────────────────────────────────────
// Find and click the settings dialog's OK/确定 button so a full-auto poll
// commits without manual action. Climbs from the textarea to the dialog
// container; matches the button by exact text (locale-tolerant).
function clickDialogOk(ta) {
  let node = ta;
  for (let i = 0; i < 14 && node && node !== document.body; i++) {
    const btns = node.querySelectorAll ? node.querySelectorAll("button") : [];
    for (const b of btns) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (t === "ok" || t === "确定" || t === "o.k.") { b.click(); return true; }
    }
    node = node.parentElement;
  }
  return false;
}

async function doFetchAndFill(prefix) {
  if (pollBusy) return;
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

      // Guaranteed fallback first: the string always lands in the clipboard,
      // whatever happens to the auto-fill below.
      const copied = await copyToClipboard(resp.string);

      const hh = new Date().toTimeString().slice(0, 5);
      let ta =
        (boundTarget && document.contains(boundTarget) && isVisible(boundTarget))
          ? boundTarget : findGexTextarea();

      // Full-auto: if no field is visible, reopen the dialog via the bound ⚙.
      let reopened = false;
      if (!ta && autoFull && openerEl && document.contains(openerEl)) {
        openerEl.click();
        await sleep(600); // dialog render is async
        ta = findGexTextarea();
        reopened = true;
      }

      if (ta && setTextareaValue(ta, resp.string)) {
        let extra = "";
        if (autoFull) {
          await sleep(150);
          extra = clickDialogOk(ta) ? " · 已自动OK" : " · 未找到OK按钮，请手动点";
        } else if (!reopened) {
          extra = " · 记得点 OK 保存";
        }
        setStatus(`✓ ${hh} 已填入 ${resp.snapshot.symbol}（${resp.snapshot.basis}）${extra}`,
          "#26A69A");
      } else if (copied) {
        setStatus(`⚠ ${hh} 未能自动写入 — 已复制到剪贴板，Ctrl+V 粘贴`, "#F0B90B");
      } else {
        setStatus("✗ 自动复制也失败了", "#EF5350");
      }
    } finally {
      pollBusy = false;
    }
  });
}

function onLoadClick() {
  return doFetchAndFill("");
}

// ── auto-poll ─────────────────────────────────────────────────────────────
// Re-fetches on an interval and refreshes both the clipboard and the bound
// field. Note the honest limits: writing only lands while a settings dialog
// with the field is open; the clipboard is always fresh regardless. The
// dialog's OK button is never clicked automatically.
function applyPoll(min) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (min > 0) {
    pollTimer = setInterval(() => doFetchAndFill("[自动] "), min * 60000);
    doFetchAndFill("[自动] ");
    setStatus(`自动刷新已开启：每 ${min} 分钟（写入需设置框开着；剪贴板始终更新）`, "#3B82F6");
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
    if (pickMode) { // clicking our panel during pick mode = cancel
      exitPickMode();
      setStatus("已取消绑定");
    } else if (t.closest("#gextv-load")) {
      onLoadClick();
    } else if (t.closest(".gextv-secondary")) {
      enterPickMode();
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
  btn.textContent = "加载并填入";
  btn.id = "gextv-load";
  body.appendChild(btn);

  const pick = document.createElement("button");
  pick.textContent = "绑定输入框";
  pick.className = "gextv-secondary";
  pick.title = "点数据输入框=手动模式绑定；点指标标题旁的⚙=全自动模式的设置入口（一劳永逸）";
  body.appendChild(pick);

  // Auto-poll interval picker.
  const poll = document.createElement("select");
  poll.title = "自动刷新：定时拉新数据并写入（gexdash 每30秒更新，1分钟足够）";
  for (const [val, label] of [["0", "自动刷新：关"], ["1", "自动刷新：每1分钟"], ["5", "自动刷新：每5分钟"], ["15", "自动刷新：每15分钟"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    poll.appendChild(opt);
  }
  body.appendChild(poll);

  // Full-auto toggle: fill + auto-OK, reopening the dialog via the bound ⚙.
  const autoWrap = document.createElement("label");
  autoWrap.style.display = "flex";
  autoWrap.style.alignItems = "center";
  autoWrap.style.gap = "6px";
  autoWrap.title = "全自动：填入后自动点OK提交；设置框没开时经绑定的⚙按钮自动打开。先用「绑定输入框」点一下指标的⚙。";
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.style.margin = "0";
  autoWrap.appendChild(autoCb);
  autoWrap.appendChild(document.createTextNode("全自动（自动开设置+点OK）"));
  body.appendChild(autoWrap);

  const status = document.createElement("div");
  status.id = "gextv-status";
  status.textContent = "就绪 — 用前先打开指标的设置(齿轮)";
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
    const min = parseInt(poll.value, 10) || 0;
    chrome.storage.local.set({ [POLL_KEY]: min });
    applyPoll(min);
  });
  autoCb.addEventListener("change", () => {
    autoFull = autoCb.checked;
    chrome.storage.local.set({ [AUTO_KEY]: autoFull });
    if (autoFull && !openerEl && !boundTarget)
      setStatus("全自动已开：先用「绑定输入框」点一下指标的⚙按钮", "#F0B90B");
  });
  loadDefaultSymbol().then(sym => { select.value = sym; currentSymbol = sym; });
  chrome.storage.local.get([POLL_KEY, AUTO_KEY], r => {
    // Default to 1 minute (gexdash refreshes every 30s) until the user saves
    // an explicit choice; an explicit 关 (0) stays off.
    const min = r[POLL_KEY] === undefined ? 1 : r[POLL_KEY];
    poll.value = String(min);
    if (min > 0) applyPoll(min);
    autoFull = !!r[AUTO_KEY];
    autoCb.checked = autoFull;
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
