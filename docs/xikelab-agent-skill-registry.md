# Xike Agent-Skill Registry

更新时间：2026-05-25

## 目的

这次落地的不是 Crow5 的表层角色名，而是它背后的架构原语：**Agent Profile、任务标签、Skill 绑定、Prompt 注入**。

Crow5 的优势是把多 Agent 从“聊天角色扮演”推进到“配置化协作系统”。Xike Lab 下一步要超越它的地方，是让调度依据更透明、可测试、可审计，而不是隐藏在模型自由发挥里。

## 当前实现

新增模块：

- `src/agents/AgentSkillRegistry.js`
- `src/agents/AgentPolicyStore.js`
- `src/agents/CodebaseMap.js`
- `src/agents/CodebaseIndexStore.js`
- `src/agents/CodebaseQueryEngine.js`
- `src/agents/CodeContextSignals.js`
- `src/agents/CodeContextEvidence.js`
- `src/agents/JavaScriptAstAnalyzer.js`
- `src/agents/SymbolGraph.js`
- `src/agents/AgentRunStore.js`
- `tests/unit/agent-skill-registry.test.js`
- `tests/unit/agent-policy-store.test.js`
- `tests/unit/agent-run-store.test.js`
- `tests/unit/codebase-index-store.test.js`
- `tests/unit/routes/codebase-index-routes.test.js`

接入点：

- `src/server/routes/agentRegistry.js`
- `src/server/routes/agentRuns.js`
- `src/server/routes/codebaseIndex.js`
- `src/room/skillInjector.js`
- `src/room/SoloChatDispatcher.js`
- `src/room/CollaborationDispatcher.js`
- `src/room/DebateDispatcher.js`
- `src/room/ArenaDispatcher.js`
- 顶栏 `🧠 Agent 图谱` 弹窗

## 能力边界

当前 registry 提供 8 个 Xike agent profile：

- `xike-chief`
- `xike-builder`
- `xike-verifier`
- `xike-architect`
- `xike-judge`
- `xike-shipper`
- `xike-designer`
- `xike-observer`

它会根据 room member 的 `role` 解析对应 profile，并根据任务文本匹配 dispatch tags，例如：

- `planning`
- `implementation`
- `verification`
- `architecture`
- `debugging`
- `release`
- `design`
- `governance`

匹配结果会被注入到 system prompt 的 `Xike Agent Runtime Context` 段中。已安装且启用的 bound skills 会自动进入本轮 skill 注入。

每个 profile 现在也有一组治理策略：

- `budgetTier`：预算等级，用于 UI 与策略解释。
- `budgetScope`：默认 `agent_profile`，让预算系统能按 profile 设限。
- `commandGuard`：危险命令守卫强度。
- `approvalPolicy`：需要人工确认的操作类别。
- `auditLevel`：审计详细程度。

## 可观察性

新增 owner-token 保护的只读 API：

- `GET /api/agent-registry`：返回 profiles、dispatch rules、已安装 skill 覆盖率和缺失绑定。
- `POST /api/agent-registry/classify`：输入任务文本和 member role，返回命中的 tag、profile、建议 skill、已安装 skill、缺失 skill 和 prompt preview。
- `GET /api/agent-registry/changed-files`：读取当前 git 变更并返回可用于分派的 code-context signals 与 source evidence。
- `GET /api/agent-registry/codebase-map`：扫描当前工程文本代码文件，按任务 query 选出 focus files，返回 evidence、signals 和轻量 import graph。
- `POST /api/codebase-index/rebuild`：按 cwd/query 重建本地 Codebase Index，返回 status 与 map。
- `GET /api/codebase-index/status`：返回最近一次索引状态、扫描数量、evidence / Symbol Graph 摘要和限制信息。
- `POST /api/codebase-index/query`：返回可解释查询结果，包含 `path`、`line`、`score`、`reason`、`anchor`、`parser`、`symbols` 和 `routes`。

前端顶栏新增 `🧠` 入口，可以直接查看 Agent 图谱并做分派预演。这个入口的价值不是“多一个设置页”，而是把多 Agent 调度从黑箱变成可检查的本地治理对象。

Agent Center 已拆成 4 个最小工作 tab：

