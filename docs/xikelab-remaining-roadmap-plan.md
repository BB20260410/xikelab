# Xike Lab 未完成方向详细实施计划

更新时间：2026-05-26 CST
适用分支：`codex/paperclip-local-governance`
状态基线：P3 稳定化已完成（增量固化为提交，工作树 clean）；P0-A 第一刀 / P0-B / P0-C / P1 产品主路径 / P1 Model-Skill Center 收口 / P2 三类入口闭环（webhook / room-adapter / MCP）均已完成。本文件只规划**尚未完成**的方向。

## 阅读方式与通用约束

- 本文件是操作级执行手册：每个方向给出「现状事实 → 目标 → 分步操作（改哪个文件、加什么、关键实现点、怎么测）→ 验收标准 → 风险与边界 → 工作量」。
- 每一「刀」（最小可交付单元）必须独立走完：实现 → 定向单测 → `npm run lint` → `npm test` → `git diff --check` →（含 UI 则）`npm run test:e2e` → 逐文件显式 stage 提交。
- 红线（全程不可破）：不删除预算/审批/审计/委派/Autopilot/Agent Run/Codebase Index/Agent-Skill Registry；不改 SaaS / 多租户；不做 Crow5 授权/付费/DRM 绕过；不 `git add .` / `git reset --hard` / 大范围 `checkout`；审批批准 ≠ 自动重放危险 shell。
- 提交标题用中文动作式：`模块: 动作 + 目的`。

## 优先级总览

| 序 | 方向 | 价值 | 依赖 | 规模 | 建议次序 |
|----|------|------|------|------|----------|
| 1 | P2 收尾（watcher 链式批准 + MCP test/delete） | 高 | 无（机制已就位） | 2 刀 | 最先，关闭 P2 |
| 2 | P0-A Tree-sitter/LSP 级证据深化 | 高 | 无 | 4-5 刀 | P0 主线 |
| 3 | P9 安全审计 | 高 | 无 | 3 刀 | 可与 P0-A 并行（独立文件） |
| 4 | P5 治理工作队列 | 中高 | 无 | 3 刀 | — |
| 5 | P4 本地证据知识库 | 中高 | 复用 P0-A 的 FTS 模式更佳 | 3-4 刀 | P0-A 后 |
| 6 | P1 Model/Skill Center 深化 | 中 | 无 | 2-3 刀 | — |
| 7 | P6 性能与资源控制 | 中 | 无 | 2 刀 | 稳定化期 |
| 8 | P8 发布准备 | 中 | P9 完成更稳 | 3 刀 | 收尾期 |
| 9 | P7 i18n / accessibility | 中低 | 无（量大） | 4+ 刀 | 最后 |

---

## 方向 1：P2 收尾 — Watcher 链式批准 + MCP test/delete

### 现状
- P2 通用机制已落地于 `public/app.js`：`requestWithApproval`（识别 202 `approval_required` / 403 `permission_denied`）、`approveAndRetryRequest`（批准后带 `approvalId` 走 `X-Panel-Approval-Id` header 重发原请求）、`openApprovalRetryModal`（摘要 + 批准并重试）。已接入 webhook / room-adapter / MCP create。
- 阻塞点：`src/server/routes/watcher.js` 的 `PUT /api/watcher/config` 是**双重审批**——先 `provider.model_config.write`（行 87-103），再 `auto_accept.scope`（行 111-126）。单次「批准并重试」只能解决第一个 approval，重试时第二个仍返回 202，当前 `onApproveRetry` 收到 `approval_required` 只会 toast「审批仍未生效」并卡住。

### 目标
让通用机制支持「链式批准」：重试后若再遇 `approval_required`，自动对下一个 approval 再弹一次审批弹窗，依次批准直到 `ok` 或被拒。然后接入 watcher config 与 MCP test/delete。

### 任务分解

