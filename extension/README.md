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
2. Open the indicator's settings (gear icon) so the **GEX data string** textarea is visible.
3. Click **Load GEX → chart**. The panel turns green and the field fills; if the field was not found, the string is copied to the clipboard with a yellow hint to paste it manually.

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
