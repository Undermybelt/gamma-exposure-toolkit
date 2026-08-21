// content.js — injected into tradingview.com.
//
// Adds a small floating panel with a symbol picker + "Load GEX" button. On
// click it asks the background worker for the level string and tries to find
// the Pine indicator's data textarea to paste it into. If the textarea isn't
// present (indicator not added, or settings not open), it falls back to
// copying to the clipboard so the user can paste manually into the field.

const DEFAULT_SYMBOL_KEY = "gextv:defaultSymbol";
const PANEL_ID = "gextv-bridge-panel";

function loadDefaultSymbol() {
  return new Promise(resolve => chrome.storage.local.get(DEFAULT_SYMBOL_KEY, r =>
    resolve(r[DEFAULT_SYMBOL_KEY] || "QQQ")));
}

function saveDefaultSymbol(sym) {
  chrome.storage.local.set({ [DEFAULT_SYMBOL_KEY]: sym });
}

// The Pine indicator's "GEX data string" input is a textarea. TradingView's
// settings panel renders these as <textarea> elements, but it is buried inside
// a shadow/scoped DOM and has no stable id. We look for a textarea whose data
// attribute or nearby label text mentions "GEX", and as a last resort any
// textarea in a visible settings dialog. This is the inherently fragile part —
// it must track TradingView's DOM, which changes. When it breaks, the
// clipboard fallback still carries the user.
function findGexTextarea() {
  const candidates = Array.from(document.querySelectorAll("textarea"));
  // 1. explicit match on the data area's tooltip/placeholder/label text.
  for (const ta of candidates) {
    const hay = `${ta.placeholder || ""} ${ta.getAttribute("aria-label") || ""} ${ta.name || ""}`;
    if (/gex/i.test(hay)) return ta;
  }
  // 2. walk up to the settings row and check its label text.
  for (const ta of candidates) {
    let row = ta.closest("div");
    for (let i = 0; i < 6 && row; i++) {
      const text = row.textContent || "";
      if (/gex/i.test(text) && /string|data/i.test(text)) return ta;
      row = row.parentElement;
    }
  }
  // 3. last resort: the largest textarea in a visible dialog (the data-area
  //    input is always multi-line and the biggest one on the panel).
  const visible = candidates.filter(t => t.offsetParent !== null);
  if (visible.length) {
    return visible.reduce((a, b) => (a.cols * a.rows > b.cols * b.rows ? a : b));
  }
  return null;
}

function setNativeValue(el, value) {
  // TradingView uses React; a plain `.value =` won't trigger React's onChange.
  // We set the value through the native input setter and dispatch an input
  // event so React's synthetic handler picks it up.
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API can be blocked on non-focused frames; fall back to execCommand.
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

function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const select = document.createElement("select");
  for (const sym of ["SPX", "NDX", "QQQ", "SPY", "IWM", "RUT"]) {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = sym;
    select.appendChild(opt);
  }
  panel.appendChild(select);

  const btn = document.createElement("button");
  btn.textContent = "Load GEX → chart";
  btn.id = "gextv-load";
  panel.appendChild(btn);

  const status = document.createElement("div");
  status.id = "gextv-status";
  status.textContent = "ready";
  panel.appendChild(status);

  btn.addEventListener("click", () => onLoadClick(select.value));
  select.addEventListener("change", () => saveDefaultSymbol(select.value));

  loadDefaultSymbol().then(sym => { select.value = sym; });
  document.body.appendChild(panel);
}

// TradingView is an SPA; (re)inject the panel when the page settles. A
// MutationObserver is overkill and noisy; a debounced re-check on pushState
// is enough.
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
