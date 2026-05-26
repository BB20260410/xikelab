# Xike Agent-Skill Registry

更新时间：2026-05-26

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
- `src/agents/CodebaseFtsIndex.js`
- `src/agents/CodebaseVectorIndex.js`
- `src/agents/CodebasePersistentIndex.js`
- `src/agents/CodebaseCitationChain.js`
- `src/agents/CodeContextSignals.js`
- `src/agents/CodeContextEvidence.js`
- `src/agents/JavaScriptAstAnalyzer.js`
- `src/agents/SymbolGraph.js`
- `src/agents/AgentRunStore.js`
- `src/agents/AgentRunVerificationExecutor.js`
- `tests/unit/agent-skill-registry.test.js`
- `tests/unit/agent-policy-store.test.js`
- `tests/unit/agent-run-store.test.js`
- `tests/unit/agent-run-verification-executor.test.js`
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
- `POST /api/agent-registry/classify`：输入任务文本、member role 和可选 code context，返回命中的 tag、profile、建议 skill、已安装 skill、缺失 skill、可选 `codebaseQuestionAnswer` 和 prompt preview。
- `GET /api/agent-registry/changed-files`：读取当前 git 变更并返回可用于分派的 code-context signals 与 source evidence。
- `GET /api/agent-registry/codebase-map`：扫描当前工程文本代码文件，按任务 query 选出 focus files，返回 evidence、signals 和轻量 import graph。
- `POST /api/codebase-index/rebuild`：按 cwd/query 重建本地 Codebase Index，返回 status 与 map。
- `GET /api/codebase-index/status`：返回最近一次索引状态、扫描数量、evidence / Symbol Graph 摘要和限制信息。
- `POST /api/codebase-index/query`：返回可解释查询结果，包含 `path`、`line`、`score`、`reason`、`anchor`、`parser`、`symbols`、`routes`、`semanticScore`、`citation` 和 `citationSummary`；可传 `useSnapshot=true` 从本地 SQLite 快照冷启动查询。
- `POST /api/codebase-index/question`：基于同一 query/citation 结果生成本地 deterministic code answer，返回 `answer`、`answerLines`、`citations`、coverage 和 limitations；不调用模型、不上传代码，仍以 path/line/reason/citation 为准。coverage 会统计 `typeImplementationCount`，用于说明 class implements interface 的方法级契约证据。
- P0-A 三期第一刀已补上 dynamic import、route-to-test chain 和 unresolved reference summary：citation 可携带 `route-to-test` path，coverage 会暴露 `routeToTestChainCount` / `unresolvedReferenceCount`，limitations 会明确说明证据不足或未解析引用，避免把本地索引结果包装成黑盒总结。
- P0-B 归档 artifact 反查已补上：Agent Run timeline 会聚合 session evidence / gate audit report markdown artifacts，Run detail 的 `Execution Artifacts` 与 Activity detail 的 `Archive Artifacts` 能显示 kind/path/size/sha256/sessionId/gateId，并通过只读 API 打开已记录且位于 `output/playwright/session-evidence/` 或 `output/playwright/gate-audit-reports/` 下的 markdown artifact；未记录、缺失、digest mismatch 或非允许目录会拒绝。
- P0-C gate audit 分区 mismatch 已补上：Gate Audit Report 保留 canonical digest，同时为 `file`、`command`、`risk`、`coverage`、`artifact` 生成分区 digest；不一致报告会指出 source、partition、reason、expected/actual digest 和缺失字段。`coverageExplanations` 不进入跨来源 digest，只作为报告明细展示。
- P1 产品主路径第一刀已补上：Dispatch Preview 顶部的 `Idea-to-Archive Path` 会串联 `Idea -> Code Context -> Dispatch Preview -> Run Draft`，预演完成后局部刷新下一步；`idea_to_archive` Run detail 的同名路径会串联 `Idea -> Dispatch -> Manifest/Patch -> Work + Verify -> Preflight -> Archive`，把 manifest、patch、审批、gate audit、final archive 和 artifact 状态压成用户能扫描的下一步。
- P1 主路径推荐动作已补上：Run detail 的主路径块会显示 `Recommended next` 和 `Other actions`，按当前状态推荐 `Generate Manifest`、`Auto Work + Verify`、`Open Preflight Review`、`Gate Audit Report` 或 `Archive Run`；审批挂起时可从 Run detail 直接打开 Governance Center 的 Preflight Review，并高亮对应 run 的审批续跑项。
- P1 主路径去重已补上：`idea_to_archive` 的生成、补丁、编辑、自动验证、手动完成和归档入口集中到主路径块，顶部 action bar 只保留通用治理、Replay 和 Activity；非 `idea_to_archive` run 的通用 `Archive Run` 入口不变。
- P1 final archive 收口已补上：完成后的主路径会显示 `Final archive` 摘要、tools/files/artifacts/blockers 计数，并把推荐动作改为 `Review Archive` 聚焦 Execution Archive；补充归档备注和 artifact 打开入口作为次级动作保留。
- P1 Model / Skill Center 已收口：Agent Center 新增 `Models/Skills` tab，聚合本地 room adapter provider、前端模型候选清单、enabled skills、profile skill coverage、missing bindings、dispatch hint 缺口、No live ping 边界、Model Recommendations 推荐来源和 Skill Source & Risk 来源/风险统计；界面明确标注 local-only / no secrets / provider config read-only，只读取本地状态，不展示密钥、不写 provider 配置、不引入云账号或 SaaS 租户。