**刀 1 — 通用机制支持链式批准 + 接入 watcher config**
1. 改 `public/app.js` `openApprovalRetryModal`：把「批准并重试」的成功语义从布尔改为可链式——`onApproveRetry` 返回 `{ done: boolean, next?: {approvalId, approval, permissionDecision} }`。当 retry 结果是 `approval_required` 时，关闭当前弹窗并用 `next` 再次 `openApprovalRetryModal`（递归），弹窗标题追加「(第 N 步审批)」。
2. 抽出一个 `runApprovalChain(firstResult, path, opts, { actionLabel, onFinalOk })` helper：内部循环——弹窗 → 批准 → 重试 → 若仍 `approval_required` 则用新 result 再弹，直到 `ok`/`denied`/`error`。webhook/room-adapter/MCP 的调用点改为调用 `runApprovalChain`（单 approval 场景行为不变，只是循环一次）。
3. 改 `public/app.js` `#btnWatcherSave` handler（约行 1881）：从 `api()` 改为 `requestWithApproval` + `runApprovalChain`，`actionLabel:'写入监视者 Provider 配置'`。保留原成功 toast（`监视者配置已保存`）。
4. 测试：e2e 新增「Watcher config 双重审批链式重试」——打开 watcher 设置，改 provider + 打开 autoMode（同时触发两个审批），保存 → 弹第 1 审批 → 批准并重试 → 弹第 2 审批 → 批准并重试 → 成功。注意 watcher 保存会重建 adapter，e2e 用无 apiKey 或假 provider 避免真实连接。
5. 验收：e2e 链式两步审批通过；单 approval 入口（webhook/mcp/adapter）回归不变（132 个断言仍过）。

**刀 2 — MCP test/delete 接入**
1. 改 `public/app.js` `testMcp`（约行 7107）：被 `approval_required`（`skill.plugin.execute`）拦截时走 `openApprovalRetryModal`/`runApprovalChain`；批准后重试，成功后照常渲染 tools 区。注意 test 会 spawn 子进程，**e2e 不覆盖批准后的真实执行**，只在单测/手动验证。
2. 改 MCP delete 调用点（裸 fetch `DELETE /api/mcp/servers/:name`，约行 7000+）：同样接入。delete 是配置删除（非 shell），批准后重试安全。
3. 测试：定向单测 `tests/unit/routes/mcp-routes.test.js`（若无则建）覆盖 test/delete 在带已 approved approvalId（header）时放行、未批准时 202。e2e 仅覆盖 delete 的审批弹窗出现（不点批准，避免误删依赖）。
4. 验收：lint/test/e2e 全过；MCP test/delete 被审批拦截时有重试入口。

### 涉及文件
`public/app.js`、`public/style.css`（如弹窗步骤指示）、`tests/e2e/panel-ui-walkthrough.mjs`、`tests/unit/routes/mcp-routes.test.js`（可选新建）。

### 风险与边界
- watcher 保存的 adapter 重建副作用：e2e 必须用不触发真实 provider 连接的配置。
- 链式批准要防死循环：设最大链长（如 5），超过则提示用户去 Approval Center 手动处理。
- 不改后端审批语义，只改前端交互。

### 工作量：2 刀。

---

## 方向 2：P0-A — Codebase Index Tree-sitter/LSP 级证据深化

### 现状
- `src/agents/JavaScriptAstAnalyzer.js` 用 `@babel/parser` 覆盖 JS/TS/TSX/JSX，已产出 `type-import/reference/extends/implements/constraint/assertion/satisfies/instantiation`、`member-call/reference`、`dynamic-import`。
- `src/agents/SymbolGraph.js` 已有 import/export 绑定、`routeTestChains`、`unresolvedReferences`、`type-implementation`。
- `src/agents/CodebaseCitationChain.js` 已把 route-to-test 串成 citation path；`CodebaseQuestionAnswer.js` 已输出 coverage/limitations。
- 缺：统一的 parser adapter 抽象（便于将来换 Tree-sitter 或加语言）；更细引用类型（object property flow、callback registration、route handler binding、test assertion target）；跨文件/跨语言引用；更强的「证据不足」约束。

