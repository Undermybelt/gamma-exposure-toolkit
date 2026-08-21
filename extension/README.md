# GEXdash TradingView Bridge — Chrome extension

A small Manifest V3 extension that lets you fill the **GEX Levels — gexdash** Pine indicator's data field on TradingView with one click, instead of copy-pasting the string from the CLI.

TradingView's Pine sandbox cannot reach `gexdash.com`, so the indicator still only parses a string. This extension removes the copy-paste step: it fetches gexdash from the extension's background worker, builds the same level string the Python CLI does, and pastes it straight into the indicator's settings textarea — falling back to the clipboard if it cannot find the field.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, Arc).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open (or refresh) a TradingView chart that has the **GEX Levels — gexdash** indicator added, open its settings, and a small "GEXdash bridge" panel appears top-right.

## Use

1. Pick a symbol on the panel (SPX / NDX / QQQ / SPY / IWM / RUT).
2. **Open the indicator's settings** (gear icon) so the **GEX data string** textarea exists on the page — no fill is possible while the dialog is closed.
3. Click **加载并填入 (Load & fill)**. On success the field is written and the string is *also* copied to the clipboard; click **OK** in the settings dialog to save.
4. If auto-fill misses, the string is already in your clipboard — just Ctrl/Cmd-V into the field. To stop relying on the DOM heuristics altogether, click **绑定输入框 (Bind field)**, then click the GEX data textarea once; the extension binds that exact element for this page load and fills it directly on every subsequent 「加载并填入」.

### Auto-poll and full-auto

- **自动刷新** re-fetches gexdash on an interval and rewrites the field. It defaults to **every 1 minute** — gexdash's own snapshot updates every 30 s, so one minute is enough — until you save an explicit choice; 关 turns it off and is remembered.
- **全自动·仅RTH（自动开设置+点OK）** closes the loop: after filling the field it clicks the settings dialog's OK button for you, and when the dialog is closed it reopens it through the indicator's ⚙ button. To arm that path, click **绑定输入框** and then click the ⚙ button (instead of the textarea) — the extension binds it as the reopen handle. With full-auto on, data flows from gexdash to a committed chart with zero manual steps; if the OK button can't be found, the status line says so and the string is still in the clipboard.
- **Full-auto runs only during US Eastern regular hours** (Mon–Fri 09:30–16:00 America/New_York, checked via the browser's own timezone database). Outside RTH the automatic tick skips entirely — gexdash serves the prior-close chain then, and auto-OK would just re-commit stale data. Manual 「加载并填入」 clicks work at any hour.

### After reloading/updating the extension

Chrome keeps the old content script alive in already-open tabs while its API bindings die, which surfaces as `Extension context invalidated.` The panel now catches this on any chrome call, stops the poll timer, and shows 「扩展已重载或更新 — 请刷新 TradingView 页面后再用」. The fix is what it says: refresh the tab so a fresh script instance is injected.

### Why there are two fill paths

TradingView renders its settings fields with obfuscated class names that change between releases, and the fields are framework-controlled — a plain `.value =` assignment is often ignored or reverted. The extension therefore:

- writes through `document.execCommand("insertText")` (the browser's real editing pipeline, which framework-controlled inputs always observe), with a native-setter + dispatched `input`/`change` events as fallback, and verifies the field content afterwards;
- prefers a **user-bound target** (pick mode) over any selector guess, so a TradingView DOM update can't silently break the fill;
- always copies to the clipboard first, so the worst case is a manual paste, never a lost fetch.

The heuristic lookup tries, in order: a textarea whose attributes mention "GEX"; a visible textarea whose surrounding row text mentions "GEX"; the largest visible textarea; the same search repeated through shadow roots. When it misses, bind the field once with 「绑定输入框」 and the heuristics no longer matter.

## How it works

```
content.js (tradingview.com)  ──sendMessage({symbol})──▶  background.js (service worker)
        ▲                                                              │
        │ paste string into textarea                                    │ fetch gexdash.com
        └──────────────  sendResponse(string)  ◀────────────────────────┘
```

- The fetch happens in the **background service worker**, not the content script. Chrome binds content scripts to the page's origin, so a content script on tradingview.com cannot fetch gexdash.com; the service worker can, with `host_permissions` set to `https://gexdash.com/`.
- The content script only sends a whitelisted symbol; it never constructs a URL or sees raw gexdash JSON. This follows Chrome's network-request security guidance — a malicious page cannot abuse the message channel to fetch arbitrary URLs.
- The analytics (max pain, OI walls, gamma extremes, OI P/C) and the string emitter are ported from `gextv/analytics.py` + `gextv/emit.py` so the extension and the CLI produce byte-identical strings. The comments in `background.js` mark the ports; keep them in sync if you change the Python.

## Why the textarea lookup is "best-effort"

TradingView renders settings textareas without a stable id, inside scoped DOM, and the markup changes between releases. The lookup tries, in order: textarea whose label/placeholder mentions "GEX", a textarea whose settings row mentions "GEX"/"string", and finally the largest visible textarea on the settings panel. When it misses, the clipboard fallback still hands you the string. If the auto-fill stops working after a TradingView update, `findGexTextarea()` in `content.js` is the one function to adjust.

## Permissions

- `storage` — remembers your last-used symbol.
- `host_permissions: https://gexdash.com/` — the only network the extension touches. It never reads or writes to tradingview.com beyond pasting into the textarea you point it at.

No analytics, no remote code, no permissions beyond these two.
