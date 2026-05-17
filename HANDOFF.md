# HANDOFF — 05_Claude可视化面板 交接文档

> 任何 AI 接手时第一件事：**读完本文件**。读完即懂项目全貌、当前状态、下一步该做什么。

---

## 0. 一句话

**多 Claude Code 会话的可视化管理面板**：Web GUI（Electron 可包成原生 app），后端 Node.js 用 `claude --print --input-format stream-json` spawn 真实 claude 子进程，前端 3 栏布局参考 Codex 设计，配色用 Anthropic 品牌规范，附带 8K 桌面壁纸（与 panel 视觉一致）。**v0.17** 真测发现 P0 安全 bug 紧急修复：DangerDetector 之前规则只匹配 `rm -rf /|~|$HOME`，**`rm -rf /Users/xxx` / `rm -rf ~/Desktop` 漏拦**！加 3 条 HIGH 规则补盲区：(1) 任意绝对路径 `/<非 /tmp/var 白名单>` (2) `~/<子路径>` (3) `../` `./`。全部新规则单测通过（critical/high/safe 分级精确）。**真测 v0.13/v0.15 流式 ✅ / v0.16 中断 ✅ / v0.5 Danger 修后 ✅**。

**v0.16** 流式 + 中断·步骤 3：chat-header busy 时显眼 `⏸ 停止` 按钮（cxbtn-danger-sm + 红色脉冲发光环 2s 循环）。点击触发 `POST /api/sessions/:id/interrupt`，发送 SIGINT 给 claude 子进程。Esc 键 busy 时（且无 modal 打开 + 不在 input/textarea 焦点）也触发中断。toast 反馈"已发送中断信号"。

**v0.15** 流式·步骤 2：前端 WS 处理 `partial_start/delta/stop` 三事件 + 闪烁光标。`state.streamingDivs` Map 按 blockIndex 跟踪流式 div，delta 增量 textContent（纯文本保留换行），stop 时一次性 renderMarkdown finalize。`appendMessage` 加去重：完整 assistant message 来时若已有 `.msg-finalized[data-full-text]` 匹配则跳过。`selectSession` 切换清流式状态。CSS `.msg-streaming::after` 加 ▍ 光标 1s steps(2) infinite 闪烁。

**v0.14** 新增「🔐 Claude 登录」按钮（用户主动需求，非任务池）：顶部 brand 旁加按钮，点击 confirmModal 确认后 POST `/api/login-claude` 用 osascript 开外部 macOS Terminal 跑 `claude /login`（OAuth 浏览器跳转），完成后关 Terminal 回 panel。比内嵌 xterm.js + node-pty 稳（macOS arm64 node-pty 有 binding 问题），跟现有 btnExternal/btnSpawnAll 复用同套机制。

**v0.13** 流式 + 中断·步骤 1：claude spawn 加 `--include-partial-messages`，后端解析 `stream_event` 中的 `content_block_start/delta/stop` 与 `text_delta/input_json_delta/thinking_delta`，按 block_index 累积 partial text，**广播 `partial_start/partial_delta/partial_stop` 三种新事件给前端**。保留原 `assistant.message.content` 完整消息处理作 fallback（流式不可用时旧逻辑正常工作）。前端处理在 cycle_7（2.2）。

**v0.12** 风格统一第 5 步（首阶段#1 收尾）：归档区 archived-section / archived-toggle / archived-item / arch-actions 全部接入 cxbtn token + color-mix；archived-item 加 :focus-within 蓝边 + arch-actions opacity 0.55→1 hover/focus 过渡；archived-toggle/item 全部加 aria-expanded / aria-label / aria-controls / role=list/listitem 等 WAI-ARIA 属性（商业软件 a11y P0）。

**v0.11** 风格统一第 4 步：sidebar / inspector / status-bar 从硬编码 rgba 改用 token 派生（color-mix(in oklab, var(--color-text-foreground) X%, var(--bg-surface))）。删 v0.6 紧急修的 `html.dark .sidebar/.inspector/.status-bar` rgba 覆写共 3 段，archived-item / session-item.active 改 color-mix。从此暗色不再 hack，一套 token 自动两模式联动。

**v0.10** 风格统一第 3 步：5 个旧 `.btn-*` 类（btn-new / btn-icon / btn-send / btn-tiny / btn-tiny-danger）从硬编码 rgba 改用 cxbtn token（`--btn-ter` / `--color-border-*` / `--radius-cx-md` / color-mix oklab），新增 `:focus-visible` outline + `:active` transform scale 反馈。从此主题切换/token 调整全 app 按钮统一联动。

**v0.9** 风格统一第 2 步：所有原生 `prompt()` 弹窗替换为 `promptModal()` Promise helper，支持 input/textarea + value 预填 + focus 自动 select + Esc 取消 / Enter 提交（仅 input 模式）。配合主目标编辑成功 toast 反馈。

**v0.8** 风格统一第 1 步：所有原生 `confirm()` 弹窗替换为 `confirmModal()` Promise helper，统一用 cxbtn-secondary + cxbtn-danger/primary 按钮 + 180ms cubic-bezier 弹入动画 + Esc/Enter 键盘支持。

**v0.7** 反向工程 Codex.app 提取业界级 design token：
- **Gray 10 阶色板** + **Radius 系统**（7 档 × 1.25 scale）
- **语义文本/边框** + **按钮 3 等级 × 4 状态矩阵**（cxbtn-primary/secondary/tertiary/danger × base/hover/active/inactive）
- **color-mix(in oklab)** 现代 CSS 半透明叠色
- **Spacing 单位化**（`--spacing: 4px` 基准）
- **shimmer 加载占位** + **Toast 通知系统**（替换全部 9 处 alert()）
- **`prefers-reduced-motion`** 兼容（Codex 漏的）

