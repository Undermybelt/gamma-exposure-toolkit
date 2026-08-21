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

const DEFAULT_SYMBOL_KEY = "gextv:defaultSymbol";
const POSITION_KEY = "gextv:panelPos"; // {x, y}
const COLLAPSED_KEY = "gextv:panelCollapsed";
const PANEL_ID = "gextv-bridge-panel";

// ── persistence helpers ───────────────────────────────────────────────────
function loadDefaultSymbol() {
  return new Promise(resolve => chrome.storage.local.get(DEFAULT_SYMBOL_KEY, r =>
    resolve(r[DEFAULT_SYMBOL_KEY] || "QQQ")));
}
function saveDefaultSymbol(sym) {
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
let boundTarget = null; // element reference, valid until page reload
let pickMode = false;

function setStatus(text, color) {
  const el = document.getElementById("gextv-status");
  if (el) { el.textContent = text; el.style.color = color || "#787B86"; }
}

function onPickClick(e) {
  if (e.target.closest && e.target.closest("#" + PANEL_ID)) {
    exitPickMode();
    setStatus("已取消绑定");
    return;
  }
  const el = e.target.closest && e.target.closest("textarea, input[type='text'], input:not([type])");
  if (el) {
    boundTarget = el;
    setStatus("已绑定目标输入框 ✓ 点「加载并填入」试试", "#26A69A");
  } else {
    setStatus("没点到输入框，已退出绑定模式", "#F0B90B");
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
  setStatus("绑定模式：先打开指标设置，再点一下 GEX 数据输入框（Esc 取消）", "#3B82F6");
  document.addEventListener("click", onPickClick, true);
  document.addEventListener("keydown", onPickKey, true);
}

function exitPickMode() {
  pickMode = false;
  document.removeEventListener("click", onPickClick, true);
  document.removeEventListener("keydown", onPickKey, true);
}

// ── load + fill ───────────────────────────────────────────────────────────
async function onLoadClick(symbol) {
  setStatus("正在从 gexdash 获取…", "#3B82F6");
  chrome.runtime.sendMessage({ type: "fetchGex", symbol }, async (resp) => {
    if (chrome.runtime.lastError) {
      setStatus("扩展错误: " + chrome.runtime.lastError.message, "#EF5350");
      return;
    }
    if (!resp || !resp.ok) {
      setStatus(resp && resp.error ? "错误: " + resp.error : "获取失败", "#EF5350");
      return;
    }

    // Guaranteed fallback first: the string always lands in the clipboard,
    // whatever happens to the auto-fill below.
    const copied = await copyToClipboard(resp.string);

    const ta =
      (boundTarget && document.contains(boundTarget)) ? boundTarget : findGexTextarea();

    if (ta && setTextareaValue(ta, resp.string)) {
      setStatus(`✓ 已填入 ${resp.snapshot.symbol}（${resp.snapshot.basis}）· 也已复制 · 记得点 OK 保存`,
        "#26A69A");
    } else if (copied) {
      setStatus("⚠ 未能自动写入 — 字符串已在剪贴板。打开指标设置后 Ctrl+V 粘贴；或点「绑定输入框」后重试",
        "#F0B90B");
    } else {
      setStatus("✗ 自动复制也失败了，请在面板里手动操作", "#EF5350");
    }
  });
}

// ── drag handler (pointer events, clamped to the viewport) ────────────────
function makeDraggable(panel, handle, applyPos) {
  let dragging = false, sx = 0, sy = 0, px = 0, py = 0;
  const start = (e) => {
    if (e.target.closest("button, select")) return; // don't drag from controls
    dragging = true;
    const r = panel.getBoundingClientRect();
    px = r.left; py = r.top;
    sx = e.clientX; sy = e.clientY;
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    let x = px + (e.clientX - sx);
    let y = py + (e.clientY - sy);
    const r = panel.getBoundingClientRect();
    x = Math.min(Math.max(8, x), window.innerWidth - r.width - 8);
    y = Math.min(Math.max(8, y), window.innerHeight - r.height - 8);
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.right = "auto";
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const r = panel.getBoundingClientRect();
    applyPos({ x: r.left, y: r.top });
  };
  handle.addEventListener("pointerdown", start);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
}

// ── panel ─────────────────────────────────────────────────────────────────
async function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const state = await loadState();

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
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
  pick.title = "手动指定要填写的输入框（推荐，一劳永逸）";
  body.appendChild(pick);

  const status = document.createElement("div");
  status.id = "gextv-status";
  status.textContent = "就绪 — 用前先打开指标的设置(齿轮)";
  body.appendChild(status);

  panel.appendChild(body);
  document.body.appendChild(panel);

  const applyCollapsed = (c) => {
    body.style.display = c ? "none" : "flex";
    collapse.textContent = c ? "+" : "—";
    collapse.title = c ? "展开面板" : "收起面板";
    saveCollapsed(c);
  };
  applyCollapsed(state.collapsed);
  collapse.addEventListener("click", () => applyCollapsed(body.style.display === "none" ? false : true));

  btn.addEventListener("click", () => onLoadClick(select.value));
  pick.addEventListener("click", enterPickMode);
  select.addEventListener("change", () => saveDefaultSymbol(select.value));
  loadDefaultSymbol().then(sym => { select.value = sym; });

  makeDraggable(panel, header, savePos);
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
