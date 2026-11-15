# Session finish notifications

A card in the bottom-right corner of your screen the moment a conversation you
are keeping an eye on finishes a turn. Watch several sessions, work elsewhere,
and let the desktop tell you when one is done.

## Use it

1. In the sidebar, right-click the session you want to follow.
2. Choose **结束时提醒** (English UI: *Notify when this session finishes*). A small
   bell appears on that session's row, and the menu entry now reads
   **已开启结束时提醒** with a green **开**.
3. Leave the session alone. When a turn closes — the assistant's output for that
   turn is complete and committed — a card appears in the bottom-right corner of
   the primary screen:

   > 会话标题
   > **此对话已结束**
   > 已完成 · 19:54 · 点击打开对话

   **Click the card** and it closes while DSH jumps to that conversation — the
   same session switch the sidebar does.

4. Turn it off by right-clicking that session again and choosing the same entry,
   or by clicking the bell on the row while it is visible.

**试弹一次提醒** in the same menu shows the card once with that session's title, so
you can check the look, the placement, and the click-to-open jump without
waiting for a turn.

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
- Follows the Windows light/dark app theme.
- Several cards at once stack upwards.

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