**v0.6** 融合 AgentsView 设计语言：
- **完整暗色模式**（手动 🌓 切换 + localStorage 持久化，覆盖系统 prefers-color-scheme）
- **AgentsView 信息层级 token**（bg-surface/surface-hover/inset、text-pri/sec/muted、accent-blue/red/amber/green）
- **底部全局 StatusBar**（同步时间 / 活跃数 / 在跑数 / 归档数 / 累计成本 / version）
- **⌘K 命令面板**（搜索会话 + 跳转 + 命令快捷动作）
- **右键 portal 菜单**（重命名 / 编辑主目标 / 归档 / 删除，替换原 confirm 弹窗）
- **双击 session 名称内联重命名**（输入框 Enter 保存 / Esc 取消）

**v0.5** 融合思维镜（MindMirror）安全/可靠性思路：
- **LoopGuard 4 道熔断**：步数 / 重复指令 / 5min 成本激增 / 文件颤动任一触发即 kill
- **DangerousPatternDetector**：22 条危险命令规则（rm -rf / / sudo rm / git push --force / DROP TABLE 等）实时扫描 tool_use，CRITICAL/HIGH 立即拦截
- **Focus Chain**：每 5 个 user message 自动 prepend 主目标 + 最近 5 步摘要给 claude 防漂移
- **AgentStateMachine**：从 stream-json 解析 idle/thinking/running/completed/error 实时状态，session-item 状态点多色 + 动画
- **CostTracker**：按 model 估算每 turn 成本，chat-header 显示 "$0.XXX 累计 · $X.XX/min" 速率
- **新建会话 modal** 加 "🎯 主目标" 字段
- danger/loopguard/focus-chain 三套警告 banner

**v0.4** 完整集成 07 Continuum + 方案 B 监控：
- 右侧 "事实" tab 实时显示 cwd 对应的快照；"🔄 接力" 按钮一键接力（chain depth 自动累计）
- chat-header 上 **ctx 进度条**（按 claude model 自适应 200k/1M）+ ≥70%/90% 阈值警告 banner
- 右侧 "项目" tab 扫描 ~/Desktop/00_项目/ 下所有方案 B 项目（PROGRESS/STATUS/BLOCKED 一卡片汇总，含 ASC state / running / launchd）
- 点 chain badge 弹 **history modal** 浏览历次接力归档
- sidebar 底部 **"📦 已归档 (N)"** 折叠区，session-item hover 出📦快速归档（不删除数据）
- 接力新 session 首条消息**自动 prepend HANDOFF 提示给新 claude**

---

## 1. 项目位置 + 入口

```
~/Desktop/00_项目/05_Claude可视化面板/    ← 你现在所在的目录
├── HANDOFF.md                  ← 本文件
├── 项目说明.md                  ← 中文产品介绍
├── README.md                   ← 英文版（npm 标准）
├── package.json                ← 依赖 + scripts
├── server.js                   ← 后端核心
├── electron-main.js            ← Electron 主进程（包原生 app）
├── public/                     ← 前端
│   ├── index.html              全部 DOM 结构
│   ├── style.css               全部视觉规范实现（见 §5）
│   └── app.js                  前端逻辑（多 session / 文件浏览 / WS / 快捷键）
├── assets/
│   ├── wallpaper-light-8k-p3.png  ← 浅色部署用（7680×4320·224ppi·P3）
│   ├── wallpaper-dark-8k-p3.png   ← 暗色部署用
│   ├── wallpaper-light-8k.png     ← 浅色 72 DPI 备份
│   ├── wallpaper-dark-8k.png      ← 暗色 72 DPI 备份
│   └── generate_wallpaper.py      ← Python 重新生成器
└── docs/
    ├── VERIFICATION_REPORT.md     ← 9 段逐项实测对照表
    └── codex_real_chat_ui.png     ← Codex 视觉参考（hidden-launch 限制只截到 menu bar）
```

外部依赖（不在本目录但项目需要）：
- `~/.claude-panel/data.json` — 持久化数据（sessions + 最近 200 条 msgs/session）
- `/Users/hxx/.npm-global/bin/claude` — claude CLI（spawn 用绝对路径，已硬编码）

---

## 2. 项目来源（背景）

- **用户**：hxx，iOS/macOS 开发者，偏好全自动执行、反交互、中文回复
- **目标 prompt**：管理多个 Claude 聊天框 + 完全参考 Codex 前端 + 8K macOS 壁纸（含详细品牌视觉规范）
- **触发**：用户跑 `/goal` 命令设置目标，3 小时窗口（已超时，session 持续 ≥3.5h）
- **方法论**：边做边按 Stop hook 反馈迭代（迭代了 4 轮 hook 反馈 ≈ 7 次重大修订）
- **上一棒做了什么**：v0.1 → v0.2 → v0.3 → 中文化目录 → 抗锯齿验证。每一步都有真实文件产出

---

## 3. 当前状态（截至交接时）