### 目标
在不引入云索引、不调模型、不上传代码的前提下，提升代码证据准确性，尤其跨文件引用与类型/调用关系，并把 citation path 做成人类可读链条。

### 任务分解

**刀 1 — Parser adapter 抽象层**
1. 新建 `src/agents/parsers/ParserAdapter.js`：定义接口 `{ supports(ext), parse(code, filePath) -> { parser, diagnostics, symbols, imports, exports, anchors, references } }`。
2. 把现有 `JavaScriptAstAnalyzer` 包装为 `BabelParserAdapter`（实现该接口），保持现有输出字段不变。
3. 新建 `ParserRegistry`：按扩展名选 adapter，fallback 到现有正则 evidence。`CodeContextEvidence` 改为经 registry 取 adapter，不再直接依赖 babel analyzer。
4. 测试：现有 `tests/unit/javascript-ast-analyzer.test.js` 全过（重构不改行为）；新增 `tests/unit/parser-registry.test.js` 覆盖按扩展名分发与 fallback。
5. 验收：纯重构，全量测试不变；为后续接 Tree-sitter 留接口。

**刀 2 — 细化引用类型（object property flow / callback registration）**
1. 在 `BabelParserAdapter` 增加：`object-property-flow`（`obj.x = fn` / `{ handler: fn }` 形态）、`callback-registration`（`emitter.on('e', fn)` / `app.use(fn)` / `addEventListener` 形态）的 reference 抽取。
2. `CodeContextEvidence` sanitize 保留新字段；`SymbolGraph` 把这些 reference 纳入 definitions/references 关联。
3. 测试：`tests/unit/javascript-ast-analyzer.test.js`、`tests/unit/symbol-graph.test.js` 新增样例断言（含 express route handler 注册）。
4. 验收：新引用类型可被 query 命中并出现在 citation。

**刀 3 — route handler binding + test assertion target 链路**
1. `SymbolGraph` 增强 `routeTestChains`：把 `API route 定义 → handler 函数 → handler 内调用的 service 方法 → 测试文件中对该 route/service 的断言` 串成显式有序链。
2. `CodebaseCitationChain` 输出可读 citation path 字符串，如 `POST /api/x -> createX() -> XStore.create() -> x-routes.test.js#assert`。
3. 测试：`tests/unit/symbol-graph.test.js`、`tests/unit/codebase-index-store.test.js` 覆盖完整链。
4. 验收：query/question 结果能展示该可读链。

**刀 4 — CodebaseQuestionAnswer 证据不足约束强化**
1. `CodebaseQuestionAnswer.js`：当命中证据低于阈值（无 symbol 级命中、仅关键词命中、unresolved 比例高）时，`limitations` 明确输出「证据不足，未做推断」，`answerLines` 不得超出 citation 覆盖范围。
2. 前端 `public/app.js` Codebase Center 的 Local Code Answer 区显示该限制。
3. 测试：单测构造「弱证据」query 断言 limitations；e2e 断言 UI 显示限制说明。
4. 验收：弱证据不产生黑盒总结。

**刀 5（可选）— 前端 summary 增强**
1. Codebase Center 展示新增计数：object-property-flow / callback-registration / route-handler-binding chain 数。
2. e2e 覆盖。

### 涉及文件
`src/agents/parsers/*`（新）、`JavaScriptAstAnalyzer.js`、`CodeContextEvidence.js`、`SymbolGraph.js`、`CodebaseCitationChain.js`、`CodebaseQuestionAnswer.js`、`CodebaseQueryEngine.js`、`public/app.js`、对应单测 + e2e。

### 风险与边界
- 不一次性接所有语言；先 JS/TS。引入真正的 Tree-sitter（native/wasm）前先用 adapter 接口隔离，避免 native 依赖与 better-sqlite3 类似的 Node 版本编译问题。
- 不上传代码、不调模型。

### 工作量：4-5 刀（刀 1 重构后其余可独立）。

