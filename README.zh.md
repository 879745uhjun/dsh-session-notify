# 会话结束提醒

盯着的那个会话一跑完，屏幕右下角就弹一张卡片告诉你。可以同时盯几个会话，自己该干嘛干嘛。

## 怎么用

1. 在左侧会话列表里，**右键**你想盯的那个会话。
2. 菜单里只有一行 **会话提醒设置 ›**，鼠标移上去展开下一级菜单，里面有两项：
   - **结束时提醒** —— 点一下开始盯这个会话（会话行上会出现小铃铛）；
   - **试弹一次提醒** —— 立刻用这个会话的标题弹一张示例卡，先看效果、确认位置，顺便试点击跳转。
3. 开启后，菜单父项会显示 **会话提醒设置 · 开**，子项变成 **已开启结束时提醒**，一眼就能看出状态。
4. 然后就不用管它了。当这个会话的某一轮真正结束（助手这一轮的输出已经完整写进会话记录）时，
   主屏右下角会弹出：

   > 会话标题
   > **此对话已结束**
   > 已完成 · 19:54 · 点击打开对话

   **点一下卡片**：卡片立刻关闭，同时 DSH 跳到那个对话（和点侧边栏会话是同一个动作）。

5. 想关掉：再右键该会话 → 会话提醒设置 → **已开启结束时提醒**；或者在会话行的小铃铛可见时点它。

可以同时盯多个会话：各自结束各自弹，多张卡会向上堆叠，不会互相盖住。

## 什么时候弹

Host 只监听被盯会话日志里**已经提交**的 `turn/end` 事件，所以卡片绝不会在流式输出中途冒出来：
它等到这一轮的输出结束、落盘之后才弹。关注期间每一轮结束都会弹一次，包括出错或被中断的那一轮
——提示语始终是「此对话已结束」，只是左侧强调色会变成琥珀色（中断）或红色（出错）。

## 卡片本身

- 无边框、置顶，固定在主屏工作区右下角。
- **不会抢焦点**，你正在别的窗口打字时不会被打断。
- 滑入后自动在 8 秒后关闭，点一下立即关闭。
- 点击时还会把会话 id 发回 Host，由它让页面打开那个对话；卡片先消失，所以跳转感觉是即时的。
- 跟随 **DSH 主题**：页面把 `body[data-ds-dark-theme]` 的取值报给 Host，弹卡时显式传 `-Theme dark|light`；
  只有从未有页面上报时，才回退去读 Windows 应用主题（`auto`）。所以「DSH 深色 + Windows 浅色」也不会串色。
- 同时最多显示 4 张；第 5 张出现时会提前关掉最上面那张——**不会丢通知**，那张已经显示过了，这样做只是保证最新的一张一定看得见。

## 其他插件如何调用

别的插件可以替用户关注一个会话，走的是和右键菜单**完全相同的写入函数**（同一个
`session-notify.json`、同一条 SSE 流，事件名仍是 `watched`），所以不会出现两套状态。

```bash
# 关注
curl -s -X POST "http://127.0.0.1:$PORT/session-notify/watch" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxx","on":true}'
# → {"ok":true,"sessionId":"session-xxxx","watching":true}

# 取消关注
curl -s -X POST "http://127.0.0.1:$PORT/session-notify/watch" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxx","on":false}'
# → {"ok":true,"sessionId":"session-xxxx","watching":false}

# 校验当前关注列表
curl -s "http://127.0.0.1:$PORT/session-notify"
# → {"ok":true,"watched":{"session-xxxx":{"title":"…","locale":"zh",…}}}
```

| 情况 | 行为 |
| --- | --- |
| `on` 不是布尔、`sessionId` 缺失、JSON 坏掉 | `400 {"ok":false,"error":…}`，不写入 |
| 跨源请求（带别的 `Origin`） | `403`，不写入 |
| 非 `POST` | `405` |
| **本 Host 没有这个会话** | `200 {"ok":true,"watching":false,"reason":"unknown-session"}`，**不写入** |
| 重复 `on:true` / 重复 `on:false` | 结果不变，**不重复落盘、不重复推送** |

几点调用须知：

- `sessionId` 必须是当前 Host 里**有活会话**的 id（本插件用 `ctx.sessions.get()` 判断）；已经关闭、从未打开过的会话会被判为 unknown。
- 端口用 DSH 的 Web 地址（桌面版每次启动可能变化），同源请求不需要额外鉴权。
- 不用自己传会话标题：页面打开时浏览器半会自动回填（`restate`）。
- 关注只影响「结束时弹卡」；卡片外观、菜单开关都不变，用户仍可在菜单里自己关掉。

## 配置

`cordis.patch.yml` 里这一行带着可调项：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后保留关注列表，但不再弹卡。 |
| `durationMs` | `8000` | 一张卡停留多久（1200–60000）。 |
| `sticky` | `false` | 卡片一直留着，点一下才关。 |
| `powershell` | — | `powershell.exe` 不在系统目录时指定绝对路径。 |

手动运行 `popup.ps1` 时加 `-LogPath <文件>` 会逐步写日志，是排查「为什么没弹卡」最快的方式。

## 前提与限制

- **仅 Windows**：卡片是 PowerShell 5.1 + WinForms 画的窗口。其他系统上插件照常保留关注列表和触发，
  只是不画卡片。
- 需要 DSH 的 **Host 进程还在运行**：卡片画在网页之外，所以窗口最小化到托盘也照常提醒，
  应用完全退出后就不再提醒。
- 每次弹卡会起一个短命的 `powershell.exe`（从触发到看见大约 0.5–1 秒）。脚本策略用
  `-ExecutionPolicy Bypass` 只对这一文件放行；如果终端防护禁止 PowerShell，卡片就弹不出来，
  DSH 日志里会出现 `[session-notify]` 警告。
- 关注列表存在 DSH 主目录下的 `session-notify.json`，重启、刷新都还在。数据不出本机。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host：关注文件、`/session-notify` 路由、SSE、结束触发、拉起卡片。 |
| `client.js` | 浏览器：菜单项和会话行小铃铛。 |
| `popup.ps1` | 卡片本体：位置、主题、堆叠、关闭。 |
| `demo/preview.ps1` | 单独弹一次示例卡。 |
| `test/host.test.mjs` | Host 路由、持久化、触发逻辑（用 spawn 注入观察）。 |
| `test/client.logic.test.mjs` | 用假 `fetch` 把客户端接到真 Host 上跑。 |
| `test/shot.ps1` | 卡片截图工具。 |

```powershell
node --test test/host.test.mjs
node --test test/client.logic.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File demo\preview.ps1
```

## 从 GitHub 安装

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-notify
```

装好后刷新 Web 页面。