- `Profiles`：查看 Agent Profile、角色、治理条和 Skill 覆盖。
- `Dispatch`：查看 Dispatch Rules，并运行现有 Dispatch Preview / 当前变更 / 工程地图预演。
- `Runs`：按 status、roomId、agentProfileId 查询最近 Agent Runs，查看 status、room/session/task、profile、token/cost/latency、diagnostics、messages、tool results 和相关 Activity。
- `Policies`：集中编辑 profile governance，保留本地覆盖和重置能力。

Runs tab 会直接消费 `/api/agent-runs`、`/api/agent-runs/:id` 和 `/api/agent-runs/:id/export?format=json`。如果 run 关联了 approval 或 delegation，详情区会提供跳转到审批中心、委派中心和 Activity 时间线的入口。

Codebase Center 已提供单独的顶栏入口 `⌘`：

- 展示当前项目 cwd、索引状态、扫描文件数、focus 文件数、symbols 与 route usage 摘要。
- 支持 `Rebuild` 和 `Query`，直接调用 `/api/codebase-index/rebuild` 与 `/api/codebase-index/query`。
- 查询结果以卡片展示 `path:line`、score、parser、kind、anchor、reason、snippet、symbols/routes。
- 每条结果或全部结果都可以“添加到 Dispatch Preview”：它会把路径写入 `agentRegistryState.affectedFiles`，把 symbols/routes/snippet 转成最小 `codeContextEvidence`，并把查询文本同步到 Dispatch Preview 的任务文本。
- `打开 Dispatch Preview` 会直接跳到 Agent Center 的 `Dispatch` tab，便于把代码证据纳入分派预演。

这个 UI 仍然是本地索引面板，不做 AI 总结、不上传代码、不依赖云索引。

房间成员栏也新增了 Agent Profile 绑定下拉。默认值 `auto profile` 会继续按成员 role 匹配；如果手动选择 `xike-verifier`、`xike-architect` 等 profile，则运行时 prompt、Skill 注入、metrics 和预算归因都会使用这个显式绑定。

房间级 Skill 绑定也接入了 UI：成员区会列出当前已安装且启用的 Skills，勾选后保存到 `room.skills`。后端会拒绝未安装或已禁用的 skill 名称，避免把不可用配置写进房间。运行时最终注入的 skill 集合来自 profile 绑定、dispatch tag 和 room-level skills 的合并结果。

Skill 注入现在会保留来源解释：同一个 skill 可能同时来自 `profile`、`dispatch:<tag>` 和 `room`。Dispatch Preview 和运行时 prompt 都会展示这些来源，例如 `qa [profile+dispatch:verification+room]`，这样可以看清某个 Skill 是角色默认带来的、任务标签命中的，还是用户在房间里手动授权的。

同时新增了 Skill 诊断：如果本轮安装的 skill 过多、skill prompt 总体量过大，或 skill frontmatter 通过 `conflictsWith` / `exclusiveGroup` 显式声明冲突，Dispatch Preview 和运行时 prompt 会给出 warning。这是为了避免“Skill 越多越好”的误用，让 Xike Lab 在吸收 Crow5 的 Skill 绑定能力时保留本地治理刹车。

诊断也会随 `metrics.recorded` 写入审计详情；当诊断非空时额外写入 `agent.skill_diagnostics` 活动事件，包含 room/session/task、agent profile、dispatch tags、skill bindings 和 diagnostics。这样超量注入、冲突提示可以在 Activity 时间线按房间或任务追溯。

Activity 时间线现在也能直接按 Agent/Skill 维度筛选：

- `agentOnly`：只看包含 Agent Profile、Skill 或诊断详情的事件。
- `agentProfileId`：追溯某个 profile 触发的 metrics / diagnostics。
- `skillName`：追溯某个 Skill 在哪些房间、任务里被注入。
- `diagnosticCode`：定位 `too_many_skills`、`skill_prompt_too_large`、`exclusive_skill_group_conflict` 等诊断。

前端 Activity Center 增加了 `Agent/Skill`、`诊断`、`Metrics` 快捷筛选，并把诊断项从原始 JSON 中提炼为紧凑摘要，避免治理线索只能靠复制 JSON 搜索。

## 工程上下文分派