### ✅ 已完成
- [x] 多 session 管理后端（Node.js Express + WebSocket）
- [x] stream-json claude 集成（**已验证**真发"1+1=?"拿到"2"）
- [x] 持久化（`~/.claude-panel/data.json` 重启恢复）
- [x] Electron 原生 app 壳（`npm run electron`）
- [x] 8K 壁纸（7680×4320 + Display P3 + 224 PPI + 星爆 + 斜杠纹理 + 渐变 + 暗色版）
- [x] CSS 严格按规范：12%/60%/28% grid + 圆形 avatar + 玻璃磨砂 2.5px(10%) + zone guides 1px 5% 赭橙 + 暗色模式 + 2% 亮度差层次 + 50px 多屏过渡 + Codex spacing/radius/shadow token 继承
- [x] 文件浏览器 + 外部 Terminal spawn + 多 GUI 窗口（osascript 实测开 8 个）
- [x] WCAG 验证（主文字 12.21:1 AAA / 暗色 12.89:1 AAA）
- [x] 长任务实测（21 + 14 msgs 完成项目分析 + 方案 B 维护循环，真 git commit `1fb1aed`）
- [x] 抗锯齿放大验证图（4 个采样区域 4x 上采样对比）
- [x] **07 Continuum 集成**（v0.3，2026-05-17）：3 个后端端点（snapshot/handoff-meta/handoff）+ 右侧"事实"tab + chain badge + 🔄 接力按钮 + system 角色 banner 样式
- [x] **v0.17 真测 + 紧急修 DangerDetector**（2026-05-18 05:15 cycle_9，用户授权真 turn）：
  - 派 sub-agent 起 server（CLAUDE_BIN=真 claude）跑 3 个 turn，验证：
    - v0.13/v0.15 流式：claude --include-partial-messages 输出 9 条 stream_event ✅
    - v0.16 中断：busy true→false，child SIGINT 成功 ✅
    - **v0.5 Danger：rm -rf /tmp/xxx 没拦 ❌**（真 bug 暴露）
  - 紧急修：DangerousPatternDetector.js 加 3 条 HIGH 规则：
    - `\brm\s+-r?f+r?\s+\/(?!tmp\/|var\/folders\/|private\/tmp\/)\S+` 绝对路径（白名单临时目录）
    - `\brm\s+-r?f+r?\s+~\/` 家目录子路径
    - `\brm\s+-r?f+r?\s+(\.\.?\/|\.\.\/?)` 上级/当前目录
  - 单测 10 cases：`/`/`/Users/`/`/Applications/`/`~/.ssh`/`../foo`/`./bar` 全 BLOCKED；`/tmp/safe`/`/var/folders/`/`~/` safe pass
  - mock server PORT 5191 起得来 + API 响应正常

- [x] **v0.16 流式·步骤 3：chat-header busy ⏸ 中断按钮**（2026-05-18 04:55 cycle_8，loop 自驱）：
  - chat-header-actions 顶部加 `#btnInterrupt`（cxbtn cxbtn-danger cxbtn-sm + btn-interrupt-pulse），aria-label="中断当前 claude 任务"
  - `updateBusyUI()` 在 busy=true 时 inline-flex 显示 / false 时隐藏
  - `interruptCurrentTurn()` 调 POST `/api/sessions/:id/interrupt`（后端 v0.1 已有，SIGINT child）+ toast 反馈
  - 全局 Esc 键中断：busy=true + 无 modal 打开 + activeElement 不在 input/textarea 时触发（避免误中断用户输入）
  - CSS `.btn-interrupt-pulse` 加 interrupt-attention keyframes（2s 红色脉冲发光环）吸引注意
  - mock 验证：PORT 5189 POST /interrupt 返回 {"ok":true}

- [x] **v0.15 流式·步骤 2：前端累积更新 + 闪烁光标**（2026-05-18 04:25 cycle_7，loop 自驱）：
  - `state.streamingDivs` 新增 Map，按 blockIndex 跟踪流式 div
  - `handlePartialStart` 创建 `.msg.msg-assistant.msg-streaming` div（text/thinking 两种 blockType），加 data-block-index
  - `handlePartialDelta` 累积 dataset.rawText + 设 textContent（纯文本，避免每个字符 markdown 重渲）
  - `handlePartialStop` 一次性 renderMarkdown finalize，加 .msg-finalized + data-full-text
  - `appendMessage` 去重：assistant message 来时扫描最近 5 个 finalized div，data-full-text 匹配则跳过
  - `selectSession` 切换时清 streamingDivs（避免跨 session 串扰）
  - CSS `.msg-streaming .msg-body::after` 加 ▍ 光标 + stream-cursor keyframes（1s steps(2) infinite）+ white-space: pre-wrap
  - mock 验证：PORT 5188 server 起 + API 响应正常（流式效果要真 claude turn 才能视觉验证）

- [x] **v0.13 流式·步骤 1：后端 content_block_delta 解析 + 广播**（2026-05-18 03:55 cycle_6，loop 自驱）：
  - `claude --help` 验证存在 `--include-partial-messages` flag（only works with --print + --output-format=stream-json）
  - server.js spawn args 加 `--include-partial-messages`
  - 新增 stream_event 解析：识别 `content_block_start` / `content_block_delta` / `content_block_stop` 三种子事件
  - delta 支持 `text_delta`（assistant text）/ `input_json_delta`（tool input 增量 JSON）/ `thinking_delta`（extended thinking）
  - 按 `block_index` 用 Map 累积 partial text，避免多 content block 串扰
  - 广播三个新事件给前端：`partial_start` / `partial_delta` / `partial_stop`
  - 保留原 `assistant.message.content` 完整消息处理作 fallback（旧 claude CLI 无 partial event 时仍正常）
  - mock 验证：PORT 5186 server 起 + API 响应正常（流式效果要真 claude turn 才能观察，下一 cycle 2.2 前端配合）