---

## 方向 3：P9 — 安全审计

### 现状（调研事实）
- 路径越界：`PermissionGovernance.js:42-47` 用 `pathInside`（仅 resolve 后前缀比较，**不验 realpath，symlink 可能绕过**）；`AgentRunStore.readArtifact`（约 2613-2649）三层校验较强；`img-cache.js:26-87` 有 `isPrivateIp`/`assertPublicUrl`（SSRF 防护，IPv6 v4-mapped edge case 未充分测试）。
- owner-token 保护 27 个写路由（owner-token.js timing-safe）。
- network.upload 仅拒私网/loopback，**无 domain allowlist**。
- 潜在 approval bypass：`readArtifact` 依赖 `artifact.downloadable` flag。

### 目标
关闭已知路径越界 / SSRF / approval bypass 风险，补齐安全单测，不削弱现有功能。

### 任务分解

**刀 1 — 路径越界加固（realpath 校验）**
1. 在 `pathInside`（PermissionGovernance.js）与 `AgentRunStore` artifact 解析处，增加 `fs.realpathSync` 解析后再做前缀校验（symlink 指向外部则拒）。对不存在的目标路径，校验其已存在父目录的 realpath。
2. `AgentRunVerificationExecutor` 的 `validateFileChange` 同样用 realpath 校验 safe-root。
3. 测试：`tests/unit/permission-governance.test.js`、`tests/unit/agent-run-verification-executor.test.js` 新增「symlink 指向外部被拒」用例（建临时 symlink）。
4. 验收：symlink 绕过被堵；项目内正常路径不受影响。

**刀 2 — SSRF 加固 + 可选 domain allowlist**
1. `img-cache.js` `isPrivateIp`：补 IPv6 v4-mapped（`::ffff:a.b.c.d`）、`0.0.0.0/8`、链路本地 `169.254`、`fc00::/7`、`fe80::/10` 等用例与判断。
2. 为 network.upload 增加**可选** domain allowlist：读 `~/.claude-panel/upload-allowlist.json`（用户可空=放行任意公网，配置后只放行列表内 host）。在 webhook/网络上传路径校验。默认行为不变（向后兼容）。
3. 测试：`tests/unit/`（img-cache 相关或新建）覆盖各私网格式拒绝、allowlist 命中/未命中。
4. 验收：SSRF edge case 被堵；allowlist 可选生效。

**刀 3 — approval bypass 与 artifact downloadable 审查 + 审计单测**
1. 审查 `archiveArtifactId` / `downloadable` flag 来源：确保只有「已记录且 sha256 校验通过且在 allowlist 目录」的 artifact 才 downloadable，flag 不可被请求方注入。
2. 增加单测：构造伪造 downloadable flag / 越界 path / sha256 mismatch，断言 `readArtifact` 拒绝。
3. 汇总产出 `SECURITY_AUDIT.md`（本地文档）：列出已审查项、修复项、残留已知限制。
4. 验收：审计项全部有单测覆盖。

### 涉及文件
`src/permissions/PermissionGovernance.js`、`src/agents/AgentRunStore.js`、`src/agents/AgentRunVerificationExecutor.js`、`src/server/routes/img-cache.js`、`src/server/routes/webhook.js`、对应单测、`SECURITY_AUDIT.md`（新）。

### 风险与边界
- realpath 校验对「路径不存在」要兜底（用父目录），否则正常创建文件会误拒。
- domain allowlist 默认空=放行，避免破坏现有 webhook 用户。

### 工作量：3 刀。可与 P0-A 并行（文件几乎不重叠）。

---

## 方向 4：P5 — Governance 治理工作队列

### 现状（调研事实）
- `governance.js` `/api/governance/summary`（约 184-280）已返回 `counts/blockers/nextActions/sections`，`nextActions` 已有 8 类待处理动作分类，但**无状态转移**（批准→待验证→待归档→已处理 的工作流未落库）。
- 前端 `public/app.js:5645-5943` Governance Center 是只读聚合看板 + Next Actions + Open Items。