Agent 分派现在不再只看用户输入的任务文本。`src/agents/CodeContextSignals.js` 增加了一个轻量、可替换的 code-context signal 层，会从受影响文件路径、扩展名和已知工程区域推导 dispatch tag：

- `tests/**`、`*.test.js`、Playwright / Vitest 文件会增强 `verification`。
- `public/**`、CSS、HTML、UI 相关路径会增强 `design` 和 `implementation`。
- `src/agents/**`、`src/room/**`、dispatcher / skill injector 会增强 `architecture`。
- route/server 文件会增强 `implementation` 与 `architecture`。
- budget / approval / audit / governance / delegation / policy 相关路径会增强 `governance`。
- release / deploy / package / workflow 文件会增强 `release`。

`src/agents/CodeContextEvidence.js` 在 signals 之上增加了 source evidence 层：对当前变更文件做安全读取，提取 JS/TS 的 function/class/const symbols、imports、Express-style API routes、Vitest/Playwright test anchors，以及 HTML id、CSS selector、Markdown heading。JS 文件现在优先通过 `src/agents/JavaScriptAstAnalyzer.js` 使用 Acorn 解析 AST，记录 parser、diagnostics 和 identifier/call references；解析失败、TypeScript/JSX 或其他文本语言会回到现有 regex/selector/heading fallback。这样 evidence 已经从“路径 + 正则启发”推进到“AST 优先、可降级”的确定性接口。

`src/agents/CodebaseMap.js` 则把 evidence 从“当前变更”扩展到“当前工程”：扫描有限数量的文本代码文件，避开 `node_modules`、`.git`、`public/vendor`、构建产物等目录，按任务 query、路径优先级和源码 landmark 选出 focus files，再基于 imports 构建轻量依赖边。这个阶段仍然是 POC，但已经形成了 Crow5 codesearch 思路的可解释最小闭环：

```text
task text
  -> query tokens
  -> project file scan
  -> focus file ranking
  -> source evidence extraction
  -> import graph
  -> Agent dispatch preview / prompt evidence
```

P0 Codebase Index 二期后端已在这个 POC 上收口为可查询接口：

- `CodebaseIndexStore` 负责 rebuild / status / query 的本地缓存闭环。
- `CodebaseQueryEngine` 负责 query token 扩展、中文治理问题映射、源码优先排序、symbol / anchor / snippet / reference 打分。
- 查询会把“预算、诊断、委派自启动、Agent 图谱入口、SymbolGraph route 关联”等中文问题扩展到实际源码 token，例如 `budget/preflight/incident`、`agent.skill_diagnostics/recordSafe`、`btnAgentRegistry/openAgentRegistryModal/addEventListener`、`routeUsages`。
- 扫描限制仍然保留：跳过 `.git`、`node_modules`、构建产物、`public/vendor`、二进制和超大文件；当前上限允许覆盖本项目 393KB 的 `public/app.js`，但继续拒绝更大的非必要文件。
- 返回结果不是 AI 摘要，而是可复查证据：源码路径、行号、命中理由、parser 来源、anchor、关联 symbols/routes。测试文件可以作为补充证据，但默认不压过实现文件。

`src/agents/SymbolGraph.js` 在 Codebase Map 之上补了 definition/reference/call-site 关系层：从 evidence symbols 建立定义表，再优先消费 AST references，按“同文件定义优先、显式 import 目标次之、唯一全局定义兜底”的规则连线；非 AST 文件仍使用 regex fallback。同时它会把 `/api/...` route anchors 与前端 fetch/API 字符串关联起来。它仍然不是完整 LSP，因此不能处理动态属性访问、复杂重导出、类型级引用和跨语言符号，但它已经让 Agent 在执行前看到：

- 哪些定义在 focus files 中被引用或调用。
- API route 在哪里定义、哪里被使用。
- 哪些符号是高连接度入口点。

这比 Crow5 当前可见 UI 更进一步：Crow5 能展示文件变化和 codesearch 能力，但 Xike Lab 在预演阶段直接展示“为什么这些文件和符号会进入 Agent 上下文”。

这一步不是冒充完整 AST 索引，而是先把 Crow5 “codesearch + Agent dispatch” 的核心思想落成确定性接口：`classifyTask(text, { codeContext })` 能同时返回文本命中和代码上下文命中。Dispatch Preview 已增加“当前变更”按钮和“受影响文件”输入框，按钮会读取本地 git status，自动填充当前变更路径，并展示：

