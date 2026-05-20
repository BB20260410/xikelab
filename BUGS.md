# BUGS.md — Bug 清单（冻结版）

> 每条含：**复现步骤** + **期望结果** + **当前实际**。修完把 `Status: Open` 改为 `Status: Fixed`，无法修的标 `WontFix` 并写原因。
>
> **此清单已冻结**，新发现的 bug 记到 `NEXT_ROUND.md`（如不存在则不记）。

---

## B-01 cwd 字段接受任意字符串 → 产生不可用 session
**Status: Fixed** (v0.49 — POST /api/sessions 已校验 cwd 必须绝对路径或 ~)
**严重度**：HIGH（产生脏数据，已实测发生过 cwd="回答"/"1" 两条）
**位置**：`server.js:173-198`、`public/app.js:248-251`

**复现步骤**：
1. 启动 panel，UI 点「＋ 新建会话」
2. 名称随便填，**cwd 字段填 `abc`**（一个不存在的字符串）
3. 点「创建」

**期望结果**：前端拒绝提交，提示「路径不存在」；或后端返回 400。

**当前实际**：session 被创建并持久化到 `data.json`，cwd 字段直接是字符串 `"abc"`。后续向该 session 发消息会让 `spawn(claude, {cwd:'abc'})` 失败，但 UI 不显示错误。

---

## B-02 `/api/files` 与 `/api/file` 无路径沙箱（可读任意文件）
**Status: Fixed** (v0.49 — safeResolveFsPath：白名单 home+/tmp，禁 .ssh/.aws/.gnupg/.docker/.kube/Library/Keychains)
**严重度**：HIGH（安全）
**位置**：`server.js:247-283`

**复现步骤**：
```bash
curl 'http://localhost:5173/api/file?path=/Users/hxx/.ssh/id_rsa' \
  | python3 -m json.tool | head -5
```

**期望结果**：返回 403 Forbidden（或类似拒绝），不暴露文件内容。

**当前实际**：直接返回文件全文（只要 < 1MB）。

---

## B-03 interrupt 后 `busy` 立即标 false，但子进程仍可能在推消息
**Status: Fixed** (v0.49 — session._dropOutput 标记，broadcastSession 拦 message/partial 类型；SIGINT→1s SIGTERM 兜底；exit handler 清 flag)
**严重度**：MEDIUM（UI 状态不一致）
**位置**：`server.js:286-294`

**复现步骤**：
1. 给一个 session 发个会触发长任务的 prompt（如「分析整个 Desktop 目录」）
2. 立刻（500ms 内）调 `POST /api/sessions/:id/interrupt`
3. 观察 WS 推送

**期望结果**：interrupt 后不再有该 session 的 `message` 类型推送。

**当前实际**：`busy` 立刻变 false 但子进程实际还要数百 ms 才退出，期间 stdout 已 parse 的消息继续 broadcast，前端看到「明明显示空闲了却又冒出 assistant 消息」。

---

## B-04 进程被 kill（SIGTERM / kill -9）会丢最近 500ms 内未保存的消息
**Status: Fixed** (v0.36 / v0.45 — gracefulShutdown 在 SIGINT/SIGTERM 都调 saveData + roomStore.flush；uncaughtException/unhandledRejection 也补落盘)
**严重度**：MEDIUM（数据丢失）
**位置**：`server.js:33-50, 376-381`

**复现步骤**：
1. 给 session 发消息，等 assistant 开始回（确认 stdout 已写入 session.messages）
2. 在 500ms 内 `kill -TERM <server pid>`
3. 重启 server 看 `~/.claude-panel/data.json` 是否含这条 assistant 消息

**期望结果**：消息持久化到 data.json，重启后仍可见。

**当前实际**：debounce 还没触发 saveData 就被 kill，消息丢失。SIGINT handler 只 kill children，没调 saveData。

---