前端顶栏新增 `🧠` 入口，可以直接查看 Agent 图谱并做分派预演。这个入口的价值不是“多一个设置页”，而是把多 Agent 调度从黑箱变成可检查的本地治理对象。

Agent Center 已拆成 5 个最小工作 tab：

- `Profiles`：查看 Agent Profile、角色、治理条和 Skill 覆盖。
- `Dispatch`：查看 Dispatch Rules，并运行现有 Dispatch Preview / 当前变更 / 工程地图预演。
- `Models/Skills`：查看本地 provider model 状态、模型候选清单、Model Recommendations、Skill Injection Matrix、Skill Source & Risk、missing bindings 和 dispatch hint 缺口；只读本地状态，不显示密钥、不写 provider 配置。
- `Runs`：按 status、roomId、sessionId、agentProfileId、sourceType、approvalId、delegationId、budgetIncidentId、deferReason 和治理链过滤最近 Agent Runs，查看 status、room/session/task、profile、token/cost/latency、diagnostics、messages、tool results、Governance Chain、Session Timeline 和相关 Activity。
- `Policies`：集中编辑 profile governance，保留本地覆盖和重置能力。

Runs tab 会直接消费 `/api/agent-runs`、`/api/agent-runs/:id?includeSession=true` 和 `/api/agent-runs/session/:sessionId`。如果 run 关联了 approval、delegation、budget incident 或 autopilot job，详情区会展示 Governance Chain、下一步治理动作、阻塞原因，并提供跳转到审批中心、委派中心和 Activity 时间线的入口；如果 run 带 `sessionId`，详情区还会展示同一 session 的 runs/messages/tool results/archives/activity/governance 聚合、status/source/profile counts、session-level blockers 和 sibling run 反跳。侧边栏 `治理` 入口现在打开 Governance Center，统一聚合 pending approvals、open budget incidents、queued/failed delegations、queued/running Autopilot jobs、带治理链路的 Agent Runs 和最近治理 Activity，提供 Next Actions 与跳转到审批、预算总览、委派、自驾、Agent Run、Activity 的操作入口；其中 Approval Actions 会识别 deferred `idea_to_archive` run，先展示 Preflight Review（文件操作、内容 hash、diff preview、验证命令、evidence 命令安全状态、`Staged Diff +N/-M`、new/existing/attention、verified/uncovered/high-risk 计数、每文件 coverage/risk 和 `Gate review-*`），再提供 `批准并续跑`；前端会先重新请求 `approval-resume-preview` 比对 gate，确认未漂移后批准原审批，再调用 `POST /api/agent-runs/:id/approval-resume` 携带 gate id/hash 复用 run 中保存的同一 manifest 恢复执行。后端会拒绝缺失 gate（428）或 stale/mismatch gate（409），成功响应返回 `resumeReviewGate`；成功续跑前会写入 `approvalResumeGateAudit` 到 run details、decision message 和 `agent.run.approval_resume_gate_accepted` Activity，Run detail 展示 `Approval Resume Gate`、gate id/hash、文件/命令/风险计数、staged diff coverage/risk 摘要和命令摘要，final archive evidence 也携带同一 gate audit。Activity Center 可以用同一 `reviewGateId` / `reviewSha256` 过滤审计流，详情区显示 `Approval Resume Gate` 面板，并可从 gate audit 事件直接打开对应 Agent Run。Run detail 的 `Gate Audit Report` 会调用 `/api/agent-runs/:id/approval-resume-gate-audit`，把 run details、decision message、Activity、final archive evidence 四类来源中的 gate audit 归一化、生成 digest 并列出 checks/sources/mismatches；四类来源一致时报告标记 `Verified: yes`，并包含 `Staged Diff Review` markdown 段，可导出。Run detail 的 `Archive Report` 会调用 `/api/agent-runs/:id/approval-resume-gate-audit/archive`，将 markdown 报告写到 `output/playwright/gate-audit-reports/`，并把 artifact path/size/sha256/reportId/gateId/verified 写入新的 Execution Archive evidence。`GET /api/agent-runs/:id/approval-resume-preview` 可单独返回同一审查摘要、`stagedDiffReview`、`resumeReviewGate` 和 preview audit。未完成的 `idea_to_archive` run 还会显示 `Auto Work + Verify`、`Generate Manifest`、`Generate Patch` 和 `Edit Manifest`：`Generate Manifest` 只生成 `manifest_draft` message 与审计 Activity，不写盘、不执行命令；draft 默认带 `output/playwright/idea-work-*.md` 工作清单 artifact 与 `output/playwright/idea-agent-change-*.js` 本地 Agent file-change plan 两个 `fileChanges`、只读 work evidence、匹配 affected files 和 Agent JS 计划的验证命令；`Generate Patch` 生成 `idea_patch_manifest_draft`，默认 UI 走 `useModel:false` 的本地 fallback，只把 safe-root 源码 append/update/create 补丁 proposal 放进可编辑 manifest，不写盘、不执行命令，并附带 `patchQuality` 分数、等级、findings/blockers、验证命令覆盖和 work evidence 覆盖；API 可显式传 `useModel:true` 和 `adapterId` 使用现有模型 adapter 返回同一 manifest schema，adapter 不可用、失败或 JSON 不可解析时会降级为本地 fallback 并在 generation 里记录 error；`Edit Manifest` 会优先用最新 draft 预填，真正执行仍走 allowlist 内 safe-root 文本文件改动、只读 work evidence 与本地验证命令，并把 work plan、file change evidence、tool result、artifact metadata 和 final archive 归档。本地命令策略支持 exact allowlisted `npm run`、project-local `node --test`、selected `node scripts/*` 和只读 git evidence；显式 `requiresApproval` 的文件改动会先进入 `deferred/approval_pending` 且不写盘，批准后用同一 manifest、`approvalId` 和匹配的 review gate 恢复执行。