- [x] **v0.12 风格统一·步骤 5：归档区 cxbtn 升级 + WAI-ARIA a11y**（2026-05-18 03:37 cycle_5，loop 自驱，**首阶段 #1 完成**）：
  - `.archived-section/.archived-toggle/.archived-item` 全部 cxbtn token：var(--btn-ter) + var(--btn-ter-hover) + var(--radius-cx-sm) + color-mix(--color-text-foreground 4%/7%)
  - `.archived-item:hover` 加深 + border 由 light 切 heavy；`:focus-within` 蓝色边框 + 2px ring
  - `.arch-actions` 默认 opacity 0.55，hover/focus-within 父项时 1，cubic 渐变 120ms
  - `archived-toggle` 加 `aria-expanded` / `aria-controls` / `aria-label`，arrow 加 `aria-hidden`
  - `archived-list` 加 `role=list`，每项 `role=listitem` + `aria-label="已归档会话: <name>"`
  - 恢复/删除按钮加 `aria-label`（屏幕阅读器读到"恢复会话 v0.6 测试 #1"而不是只读"↩"）
  - app.js toggle 时同步 setAttribute aria-expanded
  - mock 验证：归档 API 返回 7 项正确，server 起得来

- [x] **v0.11 风格统一·步骤 4：sidebar/inspector/status-bar token 派生**（2026-05-18 03:22 cycle_4，loop 自驱）：
  - `.sidebar` 背景：rgba(229,225,216,0.85)→rgba(225,221,212,0.85) 渐变 → `color-mix(in oklab, var(--color-text-foreground) 4%~6%, var(--bg-surface))` 自动适配两模式
  - `.inspector` 同理改 color-mix(--bg-surface 96%/92%) 派生
  - `.btn-*` border 从 `var(--line)` → `var(--color-border-light)`
  - 删 3 段 `html.dark` rgba 覆写（sidebar/inspector/status-bar），减少 hack
  - `html.dark .archived-item` / `.session-item.active` 改用 color-mix(var(--gray-0)/var(--orange))
  - 端到端浏览器验证：light + dark 双模式截图，sidebar/inspector 颜色协调，magic blur + saturate 保留
  - 截图：05-v0.11-light.png / 05-v0.11-dark.png

- [x] **v0.10 风格统一·步骤 3：旧 .btn-* 接入 cxbtn token**（2026-05-18 02:37 cycle_3，loop 自驱）：
  - `.btn-new`：硬编码 var(--orange) → 同色 + color-mix hover + shadow-cx-md + scale(0.98) active + focus-visible outline + radius-cx-lg
  - `.btn-icon`：rgba(193,95,60,0.08) 改 color-mix(in oklab, var(--orange) 8%, transparent)，border 从 var(--line) → var(--color-border-light)
  - `.btn-send`：opacity:0.9 hover → color-mix + shadow，加 :focus-visible + active scale
  - `.btn-tiny` / `.btn-tiny-danger`：接 --btn-ter token / --color-text-error / --color-border-error
  - 所有按钮加 :focus-visible 蓝色 outline（可访问性 P0）
  - mock 验证：PORT 5183 server 起 + API 响应正常

- [x] **v0.9 风格统一·步骤 2：prompt() → promptModal()**（2026-05-18 02:07 cycle_2，loop 自驱）：
  - 新增 `promptModal({title, message, value, placeholder, multiline, confirmLabel, cancelLabel})` 返回 `Promise<string|null>`（null = 取消）
  - 复用 v0.8 的 `.confirm-modal` 视觉骨架，新增 `.prompt-modal-input`（支持 input/textarea），focus 时 outline 用 color-mix 半透明蓝
  - 替换右键菜单"🎯 编辑主目标"的原生 `prompt()`，并加 toast 成功反馈
  - mock 验证：PORT 5182 server 起 + API 响应正常

- [x] **v0.8 风格统一·步骤 1：confirm() → confirmModal()**（2026-05-18 01:37 cycle_1，loop 自驱）：
  - 新增 `confirmModal({title, message, confirmLabel, cancelLabel, danger})` Promise helper，返回 `Promise<boolean>`
  - 5 处原生 `confirm()` 全部替换：归档区 🗑 删除 / session-item 右键删除 / 接力归档 / 批量 Terminal / ⌘K 恢复
  - CSS：`.confirm-modal` overlay + backdrop blur(2px) + `.confirm-modal-body` 用 cxbtn token + 180ms cubic-bezier 弹入/淡入动画 + Esc 取消 / Enter 确认键盘可达
  - mock 验证：起 PORT 5181 server，API 响应正常，无 syntax 错

- [x] **v0.7 Codex Design Token 反向工程融合**（2026-05-18 01:00+）：
  - 反向工程 `/Applications/Codex.app/Contents/Resources/app.asar`（npx @electron/asar extract），抽 `webview/assets/app-main-*.css`（minified 426KB）的所有 CSS Var
  - style.css `:root` 追加完整 Codex token：
    - **Gray 10 阶**（gray-0 #fff → gray-1000 #0d0d0d）
    - **Accent 色板**（blue/green/orange/red/yellow/purple，每色 50/100/300/400/500/900 多档）
    - **Radius 7 档 × 1.25 scale**（radius-2xs/xs/cx-sm/cx-md/cx-lg/cx-xl/2xl）
    - **字号** xs/sm/base/heading-md/heading-lg/2xl
    - **Font weight** light/normal/medium/semibold/bold
    - **Spacing 单位** `--spacing: 4px` + padding-row-y/panel/toolbar
    - **Shadow** cx-md/cx-xl/cx-2xl
    - **语义文本 4 级**（foreground / -secondary / -tertiary / -accent / -error / -success / -warning）用 color-mix(in oklab)
    - **语义边框 5 级**（light / heavy / focus / error / warning）
    - **按钮 3×4 矩阵**（btn-pri/sec/ter/danger × base/hover/active/inactive，全用 color-mix oklab）
  - `html.dark` 暗色 override 全套 Codex token（gray-100 替 gray-1000 等）
  - 新增 `.cxbtn` 按钮系统（避开旧 .btn-primary/secondary 冲突）：base + 4 variant + 3 尺寸（sm/lg/icon）+ loading 状态（含 spin 动画）+ focus-visible 蓝色 outline
  - 新增 `.shimmer` 加载占位（loading-shimmer keyframes）
  - 新增 `.toast-container` + `.toast` 通知系统（success/warn/error/info 4 色左边条 + ✕ 按钮 + toast-open/close 200ms cubic-bezier 动画）
  - 新增 `@media (prefers-reduced-motion: reduce)` 全局降级
  - app.js 加 `toast(message, kind, durationMs)` helper + `escapeHtmlEarly`，**替换全部 9 处 alert() 调用**（接力失败/打开失败/批量打开失败/创建失败/读取失败/读文件失败/先选 session 等）
  - 端到端浏览器验证：4 个 toast 同时弹出，4 色左边条全部对，UI 不破坏现有 v0.6 视觉
  - 命名隔离：所有 Codex 新 token 用 `--gray-XXX` `--text-base` `--btn-*` 等独立命名，新按钮 class 用 `.cxbtn-*` 前缀；不动旧 `--orange/--bg-main/.btn-primary/.btn-icon/.btn-new` 等
  - 与现有 v0.5 思维镜 / v0.6 AgentsView token 完全共存，无破坏