## B-05 `/api/file` 截断时返回占位字符串当作内容附进 chat
**Status: Fixed** (v0.49 — 后端真读前 1MB 返回 truncated:true+truncatedBytes；前端 openFileInChat 识别并 toast 提示)
**严重度**：LOW（误导）
**位置**：`server.js:269-283`、`public/app.js:308-323`

**复现步骤**：
1. 准备一个 > 1MB 的文本文件（如 `head -c 1500000 /dev/urandom | base64 > /tmp/big.txt`）
2. UI inspector 文件 tab 浏览到该文件
3. 点击文件 → 内容被附进 chat 输入框

**期望结果**：UI 提示「文件过大已截断」，附入 chat 的应是文件前 N 字节真实内容或拒绝附入。

**当前实际**：chat 输入框被填入 `参考文件 /tmp/big.txt:\n\`\`\`txt\n(file > 1MB, truncated)\n\`\`\``——字符串 `(file > 1MB, truncated)` 被当成文件内容发给 claude。

---

## B-06 删除非 active session 时未关闭 WS
**Status: WontFix**
**严重度**：LOW（小内存泄露）
**位置**：`public/app.js:38-45`

**复现步骤**：
1. 创建 2 个 session A 和 B
2. 选中 A（建立到 A 的 WS）
3. 右键 B 的列表项 → 关闭 B
4. 浏览器 DevTools Network → WS 标签

**期望结果**：删除 B 时不应影响 A 的 WS；删除 A 时应主动关 A 的 WS。当前删除 A 已处理（line 40-42），逻辑本身正确。

**当前实际**：实际审视后发现 — 删除非 active 的 B 时，B 本来就没有活跃的 WS（state.ws 只指向 activeId 对应的连接），所以**这条不构成 bug**。

> 跳过原因：复盘代码后确认伪 bug，仅 active 的 session 才有 WS 实例。Status 改为 **WontFix**。

---

**清单已冻结 — hxx 2026-05-17**
**总条目数：6（Fixed: 5 / WontFix: 1 / Open: 0）** — v0.49 全清

---

## v0.49 全面审查发现 + 修复（新增，非 BUGS.md 冻结清单内）

以下是这一轮审查中新发现的问题，全部已修 + 真测通过：

- **N-01** server 默认监听 `*:51735`（暴露 LAN）→ 改 `127.0.0.1`，`PANEL_HOST=0.0.0.0` 可覆盖
- **N-02** WS upgrade 无 Origin 校验（CSRF 控 PTY 终端）→ 白名单 localhost/127.0.0.1
- **N-03** `/api/browse` 漏修 B-02 的同类沙箱 → 接入 safeResolveFsPath
- **N-04** `/api/term` cwd 无沙箱 + shell 任意 → 沙箱 + shell binary 白名单
- **N-05** AppleScript `do script` 注入：cwd 含双引号破外层字符串 → buildClaudeTerminalScript 双重转义 + 控制字符拒绝 + resumeId 严格正则
- **N-06** name/mainGoal/cwd 长度无上限 → MAX_NAME_LEN 200 / MAX_GOAL_LEN 4000 / MAX_CWD_LEN 1024
- **N-07** `POST/PATCH /api/rooms` cwd 无沙箱（间接 spawn claude/codex 在敏感目录）→ safeResolveFsPath
- **N-15** SoloChatDispatcher.conversation 无上限 → 持久化 cap 200 / 发 LLM 取最近 40
- **N-16** `POST /api/sessions/:id/messages` text 无长度限制 → 2MB cap
- **N-18** `/api/hooks/:event` 单条 payload 无限大 → 50KB 截断保留关键字段
- **N-19** `/api/projects/:name` path traversal → name 正则 + realpath 边界
- **N-20** DELETE session/room 不清 WS clients / dispatcher / watcherState → 主动 close+abort+resetSession

## v0.49 第二轮审查（含 ruflo 集成 + 之前没审过的模块）