Preflight Review 的 staged diff UI 现在按 `riskRank` 排序可折叠文件区块，每个文件直接展示 coverage 状态、risk score/level、verify/evidence 计数和 `riskReasons`；文件内命令 chip 可反跳并高亮全局验证命令，风险解释通过展开项保留后端判定依据。Governance Center 还能按 coverage 状态过滤文件区块，支持 `all`、`verified`、`project_wide_verified`、`evidence_only`、`uncovered`、`blocked`，用于把审查焦点收敛到未覆盖、仅 evidence 覆盖或被阻断的文件。

Session Timeline 现在也带有 `Session Evidence Chain`：后端会把同一 session 的 run、message、tool result、archive、Activity、codebase question answer 和 approval resume gate 归并成顺序证据项，暴露 item/kind/code answer/gate 计数、refs 与 markdown session export；前端在 Runs tab 直接展示 evidence kinds 和最近证据项，并提供 `Export Session` 按钮调用 `/api/agent-runs/session/:sessionId?format=markdown`，在本地 modal 中查看完整 markdown evidence export。`Archive Session` 会调用 `POST /api/agent-runs/session/:sessionId/archive`，把同一份 session markdown 写入 `output/playwright/session-evidence/agent-run-session-*.md`，并作为 Execution Archive artifact 挂回同 session run，方便把多轮 Agent Run 交接为可审计、可落盘的快照。