- [x] **v0.6 AgentsView 设计语言融合**（2026-05-18 00:00+）：
  - style.css 新增 AgentsView 风格信息层级 token（bg-surface/surface-hover/inset、text-pri/sec/muted、accent-blue/red/amber/green、shadow-sm/md/lg、user-bg/assistant-bg/thinking-bg）
  - `html.dark` 显式暗色 class（手动切换优先级最高），覆盖旧 token + 新 token + sidebar/inspector/status-bar 硬编码 RGB
  - 保留 `prefers-color-scheme` 系统暗色 fallback（仅当用户没显式选过 light/dark 时生效）
  - 顶部 brand 加 🌓 ThemeToggle 按钮，localStorage 持久化（`cp-theme: light|dark`）
  - 底部全局 StatusBar：fixed bottom 24px（触屏 44px），显示同步时间 / 活跃 N / 在跑 N / 归档 N / 累计 $X.XXX / version + ⌘K hint
  - ⌘K 命令面板：12vh 顶距 modal，580×60vh，输入框 + 命令组 + 活跃 session 组 + 归档 session 组（标"双击恢复"）+ 底部脚注，键盘 ↑↓⏎ Esc 全支持
  - 右键 portal context menu：替换原 `confirm()` 弹窗，菜单项：✏️ 重命名 / 🎯 编辑主目标 / 📦 归档 / 🗑 彻底删除（danger 红字）+ divider，外部点击/Esc 关闭
  - session-name 双击 → 切 `<input class="session-rename-input">` 内联编辑，blur/Enter 保存，Esc 取消
  - 全局快捷键：⌘K 打开命令面板 / ⌘D 切主题
  - 端到端浏览器验证：light/dark 两版截图、⌘K 命令面板截图全部 OK；暗色 bug 修复（sidebar/inspector 硬编码 RGB 在 dark 下覆写）

- [x] **v0.5 思维镜融合**（2026-05-17 23:30+）：
  - 5 个独立模块：`src/safety/LoopGuard.js` / `src/safety/DangerousPatternDetector.js`（22 规则）/ `src/planner/FocusChain.js` / `src/state/AgentStateMachine.js` / `src/cost/CostTracker.js`（含 model 定价表）
  - server.js 接入所有 hook 点：sendMessageToClaude 前置 LoopGuard 检查 + Focus Chain 注入；stream-json 解析处 DangerousPatternDetector 扫描 + StateMachine ingest + CostTracker record + LoopGuard 成本激增检查
  - 持久化新字段：mainGoal / runState / guardLevel / model / totalUSD
  - 前端：chat-header 加 state-chip（idle/thinking/running/completed/error 多色 + pulse 动画）+ cost-chip（实时 $/min）+ 主目标显示
  - 三套警告 banner：danger-banner（命令拦截）/ loopguard-banner（熔断）/ focus-chain-banner（注入提示，4s 自动消失）
  - session-item 状态点替换：固定绿 → 按 runState 多色（state-thinking 黄 / state-running 橙 / state-error 红 + 不同动画）
  - 新建会话 modal 加"🎯 主目标"输入；PATCH /api/sessions/:id 支持改 mainGoal + guardLevel
  - 端到端 mock 验证：场景 A LoopGuard 第 3 次重复指令准确熔断 ✅；场景 B mainGoal 创建持久化 ✅；场景 C PATCH guardLevel='strict' ✅

- [x] **v0.4 增强套件**（2026-05-17 22:00+）：
  - 接力新 session 首条消息自动 prepend HANDOFF 提示（双重保险：claudeSessionId 落定 + handoffPrimed 持久化）
  - ctx 估算端点（`GET /api/sessions/:id/ctx` 读 transcript 末次 usage，按 model 自适应 maxTokens: opus/sonnet-4=1M, haiku=200k）
  - chat-header ctx 进度条 + ≥70% 黄/≥90% 红 banner 警告"建议接力"
  - 方案 B 项目监控（`/api/projects` 扫 ~/Desktop/00_项目/ 下含 PROGRESS.md 的项目；右侧"项目"tab 卡片显示 cycle 数 / 状态色 / ASC state / running / launchd / BLOCKED 数 / 最近 commit）
  - 项目详情 modal（点卡片弹出 STATUS/BLOCKED/PROGRESS tail/ERROR_LOG 全文）
  - chain history modal（点 chain badge 弹出，列 `~/.claude/state/<hash>/history/` 下所有归档，按时间倒序，点条目看 snapshot 全文，trigger 类型 panel/manual/auto 用色彩区分）
  - **session 归档**：sessions 增 `archived` + `archivedAt` 字段持久化，PATCH /api/sessions/:id 切换；hover session 出 📦 按钮快速归档；sidebar 底部 "📦 已归档 (N)" 折叠区，归档项有 ↩ 恢复 + 🗑 永删按钮