- **N-21** marked + DOMPurify 主路径 **和** fallback regex 都给 `<a target="_blank">` 没加 `rel="noopener noreferrer"` → Reverse Tabnabbing 攻击（新页 window.opener 篡改原页）→ DOMPurify afterSanitizeAttributes hook 强制 + fallback regex 加 rel
- **N-23** GET `/api/ruflo/memory` 的 `q` / `namespace` 无长度限制 → 超长 arg 让 spawn 报 E2BIG → q ≤ 500 / namespace ≤ 100
- **N-30** POST `/api/ruflo/swarm/init` 空 body 默认参数会真触发 swarm init（误触发风险，连测试都会改 ruflo 状态）→ topology 必填
- **N-36** LoopGuard.recordCost 双重累计 bug：caller 传的是 `tracker.windowUSD(5min)` 累计窗口值，guard 内部 push 到 `recentCosts` 再 reduce —— 多个 turn 后 sum 远大于真实成本，触发 cost_surge 误熔断 → 直接用累计值比阈值，删 recentCosts 数组
- **N-45** ClaudeSpawnAdapter spawn 时 `env` 写死，没合并 `opts.env` → CCRSpawnAdapter 传的 `CCR_PROVIDER_HINT` 完全没生效（dormant bug）→ `env: { ...process.env, LANG..., ...(opts.env || {}) }`

## v0.52 全量审查发现 + 修复（Sprint 1 + Sprint 2）

详见 HANDOFF_NEW_CHAT.md §7。简列如下，全部已修：

- **V52-01** ChatRoomStore mode 白名单缺 `arena` → 加入白名单
- **V52-02** PATCH /api/rooms/:id role 校验缺 arena 房专属白名单 → 补 arena 角色
- **V52-03** ArenaDispatcher：默认 judge 被错误地排除出 proposers → 修复 proposer 选择逻辑
- **V52-04** ArenaDispatcher 缺 retryTurn 方法 → 实现局部重试
- **V52-05** 前端 paused 状态对 arena 房不应显示"续跑"按钮 → 按 mode 分支
- **V52-06** `/forward` 缺 MAX_ROOMS 检查 → 转房时校验房间总数
- **V52-07** forward 复用源房 cwd 没防御性沙箱重校 → 重新走 safeResolveFsPath
- **V52-08** DebateDispatcher.retryTurn 并发竞争（连点两次会双跑）→ 加 _retryLock
- **V52-09** plugin schema timeoutMs 上限不一致（1.8M vs server 7.2M）→ 统一 7200000 (2h)

## v0.53 Sprint 3 — 数据可视化总览 + 稳定性 + 模板（2026-05-20 完成）

- **S3-V01** /api/version 端点解析优先级修正：HANDOFF_NEW_CHAT.md → HANDOFF.md → package.json（之前只认 HANDOFF.md）
- **S3-V02** package.json version 跟随业务版本号（0.30 → 0.52，后续每 Sprint 同步）
- **S3-V03** DELETE /api/rooms/:id 漏 `arenaDispatcher.abort` → arena 房删除后 spawn 子进程仍会跑完
- **S3-V04** gracefulShutdown 漏 `arenaDispatcher.abort` → SIGINT/SIGTERM 时 arena 房不优雅退出
- **S3-N01** 新功能：MetricsStore 月度 jsonl + 4 dispatcher 全部埋点
- **S3-N02** 新功能：📊 总览页（2×2 卡片 + Chart.js 折线/横向条形）
- **S3-N03** 新功能：🎯 房间模板（6 内置 + 用户存）
- **S3-N04** 新功能：/api/health/processes + 30 min 周期巡检 + health_warning WS 推送

## v0.53 Sprint 3.5 — 跨房搜索 + 自动暂停 + Plugin metrics + retention（2026-05-20 完成）

- **S35-N01** 新功能：跨房搜索（⌘⇧R），搜 name/topic/finalConsensus/turn/conversation/task
- **S35-N02** 新功能：自动暂停（4 dispatcher 连续 5 次失败 → auto_paused + WS 推送），用户主动 abort 不计数
- **S35-N03** 新功能：Plugin exec 也接 metrics（roomMode='plugin'，纳入 byAdapter / timeseries）
- **S35-N04** 新功能：DELETE /api/metrics?olderThan=YYYY-MM + 📊 D 块「🗑 清理老 metrics」按钮
- **S35-N05** 改进：/ws/global 改为启动时全局长连接 + 指数退避重连 + health_warning 任何视图都 toast