Command coverage 现在带解释层：每个 staged diff 文件会记录 coverage explanation，说明是 direct verification、project-wide verification、work evidence、verification missing、uncovered gap 还是 blocked file。Governance Center 在文件块中可展开 `Coverage explanation`，Gate Audit Report markdown 会输出 `Coverage Explanations` 计数和 per-file coverage reasons；为了保持 gate audit 对账稳定，深层解释不参与 Activity / archive / run details 的跨来源 digest 比较。

Codebase Center 已提供单独的顶栏入口 `⌘`：

- 展示当前项目 cwd、索引状态、扫描文件数、focus 文件数、symbols 与 route usage 摘要。
- 支持 `Rebuild`、`Query` 和 `Answer`，直接调用 `/api/codebase-index/rebuild`、`/api/codebase-index/query` 与 `/api/codebase-index/question`。
- `Answer` 会展示 `Local Code Answer`、confidence、coverage、`C1/C2...` citation 和 answer lines；它只是本地证据汇总，不是黑盒 AI 总结。
- 查询结果以卡片展示 `path:line`、score、parser、kind、anchor、reason、snippet、symbols/routes。
- 每条结果或全部结果都可以“添加到 Dispatch Preview”：它会把路径写入 `agentRegistryState.affectedFiles`，把 symbols/routes/snippet 转成最小 `codeContextEvidence`，把查询文本同步到 Dispatch Preview 的任务文本；如果当前有 `Local Code Answer`，还会把 `codebaseQuestionAnswer` 同步到 Dispatch Preview、分派 prompt preview 和后续 `idea_to_archive` Run Draft 归档证据。
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
- `approvalResumeGateId` / `reviewGateId`：从审批续跑 gate id 反查相关审计事件。
- `approvalResumeGateSha256` / `reviewSha256`：用 gate hash 前缀定位同一份 Preflight Review。

前端 Activity Center 增加了 `Agent/Skill`、`诊断`、`Metrics` 快捷筛选，并把诊断项和 approval resume gate audit 从原始 JSON 中提炼为紧凑摘要，避免治理线索只能靠复制 JSON 搜索；gate audit 详情会显示 `Approval Resume Gate`、gate id/hash、counts/files/commands、staged diff coverage/risk 摘要和打开对应 Agent Run 的按钮。

## 工程上下文分派

Agent 分派现在不再只看用户输入的任务文本。`src/agents/CodeContextSignals.js` 增加了一个轻量、可替换的 code-context signal 层，会从受影响文件路径、扩展名和已知工程区域推导 dispatch tag：

- `tests/**`、`*.test.js`、Playwright / Vitest 文件会增强 `verification`。
- `public/**`、CSS、HTML、UI 相关路径会增强 `design` 和 `implementation`。
- `src/agents/**`、`src/room/**`、dispatcher / skill injector 会增强 `architecture`。
- route/server 文件会增强 `implementation` 与 `architecture`。
- budget / approval / audit / governance / delegation / policy 相关路径会增强 `governance`。
- release / deploy / package / workflow 文件会增强 `release`。