### 目标
把「聚合看板」升级为「工作队列」：每个待办项有明确状态（待审批 / 待验证 / 待归档 / 待修复 / 已处理），可在 UI 标记推进，状态落本地 SQLite，可追溯。

### 任务分解

**刀 1 — 队列数据模型与后端**
1. `src/storage/SqliteStore.js` 新增表 `governance_queue_items`（`id PK, source_kind(approval|budget|delegation|autopilot|agent_run), source_id, queue_state(pending_review|pending_verify|pending_archive|pending_fix|done), assigned_note, created_at, updated_at, dedupe_key U`）。
2. 新建 `src/governance/GovernanceQueueStore.js`：upsert（从 summary 的 blockers/nextActions 派生队列项，dedupe）、`setState(id, state, note)`、`list({state})`。
3. `governance.js` 新增 `GET /api/governance/queue`（按 state 分组）与 `POST /api/governance/queue/:id/state`（状态转移，owner-token 保护）。
4. 测试：`tests/unit/governance-queue-store.test.js` + `tests/unit/routes/governance-routes.test.js` 覆盖派生/状态转移/dedupe。

**刀 2 — 前端工作队列 UI**
1. Governance Center 新增「工作队列」tab：四列看板（待审批/待验证/待归档/待修复）+ 已处理折叠区。每项显示来源、标题、严重度、操作按钮（标记下一态 / 跳转源模块）。
2. 复用 P2 的审批后重试机制处理「待审批」项。
3. 测试：e2e 覆盖队列展示、状态转移一项、跳转源模块。

**刀 3 — 状态联动**
1. 当源对象状态变化（审批通过、预算解决、run 归档）时自动推进队列项状态或标 done（在对应 store 的状态迁移处回调 GovernanceQueueStore）。
2. 测试：单测覆盖联动。

### 涉及文件
`src/storage/SqliteStore.js`、`src/governance/GovernanceQueueStore.js`（新）、`src/server/routes/governance.js`、`public/app.js`、`public/style.css`、对应单测 + e2e。

### 风险与边界
- 不重复造审批/预算的真相源——队列项是它们的「视图 + 处理状态」，真相仍在各 store。
- dedupe 防止 summary 重复派生。

### 工作量：3 刀。

---

## 方向 5：P4 — 本地证据知识库

### 现状（调研事实）
- 18 张表（`SqliteStore.js`），`~/.claude-panel/panel.db`，WAL，0o600。`events` 表是通用流式事件；`embeddings` 表预留空 BLOB（向量未实装）。
- 证据分散在 `agent_runs/messages/tool_results`、`codebase_index_snapshots`、`activity events`、archive artifact 文件。**无统一「搜索历史证据」入口**。FTS 仅用于 `CodebaseFtsIndex`（内存 SQLite FTS5，2500 行上限）。

### 目标
建本地证据知识库：跨 Agent Run / 工具结果 / 归档 / Activity / Codebase 问答 的统一本地全文检索，只读、本地 SQLite，不做云同步。

### 任务分解

**刀 1 — 证据索引存储**
1. 新建 `src/knowledge/EvidenceKnowledgeStore.js`：在 `panel.db` 建 FTS5 虚表 `evidence_fts`（`content, kind, ref_kind, ref_id, room_id, session_id, created_at` + content rowid 映射表）。复用 `CodebaseFtsIndex` 的 FTS5/bm25 用法模式。
2. 索引来源：run summary/decision message、tool_result output_summary、archive summary、activity 关键事件、codebase question answer。提供 `indexRun(runId)` / `reindexRecent(limit)` 增量接口（按 updated_at 增量，避免全量重建）。
3. 测试：`tests/unit/evidence-knowledge-store.test.js` 覆盖索引 + bm25 查询 + 增量。