## v0.56 Sprint 16 — UI 框架排版修复（2026-05-20）

针对用户反馈「modal 关闭按钮不跟随滚动 / Autopilot toggle row 文字按字纵向排列 / 还有很多类似问题」全面扫修。

- **S16-V01** Bug 修复：`.project-modal-head` 改 `position: sticky; top: 0`，11 个 modal 的 ✕ 关闭按钮跟随滚动（之前要滚回顶才能关）
- **S16-V02** Bug 修复：Autopilot toggle row 描述文字按字垂直排列——根因 flex 子元素无 `min-width: 0` + 中文长串不能换行。改 `.ap-desc` 加 `flex: 1 1 220px + min-width: 0 + word-break: break-word`；toggle-row 加 `flex-wrap: wrap`；rule 行同样处理
- **S16-V03** Bug 修复：`.room-debate-actions` 缺 `flex-wrap`，房状态栏按钮多了横向溢出 → 加 wrap

### UI 框架级调整（6 项）
- **S16-U01 (U1)** `.app` 三栏 grid 响应式：1280px 收成 220+1fr+280；1100px 隐 inspector；760px sidebar 收成 emoji 列
- **S16-U02 (U2)** 顶栏按钮 `.theme-toggle` 28x28 → 26x26，gap 6 → 4，flex-shrink: 0，11 按钮一行更易塞
- **S16-U03 (U3)** Inspector 折叠按钮 `⇥` / `⇤`（顶栏新增，状态持久化 localStorage `panel:inspectorHidden`）
- **S16-U04 (U4)** Squad task-detail 抽屉 `min(520px, 90vw)` → `min(440px, 50vw)` 防挡 chat 区
- **S16-U05 (U5)** Chat bubble 加 `overflow-wrap: anywhere + word-break: break-word + min-width: 0`，长 URL/token 不撑出 bubble；内嵌 pre/code 也加 `white-space: pre-wrap`
- **S16-U06 (U6)** Room topic input 加 「⤢ 展开」按钮 → 全屏 textarea 编辑（`position: fixed; inset: 5vh 5vw; z-index: 200`），适合长 topic
- **审查**：JS 语法过、CSS { 和 } 966 vs 966 配对、HTML div 258/258 配对、panel /api/version 返 v0.56 + /api/rooms 200

## v0.56 Sprint 15 — Resilience 三件套 + Autopilot（2026-05-20）

参考 ruflo (@claude-flow) v3.7.0 的 `shared/resilience/` + `autopilot-state.js` + `services/claim-service.js` 改造适配。3 轮审查全过。

