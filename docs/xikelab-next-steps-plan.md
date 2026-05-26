# Xike Lab 下一步务实计划（基于当前实际进展）

更新时间：2026-05-26 CST
适用分支：`codex/paperclip-local-governance`

本文件不重复 `xikelab-remaining-roadmap-plan.md`（初始全量路线），而是基于**本轮已落地的实际状态**，聚焦「把半成品收口成完整闭环 + 解决当前实际困难」。

## 一、当前实际状态盘点（已落地）

本轮已交付并验证（lint / test 362 / e2e 138 全绿，逐刀提交）：

- **P3 稳定化**：原 40+ 文件未提交增量固化为 5 个可审查提交，工作区 clean。
- **P2 权限治理 UI 闭环（完整）**：通用 `requestWithApproval`/`approveAndRetryRequest`/`handleApprovalFlow`（链式批准）+ 五类高风险写入口（webhook/room-adapter/MCP create/test/delete/watcher 双审批）+ 后端多 approvalId。
- **P0-A 代码证据（主体）**：parser adapter 抽象层、`callback-registration`/`object-property-flow` 引用、可读 citation path、`weakEvidence` 弱证据约束。
- **P9 安全审计（刀1-2）**：`pathInside` realpath 防 symlink 越界、`isPrivateIp` 补 IPv4-compat、出站上传可选 domain allowlist。
- **P5 治理工作队列（完整）**：`GovernanceQueueStore` + queue route + Governance Center 五态看板。
- **P4 知识库（刀1）**：`EvidenceKnowledgeStore`（FTS5 + bm25 + 增量 dedupe + 密钥脱敏）。
- **P6 性能（刀1）**：`codebaseLimits.js` 集中可配置上限 + `scanBudget` 可观测。

## 二、当前实际困难（必须解决，否则成技术债）

1. **知识库是「孤岛」**：`EvidenceKnowledgeStore` 能索引能搜，但**没有任何代码调用它喂数据**，也没有检索 API/UI。用户现在无法用它——这是最该收口的半成品。
2. **半成品「待续」项分散**：P0-A 缺前端 summary + Tree-sitter 实接、P5 缺源对象状态联动、P9 缺 approval bypass 审查文档、P6 缺 FTS/vector cache 集中 + e2e 清理脚本。零散待续会逐渐失去上下文。
3. **e2e 测试服务靠手动清理**：本轮用了 52110–52122 十多个端口，每次手动起服务 + kill + 查端口。缺一条「起服务→跑→必清理」的封装命令，易残留监听端口。
4. **Tree-sitter 接口空置**：P0-A 刀1 建了 parser adapter 抽象，但只有 babel 一个 adapter，「为接 Tree-sitter 铺路」的价值尚未兑现。
5. **缺 schema 迁移框架**：`initSqlite` 全是 `CREATE TABLE IF NOT EXISTS`，本轮又加了 `governance_queue_items`、`evidence_fts` 等表，旧库升级靠运行时 ALTER，迁移风险随表增多累积。

## 三、下一步详细计划（按「先收口闭环 → 再解决困难 → 后优化」）

### 阶段 A：把知识库收口成可用闭环（最高优先，解决困难 1）

**A1. 知识库数据接入（1 刀）**
- 操作：新增 `EvidenceKnowledgeStore.indexFromStores({ agentRunStore, activityLog, limit })`，从 `agent_messages`（summary/content）、`agent_tool_results`（output_summary）、archive、activity 关键事件批量派生 `{refKind, refId, content}` 并 `indexItems`（复用现有增量 dedupe）。
- 在 run 归档（`recordArchive`）与 activity 写入后挂**增量索引钩子**（只索引新项，失败不阻断主流程）。
- 验收：单测覆盖 `indexFromStores` 从假 store 派生 + 索引计数；钩子不抛错阻断。

**A2. 检索 API + Knowledge Center UI（1 刀）**
- 操作：`src/server/routes/knowledge.js` 提供 `GET /api/knowledge/search?q=&kind=&limit=`（owner-token），返回 `{ hits:[{refKind,refId,snippet,score,openTarget}] }`；`server.js` 注册。前端新增 Knowledge Center（顶栏入口或并入 Codebase Center 一个 tab）：搜索框 + 结果列表 + 跳转对应 Run/Activity。
- 验收：route 单测 + e2e（索引→搜索→命中→跳转）。

### 阶段 B：解决 e2e 服务清理困难（困难 3）

**B1. e2e 服务封装脚本（1 刀）**
- 操作：`scripts/e2e-with-server.mjs`：随机端口 + 隔离 HOME 起 server → 轮询就绪 → 跑 e2e → `finally` 必 kill server + 确认端口无监听 → 退出码透传。`package.json` 加 `test:e2e:managed`。
- 验收：一条命令跑完整 e2e 且无论成败端口必清理；本地实跑确认。

### 阶段 C：收口零散「待续」项（困难 2）

**C1. P9 刀3 安全审计文档（1 刀）**：审查 artifact `downloadable` flag 来源（确认只有已记录+sha256 校验+allowlist 目录才可下载，不可请求方注入），补 `readArtifact` 伪造/越界/sha mismatch 单测（若现有未覆盖），产出 `SECURITY_AUDIT.md` 汇总已审查项 + 残留限制。
- 注：现有 `readArtifact` 已有 normalizeArtifactRelPath 拒 `..` + downloadRoot allowlist + sha256，本刀重在审查确认 + 文档化 + 边界单测补强。

**C2. P5 源对象状态联动（1 刀）**：审批通过 / 预算解决 / run 归档时回调 `GovernanceQueueStore.setStateBySource` 自动推进队列项；单测覆盖联动。

**C3. P6 刀2：FTS/vector cache 上限集中 + e2e 清理收口（1 刀）**：把 `CodebaseFtsIndex`/`CodebaseVectorIndex`/`CodebaseQueryEngine`/`CodebasePersistentIndex` 的上限并入 `codebaseLimits.js`；与 B1 协同。

### 阶段 D：兑现深化价值（困难 4-5，可延后）

**D1. P0-A 刀5：前端证据 summary（1 刀）**：Codebase Center 展示 callback-registration / object-property-flow / 可读 citation / weakEvidence 计数与标注。

**D2. Tree-sitter adapter 实接（1-2 刀）**：在 parser adapter 接口下新增 `TreeSitterParserAdapter`（wasm 版避免 native 编译陷阱，呼应 better-sqlite3 教训），先覆盖一种现有 babel 未覆盖的语言或更强的跨文件引用；registry 优先级可配置。

**D3. P8 刀1：schema 迁移框架（1 刀）**：`schema_version`（kv）+ 顺序 migration 数组，`initSqlite` 末尾 `runMigrations`；把分散 ALTER 收敛；旧库 fixture 迁移回归单测。启动时先备份 panel.db 到 .bak 一次。

## 四、执行次序建议

1. **A1 → A2**（知识库闭环，把最大的半成品变成可用功能）。
2. **B1**（e2e 封装，立刻降低后续每刀的验证摩擦）。
3. **C1 → C2 → C3**（收口零散待续，清技术债）。
4. **D1 → D3 → D2**（深化与发布准备，D2 Tree-sitter 体量最大放最后）。

每刀仍按：实现 → 定向单测 → `npm run lint && npm test && git diff --check` →（含 UI 则 e2e + 端口确认）→ 逐文件提交 → 更新 `任务交接.md`。红线不变（本地优先 / 可审计 / 本地证据 / 不 git add . / 不自动重放危险命令）。