`src/agents/CodeContextEvidence.js` 在 signals 之上增加了 source evidence 层：对当前变更文件做安全读取，提取 JS/TS 的 function/class/method/const/type/interface symbols、imports/exports、Express-style API routes、Vitest/Playwright test anchors，以及 HTML id、CSS selector、Markdown heading。JS 文件继续优先通过 `src/agents/JavaScriptAstAnalyzer.js` 使用 Acorn 解析 AST；TS/TSX/JSX 通过 `@babel/parser` 解析，记录 parser、diagnostics、identifier/call/type/member references、import specifiers 和 export bindings；类型导入、类型引用、interface extends、class implements、泛型 constraint、TS assertion、TS satisfies 和泛型 instantiation 会保留为 `type-import`、`type-reference`、`type-extends`、`type-implements`、`type-constraint`、`type-assertion`、`type-satisfies`、`type-instantiation`，成员调用/访问会保留为 `member-call`、`member-reference`，解析失败或其他文本语言会回到现有 regex/selector/heading fallback。这样 evidence 已经从“路径 + 正则启发”推进到“AST 优先、可降级”的确定性接口。

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
- `CodebaseIndexStore` 现在维护按 cwd 隔离的 per-file evidence cache；`CodebaseMap` 在 rebuild 时基于文件 `mtime` / `size` / 内容 hash 复用未变化文件的 AST/evidence，只重算新增或变更文件，并在 status 中暴露 `cacheStats`。
- `CodebaseFtsIndex` 现在把 focus evidence 写入内存 SQLite FTS5 表，并通过 `bm25()` 生成本地全文排序信号；query 结果会合并带 `fts5`、`bm25`、`sqlite-fts` reason 和 `bm25Rank` 的命中，status 暴露 `ftsSummary`；query cache 有上限并会关闭被淘汰的内存 FTS 句柄。
- `CodebaseVectorIndex` 复用本地 `hashEmbed`，把每个 evidence 文件压成内存 hash-vector，并以 cosine 相似度生成 `local-hash-vector` / `semantic-vector` / `vector-index` 信号；结果暴露 `semanticScore`，status 暴露 `vectorSummary`，不依赖云 embedding，也不会替代 AST/FTS/citation 的可审计输出。
- `CodebasePersistentIndex` 会把 rebuild 后的 status/map 写入本地 SQLite `codebase_index_snapshots` 表；默认每个 cwd 保留最近 48 个 query 快照，避免不同查询无限堆积。
- `CodebaseIndexStore.query(..., { useSnapshot: true })` 可以在内存 cache 为空或源码暂不可读时，从最新匹配快照重建内存 FTS 并返回结果。
- `CodebaseCitationChain` 会给每条查询结果附加 citation chain：路径、行号、parser、reason、symbols/anchors/snippets/imports/exports/references，以及 Symbol Graph definitions/references/route usages 摘要。
- `CodebaseQuestionAnswer` 会把 query/citation 结果压成本地 code question answer，生成 confidence、coverage、answer lines 和 `C1...` citations；所有结论都落到已有 path/line/reason/citation，不调用外部模型。`codebaseQuestionAnswer` 现在会进入 Dispatch Preview、`formatAgentRuntimeContext()` 的 prompt preview、`AgentRunStore.createIdeaRun()` details / decision / summary / intake archive 和 Run detail，使代码问题证据能跟随后续 Agent Run。
- `JavaScriptAstAnalyzer` 已补 TS/TSX/JSX AST 路径、类型级引用切片、成员语义引用和 method owner 归属；`SymbolGraph` 会使用 named/default/re-export/renamed import 绑定，把 barrel exports 与调用点连回真实实现文件，并保留 `type-*`、`member-*` 与 `type-implementation` reference kind，用于区分运行时调用、类型关系、成员访问和 class implements interface 的方法级契约实现。
- `CodebaseQueryEngine` 负责 query token 扩展、中文治理问题映射、源码优先排序、symbol / anchor / snippet / reference 打分。
- 查询会把“预算、诊断、委派自启动、Agent 图谱入口、SymbolGraph route 关联”等中文问题扩展到实际源码 token，例如 `budget/preflight/incident`、`agent.skill_diagnostics/recordSafe`、`btnAgentRegistry/openAgentRegistryModal/addEventListener`、`routeUsages`。
- 扫描限制仍然保留：跳过 `.git`、`node_modules`、构建产物、`public/vendor`、二进制和超大文件；当前上限允许覆盖本项目 393KB 的 `public/app.js`，但继续拒绝更大的非必要文件。
- 返回结果不是 AI 摘要，而是可复查证据：源码路径、行号、命中理由、parser 来源、anchor、关联 symbols/routes、semanticScore 和 citation chain。测试文件可以作为补充证据，但默认不压过实现文件。

`src/agents/SymbolGraph.js` 在 Codebase Map 之上补了 definition/reference/call-site 关系层：从 evidence symbols 建立定义表，再优先消费 AST references，按“同文件定义优先、显式 import/export 绑定次之、唯一全局定义兜底”的规则连线；非 AST 文件仍使用 regex fallback。同时它会把 `/api/...` route anchors 与前端 fetch/API 字符串关联起来。它仍然不是完整 LSP，因此不能处理真正动态属性访问、跨语言符号和全部类型推导，但 type import / extends / implements / constraint / assertion / satisfies / instantiation、method/member call，以及 class implements interface 的同名方法契约实现已能进入图谱，让 Agent 在执行前看到：

- 哪些定义在 focus files 中被引用或调用。
- API route 在哪里定义、哪里被使用。
- 哪些符号是高连接度入口点。
- 哪些 class method 实现了 interface method，作为 LSP/Tree-sitter 深化前的可审计类型契约证据。