- **S15-N01 (R1)** CircuitBreaker：CLOSED → 5 次失败 → OPEN → 30s 冷却 → HALF_OPEN → 2 次成功 → CLOSED；进程级 registry 按 adapter.id key 隔离；OPEN 时 `beforeCall()` 抛 CIRCUIT_OPEN code 不再 spawn 浪费 30 min timeout
- **S15-N02 (R2)** Bulkhead：每 adapter `maxConcurrent: 3 + maxQueue: 20`，超队列直接拒（防 arena 5 AI 撑爆 RAM）；排队 60s 超时
- **S15-N03 (R3)** RateLimiter：token bucket `60/min + burst 10`，`tryAcquire` 同步 + `acquire(timeout)` 等 token；防 MiniMax/Gemini 503
- **S15-N04** RoomAdapter 基类改造：把 8 个子 adapter `chat()` → `_doChat()`；基类 `chat()` 统一套 breaker + RL + bulkhead；CCR 保留 `chat()` override（wrap super.chat 注入 env）
- **S15-N05** 3 个端点：`GET /api/safety/status` / `POST /api/safety/breakers/:key/reset` / `PUT /api/safety/rate-limit/:key`；breaker 状态变化 broadcastGlobal `circuit_state` 给前端 toast
- **S15-N06 (R4)** Autopilot：默认关闭；5 个内置规则（debate→squad / arena→chat / squad→arena / error→notify / auto_paused→notify）；每条链 maxHops=5 防环；同房同事件 5s dedup
- **S15-N07** Claim：房 `claimedBy='user'` 时 autopilot 不动；forward 后新房标记 `claimedBy='autopilot:<jobId>'` 链路可追溯
- **S15-N08** 6 个 autopilot 端点（config CRUD + toggle + log + 规则）；自动 hook broadcastRoom 监听事件
- **S15-N09** 顶栏 🤖 Autopilot modal：大开关 + maxHops + 规则列表（enable 开关 + 删除）+ 实时日志 tail
- **审查 1**：全 30+ 文件语法 + panel 启动 + 11 端点 200
- **审查 2**：规则注入攻击全拒（bad when / forward 缺 target / 删 builtin）+ dedup 5s + breaker 状态机正确
- **审查 3**：8 adapter 全改 `_doChat`、CCR 保留 `chat()`；115 个 /api 端点；4 个 safety 文件 + 2 个 autopilot 文件共 660 行新代码

## v0.55 Sprint 14 — Report 异步化 + Skills→dispatcher + KB embedding + SSE streaming（2026-05-20）

3 轮审查全过。

- **S14-V01** Bug 修复：报告生成报「❌ 异常：Load failed」——Safari WebKit fetch 60s 超时硬限制。改：POST /api/rooms/:id/report 立返 202 jobId，后台跑 generateReport，完成 broadcastGlobal report_done/error；前端 WS 监听 jobId 匹配，5min 兜底超时
- **S14-N01 (F2)** Skills 接入 4 dispatcher：room.skills[] PATCH 接受 + src/room/skillInjector.js 把 enabled skill 拼到 messages 的 system；8 处 adapter.chat 调用前自动注入（debate ×4 / arena ×4 / collaboration ×2 / chat ×2）
- **S14-N02 (F3)** KnowledgeStore embedding：addDocument 时调 ollama /api/embeddings 拿 vector；search 自动选 cosine（全 chunk 有 embed 时）或 fallback BM25；KB 可独立配 embedModel / embedUrl；ollama 不可用静默 fallback 不影响主流程
- **S14-N03 (F4)** /v1/chat/completions 支持 SSE streaming：stream=true 时返 text/event-stream，adapter.onProgress 转 OpenAI delta chunk；15s heartbeat 防中间代理 idle 关连接；最后 finish_reason:'stop' + [DONE]；非 streaming 路径保留

## v0.55 Sprint 13 — ABCDE 全部完成（2026-05-20）

按 Cherry Studio 剖析推荐顺序做完 5 项功能 + 3 轮审查。

- **S13-V01** Bug 修复：归档 modal 加载失败时只显"配置加载失败"——改为详细引导（重启 panel / 删配置文件 / 看 log）
- **S13-N01 (E)** 归档 modal 错误引导增强
- **S13-N02 (A)** OpenAI 兼容 API server：`GET /v1/models`（19 个 model id：`adapterId:modelName`）+ `POST /v1/chat/completions`（OpenAI 标准请求/响应，非 streaming），可让 VS Code Continue / Cursor / 任意 OpenAI SDK 把 panel 当 backend
- **S13-N03 (C)** Skills 系统：`src/skills/SkillStore.js` 兼容 Claude Skills 格式（SKILL.md frontmatter）+ 6 个 HTTP 端点（CRUD + reload）+ `buildSystemPromptForSkills()` 给 dispatcher 用
- **S13-N04 (D)** trace 时间线：`GET /api/metrics/by-room` + 房 finalConsensus 区「📈 时间线」按钮 + Chart.js scatter（按 adapter 着色）+ table 列每个 turn latency/tokens/状态
- **S13-N05 (B)** 知识库 RAG MVP：`src/knowledge/KnowledgeStore.js`（chunk by 段落 + 长度 + 重叠 100 char）+ 7 个端点（CRUD KB + 加/删文档 + 搜索）+ BM25-like 评分（TF * IDF + 长度惩罚）；embedding 升级留下一个 sprint