**刀 2 — 检索 API**
1. 新建 `src/server/routes/knowledge.js`：`GET /api/knowledge/search?q=&kind=&limit=`（owner-token 保护），返回 `{ hits: [{kind, refKind, refId, snippet, score, createdAt, openTarget}] }`，`openTarget` 指向对应 Run/Activity/Archive 以便前端跳转。
2. `server.js` 注册路由。
3. 测试：`tests/unit/routes/knowledge-routes.test.js`。

**刀 3 — 知识库 UI**
1. 新增 Knowledge Center（顶栏入口或并入 Codebase Center 一个 tab）：搜索框 + 结果列表（kind 徽章、snippet、跳转按钮）。复用现有 Run/Activity detail 打开逻辑。
2. 测试：e2e 覆盖搜索 + 跳转。

**刀 4（可选）— 增量索引钩子**
1. 在 run 归档 / activity 写入时触发 `EvidenceKnowledgeStore` 增量索引（避免每次全量）。

### 涉及文件
`src/knowledge/EvidenceKnowledgeStore.js`（新）、`src/server/routes/knowledge.js`（新）、`src/storage/SqliteStore.js`、`server.js`、`public/app.js`、对应单测 + e2e。

### 风险与边界
- 只索引摘要/输出文本，不索引敏感原文（apiKey/密钥不入库）；索引前 sanitize。
- 不做云同步、不做向量（向量留 P4 后续或复用 embeddings 表）。

### 工作量：3-4 刀。

---

## 方向 6：P1 — Model / Skill Center 深化

### 现状
- Agent Center `Models/Skills` tab 已聚合本地 provider 状态、模型候选清单、enabled skills、Model Recommendations、Skill Injection Matrix、Skill Source & Risk，明确「Local status only · no secrets · read-only · No live ping」。

### 目标
补无副作用的 provider 健康历史、最近错误摘要、usage analytics；**不做默认真实外部 ping**，不接云账号/SaaS。

### 任务分解

**刀 1 — Provider 健康历史与最近错误摘要**
1. 复用现有 metric/activity 数据：从 `events`（kind=metrics）/ agent_tool_results / activity 中聚合各 provider 的「最近 N 次调用成功/失败、最近错误信息、平均延迟」。新建只读聚合函数（`src/agents/AgentSkillRegistry.js` 或新 `src/agents/ProviderHealthSummary.js`）。
2. 新增只读 API `GET /api/agent-registry/provider-health`（owner-token），返回各 provider 历史健康摘要（来自本地已有记录，不发外部请求）。
3. 前端 Models/Skills tab 展示「健康历史」（成功率、最近错误、延迟趋势文字），保留 No live ping 边界。
4. 测试：单测覆盖聚合；e2e 断言展示。

**刀 2 — Usage analytics**
1. 聚合各 model/provider 的 token/cost/调用次数（来自 budget_usage / agent_tool_results），按 provider/skill 维度。
2. 前端展示 usage 摘要表。
3. 测试：单测 + e2e。

**刀 3（可选）— 显式手动 health check**
1. 提供「手动检测」按钮（用户主动点击才发一次 provider health check），结果写入健康历史。明确非默认行为、需用户主动触发，避免账号/额度/网络副作用。

### 涉及文件
`src/agents/ProviderHealthSummary.js`（新，或并入 Registry）、`src/server/routes/agentRegistry.js`、`public/app.js`、对应单测 + e2e。

### 风险与边界
- 默认只消费本地已有记录，**不主动 ping**；手动 ping 须用户显式触发。
- 不展示密钥、不写 provider 配置。

### 工作量：2-3 刀。

---

## 方向 7：P6 — 性能与资源控制

### 现状（调研事实）
- 硬编码上限：`CodebaseMap.js:13-17`（MAX_SCAN_FILES=260 / MAX_FOCUS_FILES=24 / MAX_FILE_BYTES=500_000 / MAX_SCAN_MS=1200）；`CodebaseFtsIndex.js:4-6`（MAX_FTS_ROWS=2500 / MAX_BODY_CHARS=1200 / MAX_QUERY_TOKENS=24）；`CodebaseQueryEngine.js`（MAX_RESULTS=20 / MAX_QUERY_CHARS=500）；`CodebasePersistentIndex.js:5`（48 快照/cwd）。
- e2e 测试服务无专项清理机制。

