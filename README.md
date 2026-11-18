# Session finish notifications

A card in the bottom-right corner of your screen the moment a conversation you
are keeping an eye on finishes a turn. Watch several sessions, work elsewhere,
and let the desktop tell you when one is done.

## Use it

1. In the sidebar, right-click the session you want to follow.
2. The menu carries one row, **会话提醒设置 ›** (*Session notifications*). Point at
   it to open its submenu, which holds both actions:
   - **结束时提醒** — start following this session; a small bell appears on its row;
   - **试弹一次提醒** — show one sample card with this session's title, so you can
     check the look, the placement, and the click-to-open jump right away.
3. While the watch is on, the parent row reads **会话提醒设置 · 开** and the child
   reads **已开启结束时提醒**, so the state is visible at a glance.
4. Leave the session alone. When a turn closes — the assistant's output for that
   turn is complete and committed — a card appears in the bottom-right corner of
   the primary screen:

   > 会话标题
   > **此对话已结束**
   > 已完成 · 19:54 · 点击打开对话

   **Click the card** and it closes while DSH jumps to that conversation — the
   same session switch the sidebar does.

5. Turn it off through the same submenu, or by clicking the bell on the row while
   it is visible.

Watching more than one session is fine: each finished turn gets its own card,
and cards stack upwards instead of covering each other.

## What triggers it

The Host listens for the durable `turn/end` event of a watched session's log and
nothing else, so the card never appears mid-stream: it waits until that turn's
output is complete and committed. This fires for every turn while the watch is
on, including a turn that ends with an error or a stop — the accent turns amber
for a stop and red for an error, while the message stays *此对话已结束*.

## The card

- Borderless, always on top, bottom-right of the primary screen's working area.
- Never takes focus, so typing continues in whatever window you are in.
- Slides in, closes itself after 8 s, or closes immediately when clicked.
- A click also posts the session id back to the Host, which asks the page to
  open that conversation; the card disappears first so the jump feels instant.
- Follows the **DSH theme**, not the OS one: the page reports
  `body[data-ds-dark-theme]` to the Host, which passes `-Theme dark|light`
  explicitly. `auto` (read the Windows app theme) stays only as the fallback for
  a Host that no page ever reported to, so a dark DSH on a light Windows still
  matches.
- At most four cards sit on screen at once; a fifth closes the top one early —
  **no notification is lost**, that card had already been shown, and the newest
  one stays visible instead of hiding behind it.

## For other plugins

A plugin can watch a session on the user's behalf through the same write path the
sidebar menu uses — one `session-notify.json`, one SSE stream, event name
`watched` — so there is never a second source of truth.

```bash
# watch
curl -s -X POST "http://127.0.0.1:$PORT/session-notify/watch" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxx","on":true}'
# → {"ok":true,"sessionId":"session-xxxx","watching":true}

# unwatch
curl -s -X POST "http://127.0.0.1:$PORT/session-notify/watch" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxx","on":false}'
# → {"ok":true,"sessionId":"session-xxxx","watching":false}

# read the list back
curl -s "http://127.0.0.1:$PORT/session-notify"
# → {"ok":true,"watched":{"session-xxxx":{"title":"…","locale":"zh",…}}}
```

| Case | Behaviour |
| --- | --- |
| `on` is not a boolean, `sessionId` missing, bad JSON | `400 {"ok":false,"error":…}`, nothing written |
| Cross-origin caller | `403`, nothing written |
| Not `POST` | `405` |
| **No live session for that id on this Host** | `200 {"ok":true,"watching":false,"reason":"unknown-session"}`, nothing written |
| Repeated `on:true` / `on:false` | unchanged result, no second write, no second event |

Caller notes:

- `sessionId` must belong to a session that is **live on this Host** (checked with
  `ctx.sessions.get()`); a closed session or one never opened answers `unknown-session`.
- `$PORT` is DSH's web address and can change on every desktop launch.
- The caller need not send a title: the browser half fills it in when a page is open.
- Watching only adds the finish card; the menu toggle still belongs to the user.

## Self-test

The plugin's own detail page (**Settings → Plugins → Session finish notifications**)
carries a **自检 / Self-test** section that answers "is this plugin working right now?"

| Check | Passes when |
| --- | --- |
| Host routes (GET /session-notify) | 200 and the answer carries a `watched` object |
| Event stream (/session-notify/events) | the first frame arrives within 2 s; skipped when the page has no EventSource |
| Sample card (/session-notify/test) | the Host answers `shown: true` |
| Theme endpoint (/session-notify/theme) | a bad value must be refused with 400 (a probe only; the card's real theme is untouched) |

- **Nothing runs until you press 运行自检** — opening the page sends no request.
- Each check has a 2 s budget (AbortController); a failure shows its reason and
  leaves the other rows alone.
- 弹一张示例卡 shows one card immediately; 复制结果 copies the result as Markdown
  (`- [x] label — Pass` / `- [ ] label — Fail: reason`).

## Configuration

The row in `cordis.patch.yml` carries the tunables:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Keep the watch list but draw no cards. |
| `durationMs` | `8000` | How long one card stays (1200–60000). |
| `sticky` | `false` | Keep the card until it is clicked. |
| `powershell` | — | Absolute path to `powershell.exe` when it is not in the system directory. |

Adding `-LogPath <file>` to a manual `popup.ps1` run writes one line per
lifecycle step, which is the fastest way to answer "why did no card appear".

## Requirements and limits

- **Windows only.** The card is a PowerShell 5.1 + WinForms window. On other
  platforms the plugin keeps the durable watch list and the trigger, and simply
  draws nothing.
- The DSH **Host process** must be running — the card is drawn outside the Web
  page, so a background or tray-resident app keeps notifying, and a fully quit
  app does not.
- Drawing starts a short-lived `powershell.exe` (~0.5–1 s to the card being
  visible). Corporate script policies are bypassed for this single file with
  `-ExecutionPolicy Bypass`; endpoint protection that blocks PowerShell will
  block the card, and the DSH log then carries a `[session-notify]` warning.
- The watch list lives in `session-notify.json` under the DSH home, so it
  survives restarts and reloads. Nothing is sent anywhere.

## Files

| file | role |
| --- | --- |
| `index.js` | Host: watch file, `/session-notify` routes, SSE, turn trigger, launcher. |
| `client.js` | Browser: the menu entries and the row bell. |
| `popup.ps1` | The card itself: geometry, theme, stacking, dismissal. |
| `demo/preview.ps1` | Show the card once with sample text. |
| `test/host.test.mjs` | Host routes, durability, and the trigger, with a spawn seam. |
| `test/client.logic.test.mjs` | Client slots driven against the real Host over a fake `fetch`. |
| `test/shot.ps1` | Screenshot harness for the card. |

```powershell
node --test test/host.test.mjs
node --test test/client.logic.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File demo\preview.ps1
```

## Install from GitHub

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-notify
```

Reload the Web UI page after installing.