- **S13-V02** Bug 修复：`app.use('/api', fallback)` 位置错（在 skills/knowledge 端点注册之前），导致 GET /api/skills / /api/knowledge 都返 404 → 把 fallback 移到所有 /api/* 路由之后
- **S13-V03** Bug 修复：知识库 BM25 score 在单 chunk + query token df=1 时 IDF = log(1) = 0 → score 永远 0 → hit 全被 `score > 0` 过滤掉 → 修：IDF 加 0.5 保底

- **审查 1**（语法 + 端到端）：8 个新加端点 200，重启 panel 在 51735 端口成功 v0.55
- **审查 2**（边界 case + 安全）：/v1 streaming 拒、`../../etc` skill 名拒、knowledge `tokenize` 中英文支持
- **审查 3**（架构 + 文档 + 长尾）：6 个 Store 风格一致、文件权限 0o600/0o700 一致、108 总端点、43 个源文件

## v0.55 Sprint 12 — MCP 客户端集成（2026-05-20 完成）

参考 Cherry Studio 的 MCP 深度集成，补齐 panel 最大短板。3 轮审查全过。

- **S12-N01** 新模块：`src/mcp/McpStore.js`（持久化 `~/.claude-panel/mcp-servers.json`，配置格式跟 Claude Desktop 兼容；含 stdio/sse/http 三类、enabled 开关、env / headers 掩码、上限 50 server）
- **S12-N02** 新模块：`src/mcp/McpClientManager.js`（包装 @modelcontextprotocol/sdk Client + 3 种 Transport：Stdio / SSE / StreamableHTTP；lazy 连接 + 复用 + 30s 连接超时 + 60s callTool 超时 + disconnectAll）
- **S12-N03** 6 个 HTTP 端点：GET/POST/PUT/DELETE `/api/mcp/servers`、POST `/api/mcp/servers/:name/test`（真连验证 + listTools/Resources/Prompts）、GET `/api/mcp/servers/:name/tools`
- **S12-N04** ClaudeSpawnAdapter spawn 时自动注入 `--mcp-config <tmp>` 让 CLI 原生加载启用的 stdio MCP servers；cleanup 时 unlinkSync tmp 文件
- **S12-N05** gracefulShutdown 增加 `mcpClientManager.disconnectAll()`，PUT/DELETE 触发 disconnect 旧连接
- **S12-N06** 顶栏新增 🔌 按钮 + 配置 modal：CRUD 表单（stdio command+args+env / sse+http url+headers）+ 测试连接 + 列工具 + 启用开关
- **S12-S01** 安全：command 字段拒 shell 元字符（`;&|\`$(){}<>`）+ 拒含空格 + 拒控制字符 + 黑名单（rm/curl/sudo/wget/dd/mv/mkfs/sudo）；headers 拒 host/content-length + 拒 \\r\\n 注入；URL 必须 https:// 或 http://localhost；env 键 [A-Z_]，环境变量值含 KEY/TOKEN/SECRET 自动掩码
- **审查 1（功能闭环 + 安全）**：6 个端点 sanity 全过 + rm/sudo 拒 + http 非 localhost 拒 + header injection 拒
- **审查 2（边界 case + 资源）**：60 args cap 30 + host header 过滤 + 重复 disconnect 安全 + tmp 文件 cleanup 配对 + ensureConnected nonexist 抛错
- **审查 3（架构融合 + 文档）**：跟 plugin/templates/webhook 风格一致；语法全过；panel 启动 + 5 端点 200

## v0.54 Sprint 11 — forward 带完整历史 + AI 总结报告（2026-05-20 完成）

- **S11-V01** Bug 修复：forward 到 chat 房只 seed finalConsensus 一条 → AI 看不到原房 R1/R2/R3 详细讨论。改为拍平 rounds+turns+conversation+taskList → 跟 finalConsensus 一起 seed（transcript 60KB cap + final 20KB cap）；按钮提示同步更新
- **S11-N01** 新功能：`POST /api/rooms/:id/report`（让 AI 浓缩房聊天历史成报告），按 4 种 mode 选不同 SUMMARY_PROMPT（debate=6 节 / arena=5 节 / squad=6 节 / chat=5 节）
- **S11-N02** 前端：finalConsensus 区加「📝 生成总结报告」按钮 + modal（选 AI / model / 路径 / 自动路径，progress + 预览 + 下载 .md + 复制 + 换 AI 重生成）
- **S11-N03** 报告调用也记 metrics（`roomMode='report'`，纳入 byAdapter 统计）

## v0.54 Sprint 10 — 完全移除 Ruflo / 多智能体协调框架面板（2026-05-20 完成）

- **S10-V01** 用户反馈：「集群、智能体、这个面板对自己完全没用」→ 整块删除
- 删除范围：
  - 顶栏 🐝 按钮（HTML）
  - #rufloArea 整个 div + Swarm/Memory/Sessions/Metrics/Hooks 5 卡片（HTML 约 85 行）
  - .ruflo-* CSS 全部（约 95 行）
  - app.js 里 rufloState / showRufloArea / hideRufloArea / loadRufloAll / renderRufloXxx / rufloSwarmInit / rufloAgentSpawn / rufloHookRoute / Fmt helpers / btn 绑定（约 695 行）
  - server.js 里 import RufloBridge + 12 个 /api/ruflo/* 端点（约 87 行）
  - 整个 src/ruflo/ 目录（235 行）
- **影响评估**：
  - panel 的 5 大房功能（chat/debate/squad/arena）**完全不依赖 ruflo**
  - metrics / templates / webhooks / archive / plugin / report 模块**完全独立**
  - 顺手清掉相关 CSS 注释残留
- **总删除代码量**：约 1200 行
- **保留**：HANDOFF / BUGS 历史记录里的 ruflo 段落（作为版本演进史保留）
- **panel 仍能正常启动**（51737 端口跑通，rooms API 200，ruflo/health 404 确认删干净）

## v0.54 Sprint 8 — 顶栏拥挤 + Ruflo 面板反馈（2026-05-20 完成）

- **S8-V01** UX 修复：顶栏 10 个按钮（📊 💻 💬 🐝 🧩 ⚙️ 🔔 📂 🔐 🌓）一行挤不下，后面图标被切 → `.brand-actions` 加 `flex-wrap: wrap` 自动换行
- **S8-V02** UX 修复：「启动智能体」点了"没反应"——实际有反应但 CLI 启动 10-30s + toast 太快消失。改：
  - 立即显示 loading toast（30s）："🐝 启动智能体中（ruflo CLI 启动可能 10-30s）…"
  - 成功显示明确反馈："✓ 智能体 X 已 spawn — 看 Agents 总数应该 +1"
  - 失败改用 confirmModal（更明显）+ 列出常见 3 种原因（swarm 没 init / CLI 没装 / type 不合法）
- **S8-V03** 同样改 swarmInit 反馈
- **S8-N01** Ruflo 面板顶部加帮助横幅：解释"这是 claude-flow CLI 的可视化前端（独立于 panel 自己的 💬 多 AI 聊天室）" + 正常流程 + 常见问题 + 推荐替代方案

## v0.54 Sprint 7 — Enter 发送（2026-05-20 完成）

- **S7-V01** UX 修复：聊天框（chat 房 + session）按 Enter 没反应——之前只绑 ⌘+Enter，跟通用聊天软件不一致 → 改成 **Enter 发送 / Shift+Enter 换行**（IME 选字时不触发），placeholder 同步更新

## v0.54 Sprint 6 — squad 房 UX：升级文案 + 全失败诊断 + 单 task 重试（2026-05-20 完成）

- **S6-V01** UX 修复：「⚠️ 升级」翻译错（escalated 中文）→「⚠️ 已搁置（需人工）」+ 加 tooltip 解释 3 种触发
- **S6-V02** PM 总结增强：全部 escalated 场景（doneCnt=0 && escCnt>0）切换到「失败诊断 prompt」，输出可执行的下一步建议而不是空话总结
- **S6-N01** 新功能：CollaborationDispatcher.retryTask + `POST /api/rooms/:id/retry-task` 端点
- **S6-N02** 新功能：retryTask 自动 cascade reset 被牵连的下游（escalateReason 含 'blocked'）
- **S6-N03** 新功能：squad 卡片底部「🔄 重试此任务」按钮（房 running 时 disabled）
- **S6-N04** 新 WS：task_retry_start（含 cascadedCount）/ task_retry_error

## v0.54 Sprint 5.5 — forward 到 chat 注入结论 context（2026-05-20 完成）

- **S55-V01** Bug 修复：forward 到 chat 房只把 finalConsensus 塞到 `room.topic`，但 chat AI 拍平 messages 时只读 conversation 不读 topic → AI 完全看不到上轮结论 → 用户「基于结论追问」被当新问题 → 现在 seed user+assistant 两条到 conversation，AI 真能看到 context
- **S55-N01** UX：按钮文字「➡️ 转闲聊房」→「💬 基于此继续追问」+ 更明确 tooltip
- **S55-N02** UI：chat 房渲染识别 fromForward 加 📌 头像 + 橙色左边框 + badge「上轮结论 · 自动作为对话 context」
- **S55-N03** 安全：finalConsensus seed 时 cap 32KB 防 chat prompt 爆炸

## v0.54 Sprint 4.5 — 重试 UX + 聊天归档系统（2026-05-20 完成）

- **S45-V01** UX 修复：error turn 卡片重试按钮在房 running 时禁用 + 改文字「⏸ 等房暂停」（之前可点但后端拒，UX 差）
- **S45-N01** 新功能：ArchiveStore 模块（rootPath + 3 结构 + 时间格式 + autoArchive 配置）
- **S45-N02** 新功能：4 个归档 API（GET/PUT config + POST 手动归档 + GET list）+ ChatRoomStore.room.exportPath 房级覆盖
- **S45-N03** 新功能：顶栏 📂 配置 modal + 树状预览 + 已归档列表 + finalConsensus 区「📂 立即归档」按钮
- **S45-N04** 安全：isPathSafe 沙箱（home+tmp，禁 .ssh/.aws/.gnupg/.docker/.kube/Library/Keychains）+ 文件名 sanitize（中文保留，路径分隔符替换）

## v0.54 Sprint 4 — Webhook + HTTP plugin + CLI quick（2026-05-20 完成）

- **S4-N01** 新功能：Webhook 出站推送（discord/slack/json），监听 *_done/*_error/auto_paused 事件 → POST URL
- **S4-N02** 安全：webhook URL 必须 https://（除 localhost http），header injection 防御（拒 \\r\\n），URL 掩码（token/key/secret/sig query 参数 + 长 path 段）
- **S4-N03** 新功能：5 个 webhook 端点 + 顶栏 🔔 modal（CRUD + 测试推送）
- **S4-N04** 新功能：PluginHttpAdapter（manifest.type='http' 跑 fetch）+ schema 加 http 字段定义 + 条件校验
- **S4-N05** 安全：http plugin URL 协议限制 + body 64KB 上限 + 响应 1MB 上限 + timeout 1s-600s
- **S4-N06** 示例：jokeapi-http.json（公开免费 API 测试 GET + replyJsonPath）
- **S4-N07** 新功能：POST /api/rooms/quick CLI 一键起房（含 templateId + startNow + 自动 dispatcher.start）
- **S4-N08** 文档：docs/QUICK_API.md（3 个常用场景示例）
