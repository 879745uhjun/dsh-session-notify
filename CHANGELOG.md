# 更新日志 · Changelog

本文件记录 dsh-session-notify 的每次可见变化。版本号遵循语义化版本；此前的迭代只在本地工作区进行，
本仓库从 0.1.0 起有可追溯的提交历史。

## 0.1.0 — 2026-11-15

首个公开版本：盯着的会话一跑完，右下角弹卡片提醒。

### 新增

- **右键开启**：在左侧会话列表右键「结束时提醒」，会话行出现小铃铛，菜单项变成「已开启结束时提醒」并显示绿色「开」。
- **回合真正结束才提醒**：助手这一轮输出完整写进会话记录后才触发，不按输入框状态猜。
- **右下角卡片**：显示会话标题、「此对话已结束」、完成时间；点一下关闭并跳到该对话。
- **可同时盯多个会话**：各自独立，互不影响。

## 0.5.2 — 2026-11-21

### 修复

- 自检区块的 subject 判定改为**双形态**：`{kind:'bundle', pkg:{name}}`，以及在 rc.5 里真实出现的
  `{kind:'item', id}`（`id` 可能是裸包名 `dsh-session-notify`，也可能是加载器前缀形态
  `include:dsh-session-notify`）。此前只认 bundle 形态，item 形态下详情页不会渲染自检区块。
  其它插件的 item 仍返回 `null`，不会串台。

### 测试

- 新增断言：裸 `id` 与 `include:dsh-session-notify` 都渲染；`include:dsh-session-todos` 不渲染。

## 0.5.1 — 2026-11-19

### 修复

- **旧关注迁移**：文件里没有 `mode` 字段的 watch，现在按 `always` 读（保留它们创建时的“每轮提醒”体验），
  并在下一次落盘时补写成 `mode:'always'`。0.5.0 曾把它当 `once` 读，会把这些老关注在一次提醒后自动解除。
- **新建关注不变**：仍然默认 `once`；已有 `mode` 的记录（`once` 或 `always`）不会被改写。
- README 中英补充「旧关注迁移为 always、新关注默认 once、面板/接口可改」。

### 测试

- 新增两条 host 用例：缺字段 → always 且一轮后仍在、落盘后文件含 `mode:'always'`；
  新建 → `once`、显式 `once`/`always` 不被改写。

## 0.5.0 — 2026-11-19

关注记录新增**提醒方式** `once` / `always`，并对外暴露默认值与切换接口（待办合并面板的前置）。

### 新增

- watch 记录新增 `mode: 'once' | 'always'`，缺省 `once`；老数据不迁移，缺字段按 `once` 读。
- `GET/POST /session-notify/settings`：`{ defaultWatch, defaultMode }`；POST 只接受这两个键，
  未知键/类型错/空对象 `400`，跨源 `403`，其它方法 `405`；新建 watch 套用 `defaultMode`。
- `POST /session-notify/mode { sessionId, mode }`：已关注 → `{ok:true,watching:true,mode}`；
  未关注 → `{ok:true,watching:false,mode:null}` 且**不隐式建关注**；非法 `mode` `400`。
- `POST /session-notify/watch` 接受可选 `mode`；`GET /session-notify` 的每条 watch 都带 `mode`。

### 行为

- `once`：第一张卡弹出即结束该关注（铃铛随之消失）。
- `always`：每轮 `turn/end` 各弹一张，直到已处理——**点击卡片打开会话**或**右键菜单关闭提醒**即视为已处理。
- 右键菜单开启的提醒显式使用 `always`（保持“每轮都提醒”的旧行为）。
- 卡片堆叠沿用 4 张上限，不另造队列。

## 0.4.1 — 2026-11-18

### 修复

- 自检里第 3 项的标签注明「**会弹一张卡**」（`/session-notify/test` 会真的在屏幕右下角弹一张示例卡），
  避免用户点「运行自检」时被突然的卡片打扰；README 的检查项表格同步标注。

## 0.4.0 — 2026-11-18

插件详情页新增「自检」区块（插件自检区块规范）。

### 新增

- 入口 `plugins.detail.section`，`id: dsh-session-notify.selftest`，`order: 90`；只在本插件的详情页渲染，
  其他插件的详情页返回 `null`。