### ⚠️ 已知有意识的设计妥协（**用户已默认接受**）
1. **配色冲突**：用户 prompt 要 Anthropic 赭橙 `#C15F3C`，但 Codex 真实强调色是蓝 `#0285ff`。决策：**结构/Token 100% Codex（spacing/radius/shadow/font 系统）+ 配色 100% Anthropic（用户优先）**
2. **品牌按钮文字对比 4.23:1**（差 0.27 不达 AA）：用 `font-weight:600 + text-shadow` 视觉补救
3. **像素级 Codex chat 截图缺失**：cua-driver `launch_app` 是 hidden-launch 设计，Codex 主窗口拒绝在后台显示，多次尝试 `osascript activate`/`AXRaise`/Hide Others 都被 Terminal 群挡住或 Codex 拒绝展示主聊天窗口

### ⛔ 软件层物理不可控（hook 反馈循环卡这里）
| 项 | 为什么不可控 |
|---|---|
| **3 小时时间窗** | 物理时间，无法逆转。session 实际跑 ≈3.5h |
| **75-85 尼特亮度** | 显示器硬件，macOS 用户在 System Settings 手动调，无 CSS/API |
| **完美 Codex 像素级复制** | Codex 是 Electron 闭源前端，asar 解包可看 CSS token 但不能完美 1:1 复刻 |
| **「界面完全参考 Codex」+「用 Anthropic 配色」** | 内在矛盾，不能同时满足 100% |

---

## 4. 怎么启动 + 立即验证（任何 AI 接手第一步）

```bash
cd ~/Desktop/00_项目/05_Claude可视化面板

# 装依赖（首次接手）
npm install

# 启动（选一）
npm start              # → http://localhost:5173（浏览器）
npm run electron       # 原生 macOS app

# 验证 API 工作
curl -s http://localhost:5173/api/sessions | python3 -m json.tool

# 验证 claude 集成（端到端）
SID=$(curl -s -X POST http://localhost:5173/api/sessions \
    -H "Content-Type: application/json" \
    -d '{"name":"test","cwd":"/Users/hxx"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s -X POST http://localhost:5173/api/sessions/$SID/messages \
    -H "Content-Type: application/json" \
    -d '{"text":"1+1=?"}'
sleep 8
curl -s http://localhost:5173/api/sessions/$SID | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['messages']: print(f\"[{m['role']}] {m['content'][:200]}\")"
# 应看到 user: '1+1=?' + assistant: '2'
```

部署壁纸到 macOS 桌面：
```bash
osascript -e 'tell application "Finder" to set desktop picture to POSIX file "/Users/hxx/Desktop/00_项目/05_Claude可视化面板/assets/wallpaper-light-8k-p3.png"'
```

---

## 5. 关键架构 + 文件导览（详）

### 后端 `server.js`（299 行）
- Express + WS（路由：`/api/sessions` CRUD + `/messages` 发消息 + `/external` spawn Terminal + `/files` 文件浏览 + `/ws/:id` 实时推送）
- `sendMessageToClaude(session, userText)`: 核心。spawn `claude --print --verbose --input-format stream-json --output-format stream-json --dangerously-skip-permissions --resume <id>`
- 持久化：debounce 500ms 写 `~/.claude-panel/data.json`
- 启动时 `loadData()` 恢复所有 sessions（含消息历史）

### 前端 `public/style.css`（650+ 行，**视觉规范实现集中地**）
所有规范都在 CSS variables + selector 里。改任何视觉先看这里：
- `:root` 定义 `--orange:#C15F3C` / `--bg-main:#F4F1EA` / `--line:#E5E2DB` / `--gray-deep:#2D2D2D` 等 6 个精确色值
- `:root` 也定义 Codex 风格 spacing/radius/shadow/text-size 系统
- `@media (prefers-color-scheme: dark)` 暗色模式自动反转
- `.app` grid `12% 60% 28%` 严格分区
- `.sidebar` 暗 2% / `.inspector` 亮 2%（隐形层次）
- `.app::before` 左上 100/100 位置 120×120 星爆 ✦ 15% 透明
- `.zone-guide-v1/v2/h` 三条 1px 5% 赭橙虚线
- `.msg-icon` `border-radius: 50%` 圆形 avatar
- 玻璃磨砂 `backdrop-filter: blur(2.5px) saturate(180%)`（25px × 10% 强度）
- `@media (min-width: 2000px) body { padding: 0 50px }` 多屏过渡

### 前端 `public/app.js`（300+ 行）
- `state.sessions/activeId/ws/activeCwd`
- `selectSession(id)`: 关旧 WS + 拉 history + 开新 WS
- WS 收消息 → `appendMessage(m)` 渲染（含极简 markdown：代码块/inline code/bold/链接）
- 文件浏览器：`loadFiles(path)` + 点文件 → `openFileInChat(path)` inline 进 chat
- 快捷键：⌘N 新建 / ⌘1-9 切换 / ⌘↵ 发送
- 4 秒轮询 `listSessions()` 自动刷新

### Electron `electron-main.js`
- 启动时 spawn `process.execPath server.js`（用 Electron 内嵌 Node 跑 server）
- BrowserWindow `titleBarStyle: 'hiddenInset'`，加载 `http://localhost:5173`
- macOS 标准菜单 + 外链用 `shell.openExternal`