### 目标
把资源上限做成可配置 + 加扫描预算可观测 + 收口 e2e 服务清理，避免大库扫描卡顿与内存膨胀。

### 任务分解

**刀 1 — 上限集中可配置 + 扫描预算可观测**
1. 新建 `src/agents/codebaseLimits.js`：集中导出所有上限常量，支持从 `~/.claude-panel/codebase-limits.json` 覆盖（缺省用现值）。各模块 import 该常量（替换硬编码）。
2. `CodebaseMap` rebuild 在 status 增加 `scanBudget`（实际扫描文件数/字节/耗时 vs 上限、是否触顶截断），前端 Codebase Center 展示。
3. 测试：`tests/unit/codebase-index-store.test.js` 断言 status 含 scanBudget；覆盖配置覆盖生效。
4. 验收：上限可调；触顶可见。

**刀 2 — e2e 服务清理收口**
1. 在 `tests/e2e/panel-ui-walkthrough.mjs` 的 `finally` 已 `browser.close()`；补充：脚本退出时若由脚本自身启动了服务则 kill，并打印端口状态。建一个 `scripts/e2e-with-server.mjs` 包装：启动 server（隔离 HOME + 随机端口）→ 等就绪 → 跑 e2e → 无论成败 kill server + 确认端口无监听 → 退出码透传。
2. 在 `package.json` 增加 `test:e2e:managed` 脚本调用该包装。
3. 验收：一条命令跑完 e2e 且端口必清理。

### 涉及文件
`src/agents/codebaseLimits.js`（新）、`CodebaseMap.js`、`CodebaseFtsIndex.js`、`CodebaseQueryEngine.js`、`CodebasePersistentIndex.js`、`public/app.js`、`scripts/e2e-with-server.mjs`（新）、`package.json`、对应单测。

### 工作量：2 刀。

---

## 方向 8：P8 — 发布准备

### 现状（调研事实）
- `package.json` v2.0.0，electron-builder（mac/win/linux），GitHub Release 自动发布（owner BB20260410 / repo xikelab）。
- **无 schema 迁移框架**：`initSqlite()` 全是 `CREATE TABLE IF NOT EXISTS`，列新增靠运行时 `ALTER`（曾出现旧库缺列问题，见交接记录「agent_runs 迁移顺序修复」）。
- 已有 RELEASE_NOTES v1.0/v1.5/v2.0。

### 目标
建可靠的 SQLite schema 迁移框架 + 旧库回归 + 打包体积/资源核对 + v2.x Release Notes，确保升级不丢数据、不崩库。

### 任务分解

**刀 1 — Schema 迁移框架**
1. 新建 `src/storage/migrations/`：`schema_version` 表（kv 里存 `schema_version` 整数）+ 顺序迁移数组 `[{ version, up(db) }]`。`initSqlite()` 末尾跑 `runMigrations(db)`：读当前 version，按序执行未应用的 up（每个 up 内用 `IF NOT EXISTS` / 安全 `ALTER`），更新 version。
2. 把现有运行时分散的 ALTER（如 agent_runs 补列）收敛成迁移项。
3. 测试：`tests/unit/sqlite-migrations.test.js` 用旧 schema 建库 → 跑迁移 → 断言列齐全、数据不丢。

**刀 2 — 旧库回归 + 打包资源核对**
1. 准备一个「旧版本 schema 样本库」fixture，跑迁移 + 启动 server + 访问 `/api/activity`、`/api/agent-runs`、`/api/governance/summary` 不报错。
2. 核对 `package.json` `build.files` 清单完整（server.js/electron-main.js/public/src/package.json），排除测试/文档；`asarUnpack` 含 better-sqlite3 native。
3. 测试：迁移回归脚本纳入 CI 步骤（或 npm script）。