- 四项检查，**只在点「运行自检」时执行**（每条 2s 预算，AbortController 计时）：
  1. `GET /session-notify` → 200 且返回里 `watched` 是对象；
  2. `EventSource /session-notify/events` 能在 2s 内收到首帧；页面没有 EventSource 或连不上时降级为「跳过」；
  3. `POST /session-notify/test` → `shown: true`（示例卡）；
  4. `POST /session-notify/theme` 带非法值 → 必须 400（只探测，不改卡片实际主题）。
- 顶部另有「弹一张示例卡」按钮（复用 test 路由）与「复制结果」（Markdown：`- [x] 标签 — 通过` / `- [ ] 标签 — 失败：原因`）。
- 失败不抛异常，统一转成 `{ok:false, detail}`。

### 测试

- 客户端由 8 项增至 13 项：注册元数据与 subject 过滤、渲染期不发请求、全绿路径、单项失败不影响其它项、2s 预算超时后区块仍可用、Markdown 形状。

## 0.3.1 — 2026-11-17

卡片配色改为跟随 **DSH 主题**，不再只认 Windows 主题（深浅色适配方案规则 5）。

### 修复

- 页面通过 `POST /session-notify/theme` 上报 `body[data-ds-dark-theme]` 的当前取值（含属性变化），
  Host 弹卡时显式传 `-Theme dark|light`；`auto` 保留为兜底——当没有任何页面上报时仍读注册表。
- 这样「DSH 深色 + Windows 浅色」（或反过来）时，卡片与页面一致，不会格格不入。
- 复核浅色卡片没有死白/死黑：背景 `(252,252,253)`、正文 `(28,31,38)`、标题 `(104,110,124)`、边框 `(214,217,224)`。

### 测试

- 新增 host 用例：页面未上报时不给 `-Theme`（auto 兜底）；上报 dark/light 后卡片参数随之切换；示例卡同样生效；主题路由的 400/403/405。
- 新增 client 用例：页面加载即上报 light，`data-ds-dark-theme` 翻转后上报 dark。

## 0.3.0 — 2026-11-17

新增编程式关注接口，供别的插件替用户开启结束提醒（生态联动 P0-③ 前置）。

### 新增

- **`POST /session-notify/watch`**：`{"sessionId":"…","on":true|false}` → `{"ok":true,"sessionId":"…","watching":true|false}`。
  与右键菜单共用同一个写入函数、同一个 `session-notify.json`、同一条 SSE 流（事件名仍为 `watched`）。
- 幂等：重复 `on:true` / `on:false` 不重复落盘、不重复推送。
- 未知会话：本 Host 没有活会话时返回 `200 {"ok":true,"watching":false,"reason":"unknown-session"}`，不写入。
- 同源校验复用现有逻辑，跨源 `403`；缺参/类型错 `400`；非 POST `405`。
- README 增「其他插件如何调用」小节（含 curl 示例与边界表）。

### 不变

- 卡片 UI、菜单开关、`popup.ps1` 的堆叠逻辑均未改动。

## 0.2.0 — 2026-11-17

菜单收口成一个入口，卡片堆叠有了明确上限。

### 变更

- **「会话提醒设置 ›」**：原来的「结束时提醒」「试弹一次提醒」两行合并成一行，点开才是下一级菜单；
  用的是 DSH 上下文菜单原生的子菜单，展开、键盘操作、贴边翻转都由框架负责。
- **状态放在文字上**：关注中父项显示「会话提醒设置 · 开」、子项显示「已开启结束时提醒」，图标也从空铃变实心铃。
- **操作有回执**：切换关注时弹一条提示（已开启 / 已关闭 / 设置失败）。

### 修复

- **卡片不再叠在同一位置**：同时结束的会话最多显示 4 张，满了以后新卡顶掉最上面那张，
  保证最新的一张一定看得见（原先第 5 张起会盖在第 4 张上，两张互相遮挡）。
  被顶掉的那张**已经显示过，不算丢通知**。

### 工程

- `npm test` 改为 `node --test "test/**/*.test.mjs"`，一条命令跑全 22 项（host 15 + client 7）。

### 测试

- 新增不变量用例：同一语言下 completed / aborted / error 三种结局的提示语必须完全相同，只有强调色和状态词变化。