这比 Crow5 当前可见 UI 更进一步：Crow5 能展示文件变化和 codesearch 能力，但 Xike Lab 在预演阶段直接展示“为什么这些文件和符号会进入 Agent 上下文”。

这一步不是冒充完整 AST 索引，而是先把 Crow5 “codesearch + Agent dispatch” 的核心思想落成确定性接口：`classifyTask(text, { codeContext })` 能同时返回文本命中和代码上下文命中。Dispatch Preview 已增加“当前变更”按钮和“受影响文件”输入框，按钮会读取本地 git status，自动填充当前变更路径，并展示：

- `Code Context`：dispatch tag、score、触发理由和路径。
- `Codebase Map`：扫描文件数、focus files、轻量 import edges。
- `Symbol Graph`：definitions、references、calls、type implementations、route uses。
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
- `AgentRunStore.getTimeline()` 现在直接返回 `activityEvents` 与 `governanceLineage`，把 approval / delegation / budget incident / autopilot job 聚合为确定性链路，并给出 `nextAction`；不会自动重放危险命令，HTTP/API 的审批后重试仍要求原动作与 approval payload 匹配。
- Activity 支持 `agentRunId`、`approvalResumeGateId` / `reviewGateId` 和 `approvalResumeGateSha256` / `reviewSha256` 过滤，并在含 `agentRunId`、`entityType=agent_run` 或 approval resume gate audit 的审计事件上显示“打开 Run”入口，可反向跳回 Runs tab 的具体 timeline。
- Runs tab 已补治理筛选与 Governance Chain 展示：列表能显示 approval/delegation/budget/blocker 计数，详情能看到 next action、blockers、Replay Plan、Replay Result、Archive Run 按钮、Execution Archive 视图和相关 Activity 入口。
- `recordReplayPlan()` 会把失败或 deferred run 的安全 replay plan 写回 timeline 的 `replay_plan` message，并记录 `agent.run.replay_planned` Activity；计划只记录修复/重试步骤，不自动执行危险命令。
- `recordReplayResult()` 会把人工或外部执行后的 replay 结果写回 timeline 的 `replay_result` message，并记录 `agent.run.replay_result_recorded` Activity；它只归档结果，不自动推进 run 状态或执行命令。
- `recordArchive()` 会把执行后归档 artifact 写回 timeline 的 `archive` message，并记录 `agent.run.archived` Activity；artifact 汇总输入来源、skills/tags、治理链、tool result 统计、失败工具、message/tool/activity 证据 ID 和涉及文件，`safeToAutoExecute=false`。
- Governance Center 复用 `/api/governance/summary`，后端 `buildGovernanceSummary()` 现在返回 counts、blockers、nextActions 和 sections，聚合审批、预算、委派、Autopilot、Agent Run 与治理 Activity；前端 `btnGovernance` 不替代审批/审计/委派中心，而是作为统一总控与跳转入口。
- `createIdeaRun()` 会把 Dispatch Preview 的 idea / classification / code context / codebase question answer 转成 queued `idea_to_archive` Run Draft，写入 decision、summary、details 与 intake archive，并记录 `agent.run.idea_intake_created` Activity；它只创建可审计草稿，不直接执行危险命令。
- `completeIdeaRun()` 会把未完成的 `idea_to_archive` Run Draft 推进到 running，记录执行摘要、verification tool result、final status、`agent.run.idea_execution_completed` Activity 和 final archive；已 finished 的 run 不允许重复完成。
- `recordIdeaManifestDraft()` 会基于 run 的 affected files、Agent Profile、Skill 和 dispatch tags 生成一个可编辑 manifest draft，写入 `manifest_draft` message，并记录 `agent.run.idea_manifest_drafted` Activity。draft 默认包含 safe-root 下 `output/playwright/idea-work-*.md` 工作清单 artifact 与 `output/playwright/idea-agent-change-*.js` 本地 Agent file-change plan 两个 `fileChanges`、只读 work evidence 和与受影响文件匹配的验证命令；本地 Agent JS 计划由 `local-agent-filechange-synthesizer` 生成，记录 idea、affected files、profile、skills、dispatch tags、proposed changes 和验收边界，并自动加入 `node --check output/playwright/idea-agent-change-*.js`。它本身 `safeToAutoExecute=false`，生成 draft 时不会写盘或执行命令，只有用户继续通过 `idea-auto-execute` 执行同一 manifest 时才会进入 `PermissionGovernance`、work evidence、verification 和 final archive 链路。
- `recordIdeaPatchManifestDraft()` 会基于未完成 Idea Run 生成 source patch manifest draft，写入 `manifest_draft` message，并记录 `agent.run.idea_patch_manifest_drafted` Activity。UI 的 `Generate Patch` 默认传 `useModel:false`，用本地 fallback 为受影响源码文件生成 append/update/create proposal；API 可显式 `useModel:true` 加 `adapterId`，通过现有 Room Adapter 产出同一 JSON manifest schema。模型 adapter 不可用、调用失败、返回无法解析或 fileChanges 不安全时，会降级到本地 fallback，generation 中记录 mode/error/rawSummary；生成阶段依然不写盘、不执行命令，真正落盘只允许走 `idea-auto-execute`、`PermissionGovernance`、work evidence、verification 和 final archive。
- `AgentRunVerificationExecutor` 会对未完成 `idea_to_archive` run 生成 `work_plan`，解析 `fileChanges` manifest 与 `evidenceArtifacts`，只允许 safe-root 文本文件 create/update/append；每次文件改动先经过 `validateFileChange()` 和 `PermissionGovernance` 的 `file.write` 判定，写入前后记录 exists/size/sha256。显式 `requiresApproval` 的文件改动会先预检并创建 manual approval，run 转为 `deferred/approval_pending`，且在 approval 通过前不会写盘；批准续跑还必须通过 `AgentRunApprovalResumeReview` 生成的 review gate，带同一 `approvalId`、相同 action/target/content hash 和匹配 gate id/hash 才恢复写入。随后采集 `git status --short`、`git status --porcelain=v1`、`git diff --name-only`、`git diff --stat` 等只读 work evidence，再执行 `git diff --check`、`npm test`、exact allowlisted `npm run`、`node --check`、project-local `node --test` 和 selected `node scripts/*` 等本地验证命令；每条命令都先经 `PermissionGovernance` 记录判定，再用非 shell 子进程执行。blocked 或 approval-required 的文件改动/命令不会执行，但会作为 evidence 写入 file change evidence、work evidence、verification tool result、artifact metadata 和 final archive。