**刀 3 — Release Notes v2.x**
1. 用 `generate-changelog` 规范写 `RELEASE_NOTES_v2.x.md`：本地治理（预算/审批/审计/委派/Autopilot）、Agent Run 会话化、Codebase Index、权限治理 UI 闭环、知识库等。
2. 不实际 `dist:publish`（发布是用户手动决定的对外动作，红线）。

### 涉及文件
`src/storage/migrations/*`（新）、`src/storage/SqliteStore.js`、`tests/unit/sqlite-migrations.test.js`（新）、`package.json`、`RELEASE_NOTES_v2.x.md`（新）、回归脚本。

### 风险与边界
- 迁移 up 必须幂等、可重入；先备份再迁移（启动时拷贝 panel.db 到 .bak 一次）。
- 不执行对外发布动作（仅准备）。

### 工作量：3 刀。

---

## 方向 9：P7 — i18n / Accessibility

### 现状（调研事实）
- `index.html` `lang="zh-CN"`，文案大量硬编码中文（按钮/提示/搜索标签）。**无任何 i18n 机制**。
- `aria-label` 广泛使用（多处），有 `aria-expanded/controls/hidden`、个别 `role="tablist"`；但 role 覆盖不全、focus order / 语义化 HTML 有缺陷。

### 目标
建轻量 i18n 字符串机制 + 语言切换（zh 默认，en 备），并补齐关键无障碍属性。**不做营销页**，量大故分阶段、低优先。

### 任务分解

**刀 1 — i18n 基础设施**
1. 新建 `public/i18n.js`：`t(key, vars)` + 字符串表 `zh`（默认）/`en`，从 `localStorage('panel:lang')` 读语言，提供 `setLang()`。挂 `window.I18N`。
2. 不一次性全量替换——先接通机制 + 替换「治理中心 / Agent Center / 审批弹窗」等核心高频文案（含本 session 新增的审批后重试弹窗文案）。
3. 测试：单测覆盖 `t()` 取值/回退/插值；e2e 切 en 断言核心文案变化。

**刀 2-3 — 文案分批迁移**
1. 按模块分批把硬编码中文移入字符串表（每批一个模块：Governance / Agent / Codebase / Webhook / MCP …）。每批独立提交 + e2e 回归。

**刀 4 — Accessibility 补全**
1. 给交互按钮补 `role`/`aria-label`，弹窗加 `role="dialog"` + `aria-modal` + focus trap + Esc 关闭（部分已有），列表/看板加语义 role。
2. 检查 tab 键 focus order；审批弹窗打开时 focus 落到主按钮（已部分实现，统一化）。
3. 测试：e2e 用 `aria-*`/role 选择器断言关键无障碍属性存在。

### 涉及文件
`public/i18n.js`（新）、`public/index.html`、`public/app.js`、`public/style.css`、对应单测 + e2e。

### 风险与边界
- 文案迁移量大，必须分批，每批 e2e 防回归（中文按字垂直排列等已知 UI 坑见记忆）。
- 不做营销页、不做完整多语言承诺，只做机制 + 核心文案。

### 工作量：4+ 刀（机制 1 刀，迁移按模块多刀）。

---

## 执行建议小结

1. 先 **P2 收尾**（2 刀，关闭已开的 P2，机制已就位最快）。
2. 然后 **P0-A**（P0 主线）与 **P9 安全审计**（独立文件，可并行）。
3. 再 **P5 治理工作队列** → **P4 知识库**（P4 复用 P0-A 的 FTS 经验）。
4. **P1 深化** / **P6 性能** 可在任意稳定化窗口插入。
5. **P8 发布** 收尾期做（依赖前面稳定）。
6. **P7 i18n** 最后，分批推进。

每个方向每一刀完成后按通用约束验证 + 逐文件提交，并在 `任务交接.md` 顶部「接手最新进展」追加状态，保持交接准确。