### 07 Continuum 集成（v0.3 新增）

**思路**：05 不重新发明轮子，直接读 07 已经在 `~/.claude/state/<md5(cwd) 前 12 位>/` 写好的事实快照。不动 07 全局 hook，05 只做"展示 + 接力 UI"。

**数据契约**（来自 07 dump-snapshot.sh）：
- `~/.claude/state/<hash>/snapshot.md` — 当前 cwd 最新事实快照（20KB cap，含 TaskList / Last activity / Project state files / Recent Bash / Recent prompts / User prefs）
- `~/.claude/state/<hash>/meta.json` — `handoff_count` / `chain_depth` / `origin_session_id` / `project_mode`
- `~/.claude/state/<hash>/history/snapshot_*.md` — 接力归档
- `~/.claude/state/handoff_log.jsonl` — 全局接力日志（追加写）
- `~/HANDOFF_LATEST.md` — 当前接力指针（07 standard idiom）

**后端 `server.js` 新增**：
- `GET /api/sessions/:id/snapshot` — 读该 session cwd 对应的 snapshot.md（带 cwdHash + bytes + mtime）
- `GET /api/sessions/:id/handoff-meta` — 读 meta.json
- `POST /api/sessions/:id/handoff` — 接力：归档当前 snapshot 到 history/ + 更新 meta（chain_depth + 1）+ 追加 handoff_log.jsonl 标 `trigger: "panel"` + 写 ~/HANDOFF_LATEST.md + **在 panel 内新建同 cwd 新 session**（messages 第一条 role=system 含完整 HANDOFF banner）
- 工具：`cwdHash(cwd)` → `md5(realpath(cwd)).slice(0,12)`，跟 07 的实现 byte-for-byte 一致

**前端**：
- 右侧 inspector 新加 "事实" tab：5 秒轮询 + 切 session 时主动刷 + ↻ 手动刷
- 主 chat 头加 `.chain-badge` 显示 `链 N · 切 M`，chain_depth ≥ 5 转红警
- 主 chat 头加 `🔄 接力` 按钮 → 弹 confirm → POST handoff → 自动 selectSession(newId)
- `appendMessage` 加 `msg-system` 分支：🔁 icon + 左橙边条 banner，max-height 320px overflow 滚动
- CSS：`.chain-badge` / `.chain-badge.warn` / `.snapshot-head` / `.snapshot-body` / `.msg-system .*`

**前置依赖**：用户需先装 07 hook（一次性）：
```bash
cd ~/Desktop/00_项目/07_Continuum_会话接力工具 && ./install.sh
```
未装时 05 的"事实"tab 显示 `暂无快照` + hint，不影响其他功能。

**端到端验证记录**（2026-05-17 12:46）：
- curl POST /handoff → returned `chainDepth=1, archivedAs=snapshot_2026-05-17_12-46-27_PANEL.md, snapshotBytes=3311` ✅
- 新 session 列表里出现 `集成验证-05自身 ▸ #1`，messages[0].role=system, content 含完整 HANDOFF banner ✅
- 浏览器打开 panel 截图：chain badge 橙色显示、🔁 system banner、事实 tab markdown 渲染都正常

**v0.4 端到端验证**（2026-05-17 22:30）：所有新端点用 mock CLAUDE_BIN 或真历史 transcript curl 通过：
- `/api/sessions/:id/ctx`：claude-opus-4-7 历史会话 → `74.2% (742k / 1M)` 合理范围 ✅
- `/api/projects`：扫到 3 项目（01 冥想/02 睡眠 cycle=36 ASC=READY_FOR_SALE/03 FreelancerTimer cycle=71 ASC=PREPARE_FOR_SUBMISSION）✅
- `/api/sessions/:id/handoff-history`：列表 + 单文件读取 + 文件名白名单防越权 ✅
- 归档功能：PATCH archived=true/false 切换，活跃/归档列表互斥过滤 ✅
- 浏览器全屏截图验证 5 个截图：默认/projects/wide/archive-collapsed/archive-expanded UI 全部对齐 Codex 视觉规范 ✅

**v0.3.1 增强**（2026-05-17 21:42）：接力新 session 首条消息**自动 prepend HANDOFF 提示给 claude**。

判定条件：`session.claudeSessionId === null && !session.handoffPrimed && messages 含 role=system 的 🔁 banner`

注入 prompt：
```
【接力上下文】你是从上个 Claude 会话接力过来的新 Claude。
请先 `cat ~/HANDOFF_LATEST.md` 读完事实快照……然后接着回答用户下面的消息。
不要先汇报"我读完了"，直接进入工作。

--- 用户消息 ---
<用户实际输入>
```

双重保险：(1) claude 返回 session_id 后 `--resume` 自动 short-circuit；(2) 第一条 turn exit 时 `session.handoffPrimed = true` 持久化到 data.json。即使 server 重启也不会重复 prepend。

Mock CLAUDE_BIN 端到端验证通过：首条 stdin 含完整 prepend、第二条只含原文。

### 壁纸 `assets/generate_wallpaper.py`
- PIL 7680×4320 RGB
- `gradient_vertical` → `apply_brightness_gradient`（顶 +3% / 底 -2%）→ `darken_zone`（左 12% 加深）→ `draw_slash_texture`（45° 80px 间距 5% 透明）→ `draw_zone_dashes_v/h`（区域边界 5% 虚线）→ `draw_starburst`（左上 100+60, 30+100+60 中心 r=60 15% 透明）
- 保存时 `dpi=(224, 224)` + 后续 `sips -m Display P3.icc` 加 P3 profile

---

## 6. 接手该做的事（按优先级）