- `Code Context`：dispatch tag、score、触发理由和路径。
- `Codebase Map`：扫描文件数、focus files、轻量 import edges。
- `Symbol Graph`：definitions、references、calls、route uses。
- `Code Evidence`：文件级 symbols、anchors、imports、AST references 和 parser 来源。
- Prompt preview 中的 `Code evidence` / `Symbol graph` 行：让真实 Agent 在执行前看到关键符号、入口点和调用关系。

接口会关闭 Git 的 quotePath 转义，并兜底解码 C-style quoted path，避免中文项目文件名变成 `\344...` 形式。后续接入 Tree-sitter/LSP/VectorIndex 时，只需要替换或增强 evidence/signal 生成层，上层 Agent Profile、Skill 绑定、治理、审计都可以继续复用。

当前 Codebase Index 后端验收的 5 个真实问题已经能返回实现文件、行号和命中原因：

- `RoomAdapter 在哪里处理预算？` -> `src/room/RoomAdapter.js` 的 budget preflight / incident 处理。
- `Agent Skill 诊断哪里写入 Activity？` -> `src/metrics/MetricsStore.js` 与 `src/audit/ActivityLog.js`。
- `Delegation autostart 链路？` -> `src/autopilot/DelegationAutostart.js`。
- `Agent 图谱入口 DOM handler？` -> `public/app.js` 中 `btnAgentRegistry` / `openAgentRegistryModal` handler。
- `SymbolGraph 如何关联 route？` -> `src/agents/SymbolGraph.js` 的 route usage 聚合逻辑。

## 本地策略编辑

Agent 图谱现在可以直接编辑每个 profile 的治理策略。保存后写入本机 owner-token 保护的文件：

```text
~/.claude-panel/agent-policies.json
```

新增 owner-token 保护的写 API：

- `PUT /api/agent-registry/profiles/:id/governance`：保存指定 profile 的本地治理覆盖。
- `DELETE /api/agent-registry/profiles/:id/governance`：删除本地覆盖，回到内置默认策略。

策略文件只覆盖治理字段，不改 profile 的 mission、boundaries、skill 绑定或 dispatch rules。运行时通过 `effectiveAgentRegistry()` 合并默认 registry 与本地覆盖，因此 Dispatch Preview 和真实房间模型调用看到的是同一套有效策略。

## 运行时治理

模型调用路径已接入 profile 维度：

- `RoomAdapter` budget preflight 会读取 `agentProfileId`，因此可以为 `agent_profile:xike-verifier`、`agent_profile:xike-shipper` 等单独配置 calls/tokens/usd 限额。
- `MetricsStore.record()` 会把 `agentProfileId`、`agentDispatchTags`、`agentSkillNames`、`agentGovernance`、`agentCodeContextSignals` 和 `agentCodeContextEvidence` 写入 metrics 与 `metrics.recorded` 审计事件详情。
- `BudgetPolicyStore.recordMetric()` 会把同样的 agent 字段写入 budget usage payload，预算 incident 也能追溯是哪类 agent 触发。
- `AgentRunStore.recordMetricTurn()` 会把真实 metrics turn 映射为 `agent_runs` + `agent_messages`，保留 room/session/task、profile、adapter、model、skills、dispatch tags、治理策略、token/cost/latency 摘要。
- `AgentRunLifecycle` 已接入 `RoomAdapter.chat()`：adapter 调用开始时创建 running run；预算 hard stop 转 `deferred` 并记录 `deferReason=budget_blocked`；成功转 `succeeded`；失败转 `failed`；abort/cancel 转 `cancelled`。adapter result/error 会携带 `agentRunId`，metrics 复用同一个 run 追加 metric message，避免生命周期 run 与 metrics run 分裂。
- `POST /api/delegations/:id/autostart` 会同步创建 `delegation_autostart` 来源的 queued agent run，把审批 ID、Autopilot job ID 和目标模式写入 run details，便于后续从委派中心追溯到 Agent Run。
- 治理链路现在共用同一个 `agentRunId`：budget usage / incident、approval payload、delegation payload、Autopilot job payload、`delegation.autostart` Activity 都会写入 run 线索；Autostart handler 在 `approval_pending`、`budget_blocked`、成功创建/启动目标房时会推进同一个 run。
- Agent Run 现在保留 `deferReason`、`approvalId`、`budgetIncidentId`、`delegationId` 和 `relatedActivityIds`，每次 run 创建、状态迁移、message 追加、tool result 记录都会写入 `agent_run` 审计事件，方便后续从 Activity 反查 run。

