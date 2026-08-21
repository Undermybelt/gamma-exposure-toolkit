// content.js — injected into tradingview.com.
//
// Adds a small floating panel with a symbol picker + "Load GEX" button. On
// click it asks the background worker for the level string and tries to find
// the Pine indicator's data textarea to paste it into. If the textarea isn't
// present (indicator not added, or settings not open), it falls back to
// copying to the clipboard so the user can paste manually into the field.

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

// ── textarea lookup (unchanged) ───────────────────────────────────────────
function findGexTextarea() {
  const candidates = Array.from(document.querySelectorAll("textarea"));
  for (const ta of candidates) {
    const hay = `${ta.placeholder || ""} ${ta.getAttribute("aria-label") || ""} ${ta.name || ""}`;
    if (/gex/i.test(hay)) return ta;
  }
  for (const ta of candidates) {
    let row = ta.closest("div");
    for (let i = 0; i < 6 && row; i++) {
      const text = row.textContent || "";
      if (/gex/i.test(text) && /string|data/i.test(text)) return ta;
      row = row.parentElement;
    }
  }
  const visible = candidates.filter(t => t.offsetParent !== null);
  if (visible.length) {
    return visible.reduce((a, b) => (a.cols * a.rows > b.cols * b.rows ? a : b));
  }
  return null;
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

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

async function onLoadClick(symbol) {
  setStatus("Fetching gexdash…", "#3B82F6");
  chrome.runtime.sendMessage({ type: "fetchGex", symbol }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus("Extension error: " + chrome.runtime.lastError.message, "#EF5350");
      return;
    }
    if (!resp || !resp.ok) {
      setStatus(resp && resp.error ? "Error: " + resp.error : "Fetch failed", "#EF5350");
      return;
    }
    const str = resp.string;
    const ta = findGexTextarea();
    if (ta) {
      setNativeValue(ta, str);
      setStatus(`Filled ${resp.snapshot.symbol} (${resp.snapshot.basis})`, "#26A69A");
    } else {
      const ok = copyToClipboard(str);
      setStatus(
        ok
          ? `Copied ${resp.snapshot.symbol} (${resp.snapshot.basis}) — paste into the GEX data field`
          : `Ready (${resp.snapshot.basis}) — could not auto-fill`,
        ok ? "#26A69A" : "#F0B90B"
      );
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
    const w = r.width, h = r.height;
    x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    y = Math.min(Math.max(8, y), window.innerHeight - h - 8);
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
  collapse.title = "Hide panel";
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
  btn.textContent = "Load GEX → chart";
  btn.id = "gextv-load";
  body.appendChild(btn);

  const status = document.createElement("div");
  status.id = "gextv-status";
  status.textContent = "ready";
  body.appendChild(status);

  panel.appendChild(body);
  document.body.appendChild(panel);

  // Collapse: hide body, swap glyph, persist. When collapsed the panel is just
  // the header bar — small footprint that can still be dragged and re-expanded.
  const applyCollapsed = (c) => {
    body.style.display = c ? "none" : "flex";
    collapse.textContent = c ? "+" : "—";
    collapse.title = c ? "Show panel" : "Hide panel";
    saveCollapsed(c);
  };
  applyCollapsed(state.collapsed);
  collapse.addEventListener("click", () => applyCollapsed(body.style.display === "none" ? false : true));

  btn.addEventListener("click", () => onLoadClick(select.value));
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
