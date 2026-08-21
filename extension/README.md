# GEXdash TradingView Bridge — Chrome extension

A small Manifest V3 extension that puts the **GEX Levels — gexdash** Pine indicator's data string on your clipboard with one click (or automatically on an interval), instead of copy-pasting it from the CLI.

TradingView's Pine sandbox cannot reach `gexdash.com`, so the indicator still only parses a string. This extension removes the manual fetch step: it pulls gexdash from the extension's background worker, builds the same level string the Python CLI does, and copies it to the clipboard. You paste it into the indicator's settings and click OK.

> v0.5 note: auto-fill into the indicator's textarea (and full-auto OK-clicking) was removed. TradingView renders its settings fields with framework-controlled, obfuscated DOM, which made programmatic fill fragile and fighting the settings dialog worse than pasting by hand. The clipboard path is deterministic and can't break when TradingView ships a DOM change.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, Arc).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open (or refresh) a TradingView chart that has the **GEX Levels — gexdash** indicator added; a small "GEXdash bridge" panel appears top-right.

## Use

1. Pick a symbol on the panel (SPX / NDX / QQQ / SPY / IWM / RUT).
2. Click **加载并复制 (Load & copy)** — or turn on **自动刷新** below. The level string lands in your clipboard.
3. Open the indicator's settings, paste into **GEX data string**, click **OK**.

### Auto-poll

- **自动刷新** re-fetches gexdash on an interval and refreshes the clipboard: 关 / 每1分钟 / 每5分钟 / 每15分钟. It defaults to **every 1 minute** — gexdash's own snapshot updates every 30 s, so one minute is enough — until you save an explicit choice; 关 turns it off and is remembered.
- Clipboard writes need the tab focused. While the TradingView tab is in the background Chrome blocks clipboard writes, so a tick that fires there reports a warning; switch back to the tab and the next tick copies again.

### After reloading/updating the extension

Chrome keeps the old content script alive in already-open tabs while its API bindings die, which surfaces as `Extension context invalidated.` The panel catches this on any chrome call, stops the poll timer, and shows 「扩展已重载或更新 — 请刷新 TradingView 页面后再用」. The fix is what it says: refresh the tab so a fresh script instance is injected.

## How it works

```
content.js (tradingview.com)  ──sendMessage({symbol})──▶  background.js (service worker)
        ▲                                                              │
        │ copy string to clipboard                                      │ fetch gexdash.com
        └──────────────  sendResponse(string)  ◀────────────────────────┘
```

- The fetch happens in the **background service worker**, not the content script. Chrome binds content scripts to the page's origin, so a content script on tradingview.com cannot fetch gexdash.com; the service worker can, with `host_permissions` set to `https://gexdash.com/`.
- The content script only sends a whitelisted symbol; it never constructs a URL or sees raw gexdash JSON. This follows Chrome's network-request security guidance — a malicious page cannot abuse the message channel to fetch arbitrary URLs.
- The analytics (max pain, OI walls, gamma extremes, OI P/C) and the string emitter are ported from `gextv/analytics.py` + `gextv/emit.py` so the extension and the CLI produce byte-identical strings. The comments in `background.js` mark the ports; keep them in sync if you change the Python.

## Permissions

- `storage` — remembers your last-used symbol and poll interval.
- `host_permissions: https://gexdash.com/` — the only network the extension touches. It never reads or writes anything on tradingview.com.

No analytics, no remote code, no permissions beyond these two.