新增 owner-token 保护的 Agent Run API：

- `GET /api/agent-runs`：按 room/session/task/profile/status/source/approval/delegation 查询 run。
- `GET /api/agent-runs/:id`：返回 run timeline，包括 messages 和 tool results。
- `GET /api/agent-runs/:id/export?format=json|markdown`：导出 run metadata、dispatch、governance、details、messages、tool results，以及 approval/delegation/autopilot/budget 等相关 Activity。
- `POST /api/agent-runs`：创建一个可追踪 run。
- `POST /api/agent-runs/:id/messages`：追加 message / decision / metric / summary。
- `POST /api/agent-runs/:id/tool-results`：追加工具执行摘要、审批 ID 与成本。
- `POST /api/agent-runs/:id/transition`：推进 queued/running/succeeded/failed/cancelled/deferred 状态。

这比 Crow5 当前可见形态更进一步：不仅能看到 Agent 和 Skill，还能把它们纳入本地预算、审批和审计系统。

## 权限治理

`src/permissions/PermissionGovernance.js` 已新增统一判定入口：

```js
evaluatePermission({ actorType, agentRunId, roomId, action, target, cwd, risk })
```

返回值是确定性的 `allow` / `ask` / `deny`，并带有 `reason`、`approvalPayload`、`approval` 和 `ToolInvocationRecord`。`ask` 会创建 `manual` approval；每次判定都会写入 `permission.decision` Activity；如果调用方提供 `agentRunId`，同一条判定会追加到 Agent Run timeline 的 `decision` message。

当前已覆盖的动作：

- `shell.exec`：复用 DangerousPatternDetector，高危/关键命令转审批。
- `file.write` / `file.delete`：外部目录和敏感文件写删转审批。
- `external_directory.access`：外部目录访问转审批，`.ssh/.aws/.gnupg/.docker/.kube` 拒绝，`.env*` 读取转审批。
- `skill.plugin.execute` / `skill.plugin.configure`：plugin 与 MCP 执行/配置转审批。
- `provider.model_config.write` / `provider.model_config.access`：模型/provider 配置写入或测试访问转审批。
- `network.upload`：公网 webhook 上传转审批，localhost/私网/非 http(s) 直接拒绝。
- `auto_accept.scope`：仅低风险范围自动允许，中高风险转审批。

接入点包括 Claude tool_use、plugin install/delete/reload/exec、MCP create/update/delete/test/list tools/resources/prompts、Room Adapter/Watcher 配置、Watcher test、Webhook create/update/test、报告 outputPath 写入。HTTP 入口统一返回 `202 approval_required` 或 `403 permission_denied`，避免审批前落盘、联网或拉起子进程。

## 相对 Crow5 的改进点

Crow5 的 Agent/Skill 绑定很强，但用户很难看清某次调度到底为什么发生。Xike Lab 的这个版本先把调度做成确定性、可测试的函数：

```js
const matches = classifyTask('重构架构并跑浏览器测试验证预算治理');
```

后续 UI 可以直接展示：

- 命中的 tag
- 对应 agent profile
- 本轮注入的 skill
- 没有安装但建议补齐的 skill
- 这次 agent 的边界条件

这会让 Xike Lab 的多 Agent 系统更适合本地治理、审计和长期学习。

## 下一步

1. 在 Acorn AST 层之上继续接入 Tree-sitter / LSP / VectorIndex，让 code-context evidence 和 Symbol Graph 覆盖 TypeScript、JSX、复杂重导出、跨文件类型引用和语义片段。
2. 给 Agent 图谱增加“本轮实际注入上下文”快照，直接关联 room/session/turn。
3. 把 Activity 中的 Agent/Skill 追溯结果反向链接到 Agent 图谱 profile 和房间运行记录。