新增 owner-token 保护的 Agent Run API：

- `GET /api/agent-runs`：按 room/session/task/profile/status/source/approval/delegation/budget/deferReason/hasGovernance 查询 run，并可用 `approvalResumeGateId` / `reviewGateId` 或 `approvalResumeGateSha256` / `reviewSha256` 反查 approval resume gate audit 对应 run。
- `GET /api/activity`：除 room/session/task/entity/action 等基础过滤外，可用 `agentRunId`、`approvalResumeGateId` / `reviewGateId` 和 `approvalResumeGateSha256` / `reviewSha256` 追溯 approval resume gate audit，并从事件详情反跳 Agent Run。
- `GET /api/agent-runs/:id/approval-resume-gate-audit?format=json|markdown`：导出 gate audit 对账报告，验证 run details、decision message、Activity 和 archive evidence 中的 gate digest 是否一致；markdown 包含 `Staged Diff Review` 段，列出 staged diff id/hash、文件数、new/existing/blocked、`+/-` 行数、verified/uncovered、high-risk、top risk files、attention flags 和每文件 coverage/risk。
- `POST /api/agent-runs/:id/approval-resume-gate-audit/archive`：将 gate audit 对账报告写入 `output/playwright/gate-audit-reports/*.md`，并把 report artifact 作为 Execution Archive evidence 归档。
- `GET /api/agent-runs/:id`：返回 run timeline，包括 messages、tool results、activityEvents、governanceLineage 和 archives；传 `includeSession=true` 时会附带同一 `sessionId` 的 session-level 聚合。
- `GET /api/agent-runs/session/:sessionId`：返回同一 session 下的 runs、messages、tool results、archives、Activity、status/source/profile counts、governance blockers 与 next actions；传 `format=markdown` 时导出同一 session 的 markdown evidence chain。
- `POST /api/agent-runs/session/:sessionId/archive`：把同一 session 的 markdown evidence chain 写入 `output/playwright/session-evidence/`，记录 artifact path/size/sha256/sessionId/evidenceChainId，并通过既有 Execution Archive 证据链挂到同 session run；指定 `runId` 时会校验该 run 必须属于同一 session。
- `GET /api/agent-runs/:id/export?format=json|markdown`：导出 run metadata、dispatch、governance、details、messages、tool results、Governance Lineage、Execution Archives，以及 approval/delegation/autopilot/budget 等相关 Activity。
- `POST /api/agent-runs`：创建一个可追踪 run。
- `POST /api/agent-runs/idea`：从一句 idea、Dispatch Preview 分类结果和 code context 创建 `sourceType=idea_to_archive` 的 Run Draft，并写入 intake archive。
- `POST /api/agent-runs/:id/idea-manifest-draft`：为未完成 Idea Run 生成可审计 manifest draft，写入 timeline 和 Activity，但不执行。
- `POST /api/agent-runs/:id/idea-patch-manifest-draft`：为未完成 Idea Run 生成源码补丁 manifest draft；默认本地 fallback，可选 `useModel:true` 通过现有 adapter 生成，再经 safe-root/fileChanges 白名单收敛。
- `POST /api/agent-runs/:id/idea-execution`：记录 Idea Run 执行完成与验证结果，转为 succeeded/failed，并生成 final archive。
- `POST /api/agent-runs/:id/idea-auto-execute`：执行 manifest 中 allowlist 内的 safe-root 文件改动、本地 work evidence / 验证命令，采集 file change evidence、artifact metadata 与 verification tool result，并自动生成 final archive。
- `GET /api/agent-runs/:id/approval-resume-preview`：为 deferred approval resume run 返回 Preflight Review、`stagedDiffReview`、`resumeReviewGate` 和 preview gate audit。
- `POST /api/agent-runs/:id/approval-resume`：要求匹配 gate id/hash 后才批准续跑，并写入 accepted gate audit 到 run timeline、Activity 和 final archive evidence。
- `POST /api/agent-runs/:id/messages`：追加 message / decision / metric / summary。
- `POST /api/agent-runs/:id/tool-results`：追加工具执行摘要、审批 ID 与成本。
- `POST /api/agent-runs/:id/transition`：推进 queued/running/succeeded/failed/cancelled/deferred 状态。
- `POST /api/agent-runs/:id/replay-plan`：生成并记录安全 replay plan，返回 `safeToAutoExecute=false`、blockers、steps 和证据 ID。
- `POST /api/agent-runs/:id/replay-result`：归档 replay result，写入 `replay_result` message 和审计 Activity。
- `POST /api/agent-runs/:id/archive`：记录执行后归档 artifact，写入 `archive` message 和 `agent.run.archived` 审计 Activity。

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

