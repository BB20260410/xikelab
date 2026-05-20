# 🤖 新会话交接 — 05_Claude 可视化面板 @ v0.56（Sprint 15 完成）

> 在新对话框对 AI 说：「先读这份 HANDOFF_NEW_CHAT.md 再开干」即可接手。
> **接手第一件事** → 看 §1 启动验证 + §7-A 这一轮（v0.53 Sprint 3）干了什么。

---

## 1. 启动 / 端口 / 数据

```bash
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
npm start                     # 默认 127.0.0.1:51735（v0.49 N-01 起只听 localhost）
# 浏览器开 http://localhost:51735
```

**当前后台 PID**：`lsof -iTCP:51735 -sTCP:LISTEN -t` 看 PID。重启用 `kill -KILL <PID> && nohup node server.js > /tmp/panel-v052.log 2>&1 &`。

**数据位置**（持久化）：

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.claude-panel/data.json` | sessions + hookEvents + watcherHistory + starredIndices | 0o600 |
| `~/.claude-panel/rooms.json` | 房间（chat/debate/squad/**arena**）+ conversation + taskList + **archived/archivedAt/parentRoomId** | 0o600 |
| `~/.claude-panel/watcher.json` | watcher 配置 | 0o600 |
| `~/.claude-panel/prompts.json` | Prompt 模板库（⌘P 弹库）| 0o600 |
| `~/.claude-panel/room-adapters.json` | **v0.52**：room adapter 池（minimax/gemini/gemini-openai/gemini-cli/customs/spawn_overrides）+ timeoutMs + maxTokens | 0o600 |
| `~/.claude-panel/cli-plugins/*.json` | **v0.52**：用户 plugin manifest（builtin 在 src/plugin/builtin/）| 0o600 |
| `~/.claude-panel/metrics-YYYY-MM.jsonl` | **v0.53 Sprint 3**：按月切的 turn 指标流（每行一个 turn 摘要 + tokensIn/Out + estCostUSD）| 0o600 |
| `~/.claude-panel/room-templates.json` | **v0.53 Sprint 3**：用户保存的房间模板（builtin 6 个内置在 src/templates/RoomTemplatesStore.js）| 0o600 |
| `~/.claude-panel/webhooks.json` | **v0.54 Sprint 4**：webhook 配置（URL + 格式 + 事件订阅 + 触发 stats）| 0o600 |
| `~/.claude-panel/archive-config.json` | **v0.54 Sprint 4.5**：聊天归档配置（rootPath / structure / timeFormat / autoArchive）| 0o600 |
| `<rootPath>/<time>/<room-id8>/{final-consensus.md, full-transcript.md, meta.json}` | **v0.54 Sprint 4.5**：归档产物，用户可读可备份可同步 | - |
| `~/.codex/config.toml` | codex 默认 model（不归 panel 管）| - |
| `~/.gemini/oauth_creds.json` | Gemini CLI OAuth（不归 panel 管）| 0o600 |

**重启不丢数据**。损坏会自动备份成 `.corrupted-<ts>.bak`。

---

## 2. 5 大房模式（v0.52 新加 🏟 Arena）

### 💬 闲聊房（chat）
1v1 持续对话。`POST /api/rooms/:id/chat` 触发一次 AI 回应。

### 🗣 辩论房（debate）— v0.52 加 N 大轮
R1 独立提案 → R2 互评修订 → R3 终稿表态 → R4 主持总结。**N 大轮可配置（1-10，默认 2）**。N>1 时下一大轮 R1 看上一大轮 R3 后再独立提案。
- ✅ 支持**续跑**（POST /resume，保留已有 R1/R2/R3，从断点续）
- ✅ 支持**局部重试**（任一 turn error 时只重跑这一个 AI）
- ✅ 支持**重启**（清空进度从头）

### 👥 小组房（squad）— Squad PM/Dev/QA
PM 拆任务 → 并行 Dev 实现 → QA 审查 reject 循环 → pass / 升级（默认 maxIterations=30）
- v0.52 PM_PROMPT 强力引导拆并行无依赖 task
- v0.52 DEV_PROMPT 强制"修复对照表" + 给 dev 看上次实现
- v0.52 QA_PROMPT 强化 issues 必须可定位 + 检查上次 reject
- ✅ 支持续跑 / 重启 / 局部重试

### 🏟 多组对决（arena）— **v0.52 全新**
N 个 AI 并行各自独立提案（互不可见） → Claude judge 用 WebSearch/WebFetch **联网核对每条事实** → 输出统一最优意见。
- judge 默认是 Claude CLI（reasoning + WebSearch 内置）
- 提案匿名化（A/B/C/D）防偏心
- ✅ 支持局部重试 proposals + arena_judge

### 🐝 Ruflo 实时面板 + 💻 内嵌终端
v0.49 已有，不变。

---

## 3. 9 个 Adapter 池

通过 ⚙️ adapter 配置 modal 启用 + 每个独立配 timeout / maxTokens：

| id | 类型 | 调用方式 | 联网 |
|---|---|---|---|
| `claude` | spawn | `claude --print` | ✅ WebSearch/WebFetch |
| `codex` | spawn | `codex exec -o file` | ✅ web 工具 |
| `gemini-cli` | spawn (PTY!) | `gemini -p` + node-pty 分配伪 TTY 绕开 OAuth 重新登录 | ✅ Google Search |
| `ollama` | HTTP | localhost:11434 | ❌ |
| `minimax` | HTTP | `api.minimax.chat/v1/chat/completions` | ❌ |
| `gemini` | HTTP | `generativelanguage.googleapis.com/v1beta` | ⚠️ 需手动声明 grounding |
| `gemini-openai` | HTTP | OpenAI 兼容（OpenRouter 等）| ❌ |
| `ccr` | spawn | Claude Router（可选）| 看 router 后端 |
| `custom:<id>` | HTTP | 用户自定义 OpenAI 兼容（最多 10 个）| 看 |

**默认 timeout**：spawn 30 min / HTTP 20 min。在 ⚙️ 可改到 2h / 1h。

**默认 max_tokens**：Gemini 65K / MiniMax 32K / OpenAI 兼容 16K / Ollama 8K / 填 0 = 不传让服务端决定。

---

## 4. 通用 CLI Plugin 平台（v0.52 W1+W2 完成）

panel 现在是 **manifest-driven 通用 CLI 容器**——任意 CLI 工具填一份 JSON 接入。

### 顶栏入口：🧩 Plugin 中心

| 功能 | 操作 |
|---|---|
| 看已加载 plugin | 直接显示左侧列表（内置 + 用户）|
| 装新 plugin | 点 `＋ 安装 Plugin` 上传 JSON manifest |
| 卸载 | 详情页 `🗑 卸载`（内置不可卸）|
| 跑命令 | 详情页选命令 → `▶ 跑` → 弹 modal 填 prompt+params → 看输出 |
| 仪表盘 | 跑完命令自动按 manifest.dashboard 渲染（4 种卡片）|

### 已有 manifest（6 份）

| 路径 | 说明 |
|---|---|
| `src/plugin/builtin/claude.json` | 内置，对应 ClaudeSpawnAdapter |
| `src/plugin/builtin/codex.json` | 内置，对应 CodexSpawnAdapter |
| `src/plugin/builtin/gemini-cli.json` | 内置 |
| `src/plugin/examples/praisonai.json` | 示例：multi-agent + 仪表盘 |
| `src/plugin/examples/ios-toolchain.json` | 示例：xcodebuild 4 个命令 |
| `src/plugin/examples/autogen.json` | 示例：通过 python3 -c |

**完整开发文档**：`docs/PLUGIN_GUIDE.md` + `docs/plugin-manifest.schema.json`（ajv 校验）

---

## 5. 关键代码骨架（v0.52 增量）

```
05_Claude可视化面板/
├── server.js                              ~2700 行（+~600 行）
├── src/
│   ├── room/
│   │   ├── DebateDispatcher.js            +resume() +retryTurn() +N 大轮 +心跳广播
│   │   ├── CollaborationDispatcher.js     +resume() +PM/Dev/QA prompt 强化 +看板实时状态
│   │   ├── ArenaDispatcher.js             ✨ 新增（多组对决 + judge 联网）
│   │   ├── ChatRoomStore.js               +archived/archivedAt/parentRoomId
│   │   ├── RoomAdaptersConfig.js          ✨ 新增（room adapter 持久化）
│   │   ├── GeminiSpawnAdapter.js          ✨ 新增（node-pty 分配 PTY 绕 OAuth）
│   │   ├── GeminiChatAdapter.js           ✨ 新增（Google AI Studio 原生）
│   │   ├── OpenAICompatChatAdapter.js     ✨ 新增（gemini-openai + custom 共用）
│   │   └── squad-limits.js                +DEBATE_LIMITS +CONTENT_LIMITS +SYSTEM_LIMITS
│   ├── plugin/                             ✨ 全新目录
│   │   ├── PluginRegistry.js              加载/校验/install/uninstall/reload
│   │   ├── PluginSpawnAdapter.js          manifest 驱动的通用 spawn
│   │   ├── builtin/*.json                 3 份内置 manifest
│   │   └── examples/*.json                3 份示例 manifest
├── docs/
│   ├── WRAPPER_PLAN.md                    通用 CLI Wrapper 方案（W1+W2 done）
│   ├── PLUGIN_GUIDE.md                    ✨ Plugin 开发完整指南
│   └── plugin-manifest.schema.json        ✨ JSON Schema
└── public/
    ├── index.html                         +🧩 Plugin 中心 +🏟 Arena 房 +Adapter ⚙️
    └── app.js                             ~3700 行（+~1500 行）
```

---

## 6. v0.52 新增 API 端点

| 端点 | 说明 |
|---|---|
| `GET /api/plugins` | 列已加载 plugin 摘要 |
| `GET /api/plugins/:id` | 拿完整 manifest |
| `POST /api/plugins/install` | 装 manifest（body 直接是 manifest 对象，≤32KB）|
| `DELETE /api/plugins/:id` | 卸载（内置不可卸）|
| `POST /api/plugins/reload` | 重扫两个目录 |
| `POST /api/plugins/:id/exec` | 跑 command |
| `GET /api/room-adapters` | 拿 adapter 池配置（apiKey 脱敏 4...4）|
| `PUT /api/room-adapters` | 改配置 + 即时 rebuild 池 |
| `GET /api/room-adapters/providers` | 列当前可用 adapter |
| `POST /api/rooms/forward` | 把源房 finalConsensus 转给新房 + 可选自动启动 |
| `POST /api/rooms/:id/resume` | 续跑（debate/squad）|
| `POST /api/rooms/:id/retry-turn` | 局部重试单个 turn（debate/arena）|
| `GET /api/rooms?archived=1` | 拿归档房 |
| `PATCH /api/rooms/:id` 新字段 | `archived` / `debateRounds` |

---

## 7-AAAAAA. v0.54 Sprint 6（2026-05-20，紧接 Sprint 5.5）干了什么

针对用户反馈：「小组房感觉还是有问题，最终也没输出个结果，而且升级这个描述是什么意思？」

### 问题诊断
1. **「升级」文案差**：英文 "escalated" 直译，中文里"升级"=upgrade，意思不对；用户看不懂
2. **squad 全失败时 PM 总结无用**：所有 task 都 escalated 时，PM 拿到一堆失败 task 做总结，输出"全部失败"这种空话，用户根本拿不到下一步建议
3. **缺局部 task 重试**：squad 房一个 task 因 adapter 网络问题 escalate 后，用户只能"重启整个房"清空所有进度重跑——太重

### 6-1 升级文案 + PM 总结增强
- 「⚠️ 升级」→「**⚠️ 已搁置（需人工）**」（语义准确）
- squad-col 加 tooltip 解释 3 种触发条件
- `task_escalated` toast 加引导："可在卡片上点重试"
- FINAL_SUMMARY_PROMPT 检测 `doneCnt === 0 && escCnt > 0`：切换到「失败诊断 prompt」，输出 4 节：失败诊断 / 立即可做的修复动作 / 用户下一步选项 / 中间输出片段
- 例：MiniMax fetch failed → "检查 adapter baseUrl + apiKey 是否过期"；Gemini 报错 → "跑 gemini 命令重新登录"——给可执行步骤

### 6-2 squad 房单 task 重试（新功能）
- `CollaborationDispatcher.retryTask(roomId, taskId)`：
  - reset 指定 task：status=pending, iterations=0, attempts=[], reviews=[], 清 escalateReason
  - 同时 reset 被牵连的下游：扫 taskList 找 `escalated && reason 含 'blocked'` 的下游，一并 reset
  - 触发 `start(roomId, topic, { resume: true })`：dispatcher 自然接着跑这些 pending task
  - 并发锁 `_taskRetries: Set<"roomId:task:taskId">` 防双击
- 端点 `POST /api/rooms/:id/retry-task` body `{ taskId }`，fire-and-forget（立返 ok，dispatcher 后台跑）
- 前端：escalated task 卡片底部加「🔄 重试此任务」按钮（房 running 时变「⏸ 等房暂停」disabled）
- 新 WS 事件：`task_retry_start`（带 cascadedCount） / `task_retry_error`

### 6-3 审查 + 文档
端到端验证：retryTask 正确 reset target + cascaded blocked downstream，不动 done task；不存在 / done 状态拒。

---

## 7-AAAAA. v0.54 Sprint 5.5（2026-05-20，紧接 Sprint 4.5）干了什么

针对用户反馈：「小组对决得出的结论，我想接着结论继续问，结果一问就又是新的问题了——连续不上」。

### 问题诊断
之前 `/api/rooms/forward` 转闲聊房时把 `finalConsensus` 塞到 `room.topic` 字段，但 **chat 房 AI 只看 `room.conversation` 不看 `room.topic`**（SoloChatDispatcher.sendMessage 拍平时只读 conversation）→ AI 完全看不到上轮结论 → 用户问的"基于结论的追问"被当成新问题。

### 5.5-1 forward 到 chat 时注入结论上下文
- `POST /api/rooms/forward` 的 `chat` 分支：在新房 conversation 里 seed **两条消息**让 AI 真能看到 context：
  - 第 1 条 `from='user'`：「我刚在「{源房名}」（{模式}房）跑出下面这个结论，请基于此和我继续讨论后续问题：」
  - 第 2 条 `from='forward-context'`（flatten 时算 assistant role）：完整 `finalConsensus`（cap 32KB 防 prompt 爆炸）
- SoloChatDispatcher.sendMessage 已有的 flatten 逻辑：`m.from === 'user' ? 'user' : 'assistant'` → 自然把 forward-context 当 assistant 角色
- 最终 messages 序列：`[system, user(背景引子), assistant(finalConsensus), user(新追问)]` —— 合 OpenAI/Claude API 角色交替规范
- 前端：
  - finalConsensus 区按钮文字「➡️ 转闲聊房」→「💬 基于此继续追问」+ 更明确的 tooltip
  - chat 房渲染时识别 `m.fromForward === true`：加 📌 头像 + 橙色左边框 + 「上轮结论 · 自动作为对话 context」badge
- 端到端验证：messages roles `[system, user, assistant, user]`，无 user-user 连续，结论字段确实落到 assistant content

### 5.5-2 文档 + 审查
- HANDOFF / BUGS 段落
- 全语法过

---

## 7-AAAA. v0.54 Sprint 4.5（2026-05-20，紧接 Sprint 4）干了什么

针对用户反馈：1）重试 UX 改进；2）每房自定义输出位置；3）全局聊天归档（按时间/房名分类）。

### 5-0 修「重试按钮 running 时禁用」UX
- 前端 `renderTurnCard` + `updateRoomStatusChip` 联动：房 status=running 时把所有 error turn 的「🔄 重试这个」按钮置 disabled + 改文字「⏸ 等房暂停」+ tooltip 解释 dispatcher 状态机限制
- 之前是按钮可点但后端返 400，UX 差；现在前端就阻止

### 5-1 / 5-2 聊天归档系统（ArchiveStore + 自动触发 + 4 个 API）
- 新模块 `src/archive/ArchiveStore.js`（323 行）：
  - 配置文件 `~/.claude-panel/archive-config.json`：`rootPath / structure / timeFormat / autoArchive / events`
  - 3 种结构：`time-then-room`（默认）/ `room-then-time` / `flat`
  - 2 种时间格式：`YYYY-MM-DD` / `YYYY-MM`
  - `archiveRoom(room)` 生成 3 个文件：`final-consensus.md` + `full-transcript.md` + `meta.json`
  - `listArchives()` 扫 rootPath 子树（深度 ≤4，最多 500 条），按 archivedAt 倒序
- 安全：`isPathSafe()` 沙箱（home+tmp，禁敏感目录）+ 文件名 sanitize（中文保留，`/ \ : * ? " < > |` → `_`）
- 自动触发：`broadcastRoom` 内监听 `cfg.events` 的事件（默认 *_done）→ setImmediate 异步 archive，不阻塞
- 4 个 API 端点：GET/PUT `/api/archive/config`、POST `/api/archive/rooms/:id`、GET `/api/archive/list`
- 房级覆盖：`ChatRoomStore.room.exportPath`（沙箱后） + PATCH `/api/rooms/:id` 接受

### 5-3 顶栏 📂 配置 modal + 立即归档按钮
- 顶栏新增 📂 按钮，弹归档配置 modal：rootPath / structure / timeFormat / autoArchive
- 实时预览目录树（根据 structure + timeFormat 用样例渲染）
- 列出已归档房（前 20 条，按 archivedAt 倒序，有 mode chip + 路径）
- finalConsensus 区加「📂 立即归档」按钮（无视 autoArchive，按当前配置即刻归档）

### 5-4 验证 + 文档
- 端到端测试：`/tmp/panel-archive-test-<ts>` 跑一遍 archiveRoom → 3 个文件齐全 + 内容正确 + 越权拒绝
- 文件名 sanitize 验证：`"搜索/测试"` → `"搜索_测试-b31b9a35"`（保留中文，仅替换 `/`）
- 新文档 `docs/ARCHIVE_GUIDE.md`：6 段（快速开始 / 文件内容 / 房级覆盖 / API / 安全沙箱 / 常见场景 / 故障排查）

### Sprint 4.5 改动文件
- 新模块 1 个：src/archive/ArchiveStore.js（323 行）
- 后端 server.js +75 行：4 个 archive 端点 + broadcastRoom 自动归档 hook + PATCH 接受 exportPath
- 前端 index.html +14 行（📂 按钮 + archive modal + 立即归档按钮）
- 前端 style.css +20 行（archive modal）
- 前端 app.js +180 行（archive CRUD + 树预览 + 立即归档）
- 文档：ARCHIVE_GUIDE.md（170 行）

---

## 7-AAA. v0.54 Sprint 4（2026-05-20，紧接 Sprint 3.5）干了什么

Sprint 4 把 panel 从"本地仪表台"升级为"对外有触手"：webhook 推外部 + HTTP plugin 拉外部 + CLI 一键起房集成第三方脚本。

### 4-1 Webhook 出站推送（🔔）
- 新模块 `src/webhook/WebhookStore.js`（持久化 ~/.claude-panel/webhooks.json，URL 必须 https:// 或 localhost http，最多 20 条）
- 新模块 `src/webhook/WebhookDispatcher.js`（监听 broadcastRoom 内的 `*_done / *_error / room_auto_paused` 事件 → 按格式构造 payload → POST URL）
- 三种格式：**discord**（embed 卡片，带颜色 + footer）、**slack**（attachments）、**json**（原始 event + 自定义 headers）
- 5 个 HTTP 端点：GET/POST/PUT/DELETE /api/webhooks + POST /api/webhooks/:id/test（即时测试连接）
- URL 在 list() 时做 mask（path 段超 12 字符变 `xxxx...yyyy`，query 里 token/key/secret/sig 也掩码）
- header injection 防御：拒包含 `\r\n` 的 header value；黑名单 host / content-length
- 顶栏新增 🔔 按钮 + modal（左侧列表 + 右侧表单：name/url/format/events/headers/enabled + 测试推送 + 删除）
- Discord webhook 实测格式：embed.title + embed.description + color + footer "Claude 控制台"

### 4-2 HTTP type plugin（PluginHttpAdapter）
- 新模块 `src/plugin/PluginHttpAdapter.js`（实现 manifest.type='http' 的 plugin）
- 支持 GET/POST/PUT/PATCH/DELETE + url/headers 模板化（`{param}` 占位）+ bodyTemplate
- replyJsonPath / tokensJsonPath（jq 风格）从 JSON 响应抽 reply / tokens
- 安全：URL 必须 https:// 或 http://localhost；body 上限 64KB；响应上限 1MB
- 默认 timeoutMs=30000，可配 1s-600s
- 更新 `docs/plugin-manifest.schema.json`：加 `http` 字段定义 + allOf 条件校验（type=http 时 required: ['http']）
- server.js exec 端点：按 `entry.manifest.type === 'http'` 分派 PluginHttpAdapter vs PluginSpawnAdapter
- 示例 manifest：`src/plugin/examples/jokeapi-http.json`（JokeAPI 公开免费 API，验证 GET + replyJsonPath）

### 4-3 CLI 一键起房（POST /api/rooms/quick）
- 新端点：一行 curl 起房 + 立即启动 dispatcher
- 接受参数：`{ topic*, mode?, name?, members?, templateId?, debateRounds?, qaStrictness?, cwd?, startNow? }`
- 套模板：`templateId='builtin:debate-tech-review'` 自动应用 mode + members + debateRounds
- 启动逻辑：startNow=true 时按 mode 调对应 dispatcher.start()；chat 模式用 sendMessage
- 文档 `docs/QUICK_API.md`：3 个常用场景示例（定时晨报、CI 失败排查、macOS Shortcut）

### Sprint 4 改动文件
- 新模块 4 个：WebhookStore (203) / WebhookDispatcher (134) / PluginHttpAdapter (157) / examples/jokeapi-http.json
- 后端 server.js +~200 行：5 webhook 端点 + quick room 端点 + broadcastRoom fireWebhooks hook + http adapter dispatch
- 前端 index.html +20 行（webhook modal + 顶栏 🔔 按钮）
- 前端 style.css +30 行（webhook modal grid）
- 前端 app.js +200 行（webhook CRUD + 测试 + 表单）
- 文档：QUICK_API.md + plugin schema 加 http 部分

---

## 7-AA. v0.53 Sprint 3.5（2026-05-20，紧接 Sprint 3）干了什么

Sprint 3 把"运营仪表台"基础搭好后，3.5 是收尾打磨：跨房搜索、自动暂停、Plugin 接 metrics、retention、Health 前端 toast。

### 3.5-1 跨房搜索（I）
- 新端点 `GET /api/rooms/search?q=...&includeArchived=0|1&limit=...`
- 搜：room.name / topic / finalConsensus / rounds[].turns[].content / conversation[].content / taskList[].title|desc / attempts[].content
- 每房 per-room cap 防同房刷屏 + hardCap 防内存爆
- 前端：新 modal `#roomSearchModal` + 快捷键 **⌘⇧R**（参照 ⌘⇧F 的设计，复用 cmdk 风格 + 高亮 mark）
- 命中点击直接跳房：`hideOverview / showRoomArea → loadRooms → selectRoom`

### 3.5-2 自动暂停（J+）
- 每个 dispatcher 新增 `this._fails: Map<roomId, count>` + `_bumpFailure(roomId, isUserAbort)` + `_resetFailure(roomId)`
- 连续 5 次失败（非用户主动 abort）自动 abort + `setStatus('auto_paused')` + WS 推 `room_auto_paused`
- 4 个 dispatcher 全部接入：Debate `_runRound` × 2 + judge × 2；Squad `_callAdapter` 集中点；Arena proposals × 2 + judge × 2；Solo `sendMessage` × 2
- 前端：room WS 接 `room_auto_paused` → toast 6s 红色提示 + `updateRoomStatusChip('auto_paused')` 显示 🛑 自动暂停
- `auto_paused` 视同 paused：续跑/重启按钮可见，UI 显示「🛑 自动暂停」

### 3.5-3 Plugin 接 metrics（K）
- `POST /api/plugins/:id/exec` 完成时 `metricsStore.record({ roomMode: 'plugin', roomId: '', turn: 'plugin:<id>.<command>', adapter: <id> })`
- 成功 / 失败都记，纳入总览页 byAdapter 横比和 timeseries 折线

### 3.5-4 Retention + Health 前端
- 新端点 `DELETE /api/metrics?olderThan=YYYY-MM` 删该月份及之前 metrics-*.jsonl
- 📊 总览页 D 块加「🗑 清理老 metrics」按钮：promptModal 输入 YYYY-MM → confirmModal → API 删 → toast
- `/ws/global` 改为**全局长连接**（启动时 `ensureGlobalWs()`，不依赖 📊 打开），自动重连指数退避（800ms → 1.6s → ... → 8s，最多 8 次）
- `health_warning` WS 事件：任何视图都 toast 8s 红色提示（之前只在 overview 显示时 refresh）

### 3.5 完整改动文件
- server.js: +90 行（/api/rooms/search + DELETE /api/metrics + plugin metrics record + 修 PluginExec 失败也记）
- src/room/{Debate,Collaboration,Arena,SoloChat}Dispatcher.js: 各 +25 行（auto pause 助手 + 接入点）
- public/index.html: +12 行（#roomSearchModal）
- public/app.js: +180 行（roomSearch + globalWs + retention button + auto_paused 适配）

---

## 7-A. v0.53 Sprint 3（2026-05-20）干了什么

Sprint 3 把 panel 从「功能型工具」升级为「运营型仪表台」——开多房之后一眼看完状态 + token 趋势 + AI 横向性能 + 资源健康。

### 阶段 0：准备
- package.json `0.30.0 → 0.52.0`（与业务版本对齐）
- server.js `/api/version` 解析优先级修正：HANDOFF_NEW_CHAT.md → HANDOFF.md → package.json
- `npm i chart.js@4.5.1` + 拷 `chart.umd.min.js` 到 `public/vendor/` 离线可用
- BUGS.md 归档 v0.52 + Sprint 3 段

### 阶段 1：Metrics 后端 + WS
- 新增 `src/metrics/pricing.js`（8 大 adapter 估价表 + custom 兜底）
- 新增 `src/metrics/MetricsStore.js`（jsonl append + 2000 条 MEM cache + query/aggregate/byAdapter/overview）
- 4 个 dispatcher 全部接入 `metrics.record()`：Debate（runRound × 2 + judge × 2 + retry × 2）、Collaboration（_callAdapter 统一点）、Arena（proposals × 2 + judge × 2 + retry × 2）、SoloChat（success + error）
- 新 HTTP 端点：`/api/metrics/{overview,timeseries,by-adapter,health,pricing}` + `/api/health/processes`
- 新 WS 通道：`/ws/global`，metricsStore 写入即 `broadcastGlobal({ type: 'metrics_update', delta })`

### 阶段 2：📊 总览页前端
- 顶栏新增 📊 按钮 + `#overviewArea` 容器
- 2×2 Grid 4 块：A 房间状态 / B token 趋势折线（双轴 token / USD）/ C adapter 横比（横向条形图，5 指标可切）/ D 资源健康
- Chart.js 通过 `<script src="/vendor/chart.umd.min.js">` 异步注入
- 时间窗切换：24h/7d/30d，切换时销毁旧 chart 重建
- WS metrics_update 增量推送：1.5s 节流刷新；30s 兜底全量刷新

### 阶段 3：稳定性监控（J 最小集）
- `/api/health/processes` 端点（`pgrep -P <panel pid> + ps`）列直接子进程 + PTY 终端 + 活跃 dispatcher 数
- **修 Sprint 1 遗留 bug**：`DELETE /api/rooms/:id` 漏 `arenaDispatcher.abort` → 修
- **修 Sprint 1 遗留 bug**：`gracefulShutdown` 漏 `arenaDispatcher.abort` → 修
- 启动后 5s 跑一次 health sweep + 每 30 min 周期巡检；新告警 broadcastGlobal `health_warning`（dedup 避免 spam）

### 阶段 4：🎯 房间模板
- 新增 `src/templates/RoomTemplatesStore.js`：6 个内置模板（不可删/改）+ 用户模板 50 上限
- 3 个端点：`GET /api/room-templates`、`POST /api/room-templates`、`DELETE /api/room-templates/:id`（内置禁删）
- 顶栏新增 🎯 按钮 + 模板选择 modal（左侧列表 / 右侧详情 + 名字/topic prefill / 一键建房 → 自动 selectRoom + topic prefill）
- 6 个内置：技术方案三方评审、事实型对决（联网核对）、需求→实现拆分、快速二方对辩、长文翻译对决、和 Gemini 闲聊（带联网）

### 阶段 5：联调 + 文档
- 9 个改过文件全部 `node --check` 通过
- 端到端 sanity（pricing / record / overview / templates / 4 个 dispatcher 构造） 全过
- 新增 `docs/METRICS_GUIDE.md`（5K 字）：架构 / 字段 / 端点 / 定价 / 持久化 / FAQ / 扩展点
- HANDOFF + BUGS 更新

### Sprint 3 全部新增 BUG 修复
- **S3-V01** `/api/version` 优先级修正（HANDOFF_NEW_CHAT.md 优先）
- **S3-V02** package.json version 跟随业务版本
- **S3-V03** DELETE /api/rooms/:id 漏 arenaDispatcher.abort
- **S3-V04** gracefulShutdown 漏 arenaDispatcher.abort

---

## 7. v0.52 这一轮（2026-05-19 → 2026-05-20）干了什么

### Sprint 0：Adapter 池扩展 + UX
1. 加 GeminiSpawnAdapter（PTY 方案绕 OAuth）+ GeminiChatAdapter + OpenAICompatChatAdapter + 自定义条目（最多 10 个）
2. ⚙️ adapter 配置 modal：per-adapter timeout + maxTokens 可调
3. 辩论房 N 大轮可配置（方案 B：整组 R1/R2/R3 翻 N 倍）
4. 房间归档（📦 列表底部折叠区 + 右键归档 + 恢复 / 彻底删）
5. UI 英文全译成中文（Chat/Debate/Squad/idle/Daemon/Swarm/... 全替换）
6. 删左下角"参考 Codex UI"提示

### Sprint 1：完整工作流体验
- **A** Arena 多组对决（带联网核对的 judge，匿名化提案）
- **C** Squad 续跑（保留 taskList 从中断 task 继续）
- **D** 局部重试单个 turn（含并发锁，error 卡片右上 🔄 按钮）
- **F** 工作流串联（finalConsensus 转给小组/辩论/对决/闲聊房，可选自动启动）

### Sprint 2：通用 CLI Wrapper 完整
- **W1**：plugin manifest schema + PluginRegistry + PluginSpawnAdapter + 5 个 HTTP 端点 + 3 内置 manifest
- **W2**：🧩 Plugin 中心前端 + 仪表盘 4 种卡片渲染器 + stdout/stdout-jsonl 解析 + 3 个示例 manifest + 文档

### 其他重要修复
- spawn timeout 默认 30 min（可在 ⚙️ 拉到 2h），HTTP 默认 20 min
- max_tokens 全部放宽（不传 = 服务端默认上限）
- 心跳广播：spawn stdout 触发 / HTTP 20s keep-alive → placeholder 显示"已收 X KB"
- 卡死检测：60s 无新输出 placeholder 变红 + "疑似卡住，可点 ⏹ 立即结束"
- 顶部状态栏：🏟 运行中 N 房 + ≥3 房启动新房弹 confirm 警告
- ⏹ 立即结束按钮（红，常驻）+ Esc 全局快捷键
- Squad 数据流 bug：PM 总结过滤 error attempts，不再把"[dev 失败]"当 deliverable

### 全量审查发现并修的 BUG（Sprint 1 + Sprint 2）
1. ChatRoomStore mode 白名单缺 `arena`
2. PATCH /api/rooms/:id role 校验缺 arena 房专属白名单
3. ArenaDispatcher：默认 judge 被排除出 proposers
4. ArenaDispatcher 缺 retryTurn 方法
5. 前端 paused 对 arena 房不该显示「续跑」按钮
6. `/forward` 缺 MAX_ROOMS 检查
7. forward 复用源房 cwd 没防御性沙箱重校
8. DebateDispatcher.retryTurn 并发竞争（连点两次）
9. plugin schema timeoutMs 上限不一致（1.8M vs server 7.2M）

---

## 8. 当前已知小问题（不阻塞，留给下一轮）

| 项 | 严重度 | 备注 |
|---|---|---|
| chat 房不支持续跑 | 低 | 闲聊直接重发上一条即可，不必做 |
| Plugin dashboard 仅支持 stdout/stdout-jsonl 事件源 | 中 | log-tail/SSE/WS 留 W3 |
| Plugin 无 HTTP type 支持 | 中 | manifest schema 已留 type:"http" 占位但未实现 |
| ~~总览面板没做~~ | ✅ v0.53 Sprint 3 完成 | |
| ~~房间模板没做~~ | ✅ v0.53 Sprint 3 完成 | |
| ~~跨房搜索没做~~ | ✅ v0.53 Sprint 3.5 完成 | ⌘⇧R |
| ~~Metrics retention~~ | ✅ v0.53 Sprint 3.5 完成 | 手动按 YYYY-MM 删 |
| ~~自动暂停~~ | ✅ v0.53 Sprint 3.5 完成 | 连续 5 次失败 |
| ~~Plugin 没接 metrics~~ | ✅ v0.53 Sprint 3.5 完成 | |
| Plugin dashboard 仅支持 stdout/stdout-jsonl 事件源 | 中 | log-tail/SSE/WS 留 W3 |
| ~~Plugin 无 HTTP type 支持~~ | ✅ v0.54 Sprint 4 完成 | PluginHttpAdapter |
| Plugin marketplace 没做 | 低 | W3 候选 |
| webhook 推送只有 outgoing，没接收命令（incoming）| 中 | Slack/Discord bot 命令需要注册 app + OAuth，留 Sprint 5 |
| VS Code 扩展未做 | 低 | 独立项目，工作量大，留 future |
| Gemini API HTTP 没 grounding | 低 | Gemini API 要手动声明 google_search tool，等需求 |

---

## 9. 下一步推荐路线（按优先级）

### ~~🌱 Sprint 3.5 — 收尾 / 深化~~ ✅ 已完成（见 §7-AA）

### ~~🌱 Sprint 4 — 协同 / 自动化~~ ✅ 部分完成（见 §7-AAA）

完成：Webhook 推送 + HTTP plugin + CLI quick API
未做：VS Code 扩展（独立项目）、Plugin marketplace（依赖外部 aggregator）

### 🌱 Sprint 4 — 协同 / 自动化（候选 1 周）
- Slack / 钉钉 Bot（/ask topic 命令）
- VS Code 扩展（panel webview iframe）
- Discord webhook：房完成时推总结到 channel

### 🌱 W3 Plugin 实时事件源（候选）
- log-tail（轮询读文件尾）/ SSE / WebSocket 长连接事件
- Plugin marketplace（GitHub aggregator + 一键装）
- HTTP type plugin（接 REST API）

---

## 10. 接手第一步（在新会话）

```bash
# 1. 确认 panel 在跑
curl http://localhost:51735/api/version

# 2. 一键健康检查（应 ~15 个 200 + 2 个 403）
# v0.53 + v0.54 新加 metrics + health + room-templates + webhooks 端点
for ep in 'search?q=x' 'prompts' 'sessions' 'plugins' 'room-adapters' 'rooms' 'ruflo/health' \
          'metrics/overview' 'metrics/timeseries' 'metrics/by-adapter' 'metrics/health' 'metrics/pricing' \
          'health/processes' 'room-templates' 'webhooks'; do
  curl -s -o /dev/null -w "  GET /api/$ep -> %{http_code}\n" "http://localhost:51735/api/$ep"
done
curl -s -o /dev/null -w "  /api/file → %{http_code} (want 403)\n" "http://localhost:51735/api/file?path=/etc/passwd"
curl -s -o /dev/null -w "  /api/browse → %{http_code} (want 403)\n" "http://localhost:51735/api/browse?path=/etc"

# 3. 看完成情况
浏览器 http://localhost:51735
- 顶栏 6 个按钮：📊 💻 💬 🐝 🧩 ⚙️ （v0.53 新加 📊）
- ⌘? 全部快捷键
- 进辩论房有「🔁 大轮数」+「🚀 启动辩论（N 大轮）」
- finalConsensus 区有 4 个「➡️ 转给 X 房」按钮
- error turn 卡片右上有「🔄 重试这个」
- 多房列表顶栏有「🎯 从模板新建」按钮（v0.53）
- 📊 总览页 2×2 卡片：房间状态 / token 折线 / adapter 横比 / 资源健康（v0.53）
- ⌘⇧R 跨房搜索（v0.53 Sprint 3.5）
- 📊 总览 D 块「🗑 清理老 metrics」按钮（v0.53 Sprint 3.5）
- 顶栏 🔔 Webhook 配置 modal（v0.54 Sprint 4）
- 外部 curl 一键起房：见 docs/QUICK_API.md（v0.54 Sprint 4）
```

---

## 11. ⚠️ 必读：用户红线（不能自主做）

按 `~/.claude/CLAUDE.md`：
- 🔴 不要 git commit 这个项目（除非用户明说）
- 🔴 不要 launchctl / cron / 系统级 daemon
- 🔴 **不要 spawn `claude -p` / `claude --print` 跑用户付费配额**（panel 自己 spawn 是响应用户 HTTP 请求，AI 助手自己跑要先问）
- 🔴 不要删除/重命名/移动用户文件
- 🟡 安装 npm 全局包先问

panel 后端 spawn claude / codex / claude-flow / gemini 是**响应 HTTP 请求时跑**，跟"AI 助手自己跑测"区分开。

---

## 12. 安全沙箱约束（v0.49 起，v0.52 加固）

| 沙箱 | 范围 |
|---|---|
| 路径沙箱 `safeResolveFsPath()` | 白名单：home 子树 + `/tmp`，禁 `.ssh / .aws / .gnupg / .docker / .kube / Library/Keychains` |
| listen 仅 `127.0.0.1` | `PANEL_HOST=0.0.0.0` 才开放 LAN |
| WS Origin 白名单 | 防 CSRF |
| WS payload 上限 | 8 MB（v0.52 放宽，仍守住 DDoS）|
| 输入长度上限 | name≤200 / topic≤120000 / chat≤64000 / inject≤32000 / hook payload≤50KB |
| AppleScript 注入加固 | do script 双重转义 + 拒控制字符 |
| Plugin manifest 上限 | 32KB |
| 内置 plugin id 不可被用户 manifest 覆盖 | 防 hack `claude` 等关键 id |

---

## 13. 当前 panel 健康状态

- **版本**：v0.53（package.json 0.52，HANDOFF 0.53——前者落后是因为代码已写但 panel 尚未重启）
- **PID**：执行 `lsof -iTCP:51735 -sTCP:LISTEN -t` 看
- **日志**：`/tmp/panel-v053.log`（重启后）
- **总改动 v0.53**：4 个修复（DELETE/gracefulShutdown 漏 arena + /api/version 优先级 + package.json 版本对齐）+ 4 个新模块（metrics × 2 / templates / overview UI）+ 5 个新 HTTP 端点 + 1 个新 WS 通道 + 3 个端到端测试通过
- **rooms.json 容量**：500 房上限
- **metrics 容量**：每月 jsonl，单文件 > 50MB 滚动归档，无自动 retention
- **adapter 池**：默认含 claude/codex/ollama 三个内置；用户在 ⚙️ 启用 minimax/gemini/gemini-openai/gemini-cli/custom 后会出现
- **plugin 池**：默认 3 个 builtin（claude/codex/gemini-cli），用户可装到 `~/.claude-panel/cli-plugins/`
- **房间模板池**：默认 6 个 builtin（技术评审 / 事实对决 / 需求拆分 / 二方对辩 / 翻译对决 / Gemini 闲聊），用户可加自定义到 `~/.claude-panel/room-templates.json`，上限 50

### ⚠️ 重启 panel 才能让 v0.53 代码生效

写 v0.53 时为了不破坏 2 个 running 房（"搜索2" debate / "搜索3" squad）的中途状态，**没有重启 panel**。代码已落盘，旧 v0.50 panel 还在跑。重启方式：

```bash
# 1. 优雅 ctrl-c 当前 panel（会自动 saveData + abort dispatcher）
# 或 kill -TERM <pid>
# 2. 重新启动
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
nohup node server.js > /tmp/panel-v053.log 2>&1 &
# 3. 等 3s 后跑健康检查（见 §10）
```

注意：running 房在重启后会被 ChatRoomStore 自动从 `running` 改回 `idle`（见 ChatRoomStore.js:75）。已采集的 R1/R2/R3 turn 不会丢，但当前正在跑的那一轮 turn 会丢，需要点 "▶ 续跑"。

---

**最后更新**：2026-05-20 v0.53 Sprint 3 / 3.5 + v0.54 Sprint 4 全部完成
**当前状态**：✅ 代码全过静态审查 + sanity 测试（27 个文件全语法过 / 5 项端到端断言通过），待用户重启 panel 后做 UI 端到端验证