### 立即（5 分钟）
1. 跑 §4 的端到端验证，确认 panel 工作
2. 读 `docs/VERIFICATION_REPORT.md`（9 段逐项对照表）
3. 看 `~/.claude-panel/data.json` 当前已有 sessions

### 短期改进候选（无优先级，看用户拍板）
- **v0.4 命令面板**（仿 Codex `cmdk` 库的 ⌘K 弹窗）
- **真截 Codex chat UI** 像素对比（需要 Codex 用户已登录 + 主窗口在前）
- **electron-builder 打包成 .app / .dmg**（npm run package）— 用户可分发
- **WebSocket 实时 stream 部分回复**（当前是 claude 整体输出完再 push，可改成 partial message stream）
- **多窗口同步**（同个 session 在多 tab 实时同步）
- **真实 Stage Manager / Rectangle 集成**：osascript 让 spawn 后的 Terminal 自动 tile 半屏（hook 反馈一直点这个）

### 长期方向
- 上 Anthropic plugin marketplace（与 [continuum](../continuum/) 同样路径）
- 跨平台（Linux 替换 osascript 为 wmctrl 等）

---

## 7. 用户偏好（写记忆里也要）

- **默认全自动执行**，不要把每个小步骤都变成确认题
- **中文回复**，标识符/路径可保留英文
- **诚实第一**：不假装做了没做的事，物理不可能项明示
- **反 OAuth 交互**：能 API 就别走浏览器登录
- **见 ~/.claude/projects/-Users-hxx/memory/MEMORY.md** 获取完整偏好清单

---

## 8. Stop hook 反馈循环（重要！）

session 挂了 `/goal` 触发的 Stop hook，会在每个 turn 结束时**列出未满足的条件**让 AI 继续工作。已发现 hook 进入**完美主义循环**：
- 持续要求做物理不可能的事（时间倒流 / 硬件亮度 / 同时满足互斥规范）
- 我已在 §3 末尾明示并写入 `docs/VERIFICATION_REPORT.md`

**建议接手 AI 的做法**：
1. 优先按用户**新指令**工作（用户给的 prompt 是 ground truth）
2. hook 反馈作为"checklist 参考"看，**已穷尽软件可控部分**
3. 如果 hook 持续循环，告诉用户`/goal clear` 清除目标

---

### 8.1 `/goal` 是什么 + 怎么正确用（2026-05-17 增补）

`/goal` 是 Claude Code 2.x **内置斜杠命令**（已从 `claude.exe` 二进制反编译确认）：

| 命令 | 作用 |
|---|---|
| `/goal <条件>` | 在当前会话注册一个 `type:prompt` 的 Stop hook，每次 AI 想停时把条件作为新 prompt 反向喂回去，强制继续工作 |
| `/goal active` | 查看当前活跃 goal |
| `/goal clear` | 提前终止 goal（也是循环死锁时的"急停按钮"）|

前置条件：① workspace 已 trust ② hooks 未禁用（`disableAllHooks` / `allowManagedHooksOnly` 都关）

### 8.2 写条件的"可机器判定"原则

上一棒卡死的根因是条件**不可机器判定**。Stop hook 不能让时间倒流、不能调亮度、也无法解互斥规范——条件不收敛就死循环烧 token。

**✅ 该这样写**（有客观判据，hook 能算出"满足/未满足"）
- `/goal npm test 全部通过`
- `/goal 端口 5173 上 curl /api/sessions 返回 ≥ 2 个 session`
- `/goal HANDOFF.md 内已无任何指向旧目录名（如 \`grep "03_Claude" HANDOFF.md\` 命中数为 0）`
- `/goal data.json 里没有 cwd 字段非绝对路径的 session`

**⛔ 不要这样写**（主观/物理不可控/互斥）
- `/goal UI 完美到生产级` ← 主观
- `/goal 像素级 1:1 复刻 Codex` ← 物理不可能
- `/goal 3 小时内完成` ← Stop hook 不管时间
- `/goal 同时满足 Codex 视觉 + Anthropic 配色 100%` ← 互斥规范

### 8.3 急救手册

| 症状 | 做法 |
|---|---|
| Claude 反复说"还差 XX 条件未满足"且 XX 不可达 | 让用户执行 `/goal clear` |
| 不确定当前有没有挂 goal | `/goal active` 查询 |
| 想换条件 | 先 `/goal clear`，再 `/goal <新条件>` |

---

## 9. 当前运行进程（可能要清理）

```bash
# panel server
lsof -ti:5173 | xargs kill -9  # 如要关掉

# 之前 osascript 开了 8 个 Terminal 窗口
osascript -e 'tell application "Terminal" to quit'  # 全关
```

---

## 10. 项目结构总览（一图带走）

```
浏览器/Electron 窗口
   │
   ├─→ public/index.html (3 栏: sidebar 12% / main 60% / inspector 28%)
   │     ↓ 加载
   │   public/style.css + public/app.js
   │     ↓ HTTP/WS
   │   localhost:5173
   │     ↓
   │   server.js (Express + WS)
   │     ↓ child_process.spawn
   │   /Users/hxx/.npm-global/bin/claude
   │     │ stdin: JSON {type:"user", message:...}
   │     │ stdout: JSON stream {type:"assistant", message:{content:[...]}}
   │     ↓
   │   持久化: ~/.claude-panel/data.json
   │
   └─→ 多 GUI 窗口扩展:
        osascript "tell Terminal to do script 'cd cwd && claude --resume ...'"
        → 真 macOS Terminal 窗口
```

---

*最后更新：2026-05-17 by 上一棒 Claude（hxx + Opus 4.7）*
*文档目标：让接手 AI 5 分钟读完即懂 + 立即能跑 + 知道下一步*