1. 在 Acorn/Babel AST、SQLite FTS/BM25、本地 hash-vector、持久化快照、citation chain、code question、本地答案引用链、Codebase Answer 注入 Dispatch prompt / Run archive、TS 类型级引用、成员语义引用和 `type-implementation` 方法契约证据之上继续接入 Tree-sitter / LSP，让 code-context evidence 和 Symbol Graph 覆盖真正动态访问、跨语言符号和更完整的 LSP 级类型推导。
2. 给 Agent 图谱增加“本轮实际注入上下文”快照，直接关联 room/session/turn。
3. 在现有 approve-before-run diff gate、多文件 staged diff review、命令覆盖映射、命令覆盖解释、覆盖状态过滤、风险排序、可折叠文件审查、命令反跳、风险解释、Session Evidence Chain、Session Evidence markdown UI 导出、Session Evidence markdown 文件归档和 Gate Audit Report 之上继续补归档 artifact 反查/下载列表、更细粒度审计对账和 Tree-sitter/LSP 级 code evidence；当前 Governance Center、Approval Actions、Preflight Review、批准并续跑、执行前 diff 审查、review gate、staged diff review、coverage/risk summary、coverage filter、approval resume gate audit、gate id/hash 过滤、Activity gate audit 深链、Gate audit report 对账导出与文件归档、patch quality、执行后归档 artifact、Execution Archive 视图、Activity 反向链接、`idea_to_archive` 草稿、generated work manifest draft、本地 Agent file-change plan、可选模型 source patch manifest、execution completion、work plan、受治理文件改动、UI manifest editor、approval resume file change、expanded command policy、work evidence、artifact evidence、auto verification 和 final archive 已形成最小闭环。
