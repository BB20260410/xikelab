# Changelog

All notable changes to Xike Lab will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-05-28

桌面端首个真正可发布版本。本版本完成了 Paperclip 本地治理能力吸收、Crow5 技术精髓吸收、知识库与证据全链路、a11y 闭环;同时通过深度 QA / 构建验证揪出并修复了 12 个真实 bug(含 3 个发布阻断)。

### Added
- **知识库(Knowledge Center)**:跨 Agent Run / 工具结果 / 审计的本地 FTS 证据检索。新增 `/api/knowledge/evidence/{search,stats,reindex}`(owner-token,3 段子路径避开既有 `/api/knowledge/:name`),顶栏「📚 知识」入口,状态框/查询/重建/命中卡/精准跳转 Agent Run。(`3ac3647`, `74a1c7f`, `a6eaac4`, `ea9ff00`)
- **A3 run 归档自动增量索引**:`AgentRunStore.archiveHook` → `EvidenceKnowledgeStore.indexRunTimeline`,run 归档时把消息/工具结果增量入索引,失败不阻断归档。(`a8b3c5b`)
- **C2 治理队列源对象状态联动**:`ApprovalStore.decisionHook` / `BudgetPolicyStore.incidentResolveHook` → `GovernanceQueueStore.setStateBySource`,审批决议/预算解决自动推进队列项;`setStateBySource` 非法 state/不存在 source 边界单测覆盖。(`c1eb761`, `8db9850` 自检修正, `c8bb417` 边界单测)
- **D3 Schema 迁移框架**:`SqliteStore.SCHEMA_MIGRATIONS` + `schema_version` kv + `runMigrations`,升级既有库前自动备份 `panel.db.bak`;首条迁移 `idx_agent_runs_status_updated`。(`2ab339d`)
- **D1 Codebase Center 证据 summary**:`coverage.referenceKindCounts`(callback-registration/object-property-flow 等)+ weak-evidence 徽标 + citation paths。(`262a867`)
- **D2 Parser registry 优先级可配**:`createParserAdapter({ priority })`,为将来更强 adapter 覆盖既有铺路(wasm Tree-sitter 实接因当前无消费者+异步 init 与 sync 接口冲突,延后)。(`38e444f`)
- **B1 托管 e2e**:`scripts/e2e-with-server.mjs` + `npm run test:e2e:managed`,随机端口 + 隔离 HOME 起服务 → 跑 walkthrough → `finally` 必杀 server + 确认端口无监听 → 透传退出码。(`f58cef3`)
- **F1 精准跳转**:`evidence_index_meta.run_id` + search LEFT JOIN 返回 runId,agent 证据命中直接开对应 Agent Run。(`74a1c7f`)
- **C3 Codebase Index 上限集中**:FTS/vector/snapshot/code-context 上限并入 `src/agents/codebaseLimits.js`,支持 `~/.claude-panel/codebase-limits.json` 覆盖。(`e6d2a40`, `462e172`)
- **a11y 闭环**:全 18 个 modal 补 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`(init 富化覆盖所有现有及未来 modal);新增 modal focus-trap(Tab/Shift+Tab 焦点不逸出最上层 modal,playwright 12 次 Tab 验证)。(`3e54cf4`, `e106725`, `111a102`)
- **发布打包流水线**:`scripts/release-build.mjs` + `npm run build:app`,在 electron-builder 后强制 `@electron/rebuild` 修 silent failure + 拷 .app + 回 Node ABI,验证 sha256 ABI 分离。可重复出可运行的 .app。(`fba504d`)

### Changed
- **Electron 42 → 37.10.3**:better-sqlite3 12.10(最新)无法对 Electron 42 新 V8 编译(`v8::External::New` 需 3 参,旧源用 2 参)。降至 better-sqlite3 12.10 prebuilt 上限 electron-v136 = Electron 37。**勿升过 37**(memory 备案,直到 better-sqlite3 适配)。(`7ca4a07`)
- **桌面打包 `asar: false`**:原 asar 内 server.js 无法被 child_process spawn(ENOTDIR)。同时 `files` 配置加 `docs/plugin-manifest.schema.json`(原打包遗漏致 PluginRegistry schema 校验降级)。(`fba504d`)
- **重操作 e2e 等待 5s → 15s**:governance summary body / `.agent-code-context` / `.agent-codebase-map` / `.agent-symbol-graph` 在连跑/大数据下偶现 timeout,提余量后连续 3 跑稳定 144/144。(`5f40465`)
- **README 开发者章节增补**:`test:e2e:managed`、证据知识库、Schema 迁移框架、`codebase-limits.json` 调参指引、`SECURITY_AUDIT.md` 指向。(`d0613cd`)
- **`任务交接.md` 持续更新本轮进展**(下个窗口接力):本轮完成项、剩余项、铁律、命令、关键 sha。(`1e60168`, `78af148`, `e507375`)
- **`E2 兜底`**:知识库无 runId 的命中(如 activity)按 sessionId 跳会话审计上下文,而非 q=refId(消息/工具 id 不在 activity 事件里,搜不到)。(`c169d48`)

### Fixed
- **9 个 CSS 变量全 app 未定义**:`--color-accent-primary`/`--color-accent-secondary` 等被 40+ 处引用于 focus/active 强调态(input:focus 边框、房间/插件 active 高亮、搜索命中、squad 卡片、共识框等),拆 CSS 时漏定义致 `var()` / `color-mix()` 静默失效。在 :root 补别名指向 `--accent-blue` 等基础 token,主题感知自动跟随。(`7577b73`)
- **cxbtn 主/次按钮全 app 丢填充色**:v0.82 拆 CSS 时 `public/css/form.css`(后加载覆盖 style.css)用错 var 名(`--btn-pri-bg`/`--btn-pri-fg`/`--btn-sec-bg`/`--btn-sec-fg` 全未定义)→ background/color 失效致按钮透明,仅 hover/active 才显深色(表现为「黑框无字」)。改为 token 实名 `--btn-pri`/`--btn-pri-text`/`--btn-sec`/`--btn-sec-text`,light/dark 双主题验证。影响 3 个 Center modal / 对话框 / onboarding 等所有 cxbtn-primary/secondary。(`79577db`)
- **Electron 42 桌面打包失败**:better-sqlite3 12.10 C++ 源对新 V8 不兼容 → 降级 Electron 37 修(见 Changed)。(`7ca4a07`)
- **server.js 缺 undici 显式依赖**:`import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'` 原靠 Electron 42 幽影传递,降级后 `ERR_MODULE_NOT_FOUND undici`。补 `undici ^6.26.0`。(`7ca4a07`)
- **PluginRegistry 缺 ajv 显式依赖**:`require('ajv')` 用 v6 API(`schemaId:'auto'` + `lib/refs/json-schema-draft-07.json`)但未声明,靠传递依赖在;MCP sdk/electron-builder 带的是 ajv 8 会破 v6 API。补 `ajv ^6.15.0` 锁 v6。(`54a8efb`)
- **e2e 负载 flaky**:重操作等待 5s 在系统负载/真实数据下偶现 timeout 致 67/68(非产品缺陷)。见 Changed 的 5s→15s。(`5f40465`)
- **2 个 route 文件 handler 缺 try/catch**:`sessions-readonly.js`(2 handler)、`roomAdapters.js`(3 handler)同步 throw 落到 Express 默认处理,**非 PANEL_DEBUG=1 下** 理论可泄漏 stack。包 try/catch 走 `e.message` / `send500` sanitized。(`4804b1f`)
- **tmp 依赖路径遍历漏洞**:`tmp < 0.2.6`(GHSA-ph9p-34f9-6g65)经 electron-builder → @malept/flatpak-bundler → tmp-promise 传递。`overrides` 强制 `tmp ^0.2.6`,`npm audit` 归零(prod+dev)。(`0434d6f`)
- **知识库 UI 4 处缺陷**:① 状态框只占左半留空 → 满宽 ② 命中卡显费解的负 bm25「score -7.48」→ 改友好的「#相关度排名」 ③ 已搜 0 命中却显示初始提示「输入关键词」→ 区分检索中/0 命中/空库/未搜四态 ④ 选 kind 来源后还要再点检索 → 即时重搜。(`a6eaac4`, `ea9ff00`)
- **桌面打包 spawn ENOTDIR**(Step 1 揪出,pre-existing 发布阻断):server.js 在 `app.asar` 内,`child_process.spawn` 无法从 asar 虚拟路径运行。改 `asar: false`。(`fba504d`)
- **PluginRegistry schema 加载失败**(Step 1 揪出):`docs/plugin-manifest.schema.json` 未在 electron-builder `files` 配置中,打包后 ENOENT,plugin schema 校验静默降级。补 files 配置。(`fba504d`)
- **@electron/rebuild silent failure**(Step 1 揪出,最隐蔽的发布阻断):build 日志显示「preparing better-sqlite3 → finished」但未真正为 Electron 重编,致 .app 内 `better_sqlite3.node` 仍是 Node ABI 127,运行时 KC/治理等 DB 操作报 `NODE_MODULE_VERSION 127 vs 136 mismatch`。`scripts/release-build.mjs` 在主打包后强制 `@electron/rebuild --force` + 拷 .app + 回 Node ABI + 验 sha256 分离。(`fba504d`)
- **归档→治理队列死代码**(自检修正):`agentRunStore.setArchiveHook` 内 `setStateBySource('agent_run', id, 'done')` 永远匹配不到(治理队列由 `buildGovernanceSummary` 派生,kind 仅 approval/budget/delegation/autopilot_job,无 agent_run);且 run 归档时其 approval/budget 阻塞已由各自 hook 推进,归档无需重复联动。移除。(`8db9850`)
- **C3 双源不一致**(自检发现):`CodeContextEvidence` 的 `MAX_FILE_BYTES`/`MAX_EVIDENCE_FILES` 硬编码与 `codebaseLimits` 同值重复 → 并入,override 统一生效。(`462e172`)

### Security
- **新增 `docs/SECURITY_AUDIT.md`**:汇总 8 项已审查机制(owner-token 全局守卫 / SSRF 防护与 IPv4-compat IPv6 / 出站 upload allowlist / artifact 下载边界含 sha256 校验 + realpath / symlink 防护 / 命令与文件改动 allowlist / 本地敏感文件 0o600 / 证据知识库密钥脱敏)+ 4 项残留限制。(`ab08a75`)
- **`readArtifact` realpath 加固**(修 C1 残留 #1):在 lexical `startsWith` 之外,额外 `realpathSync` 校验真实目标仍在 allowlist root 内;allowlist root 内放置指向外部的 symlink 会被拒(单测覆盖)。与 `ProjectContextBundle` 对齐。(`5466dd3`)
- **依赖漏洞清理**(`npm audit prod+dev = 0 漏洞`):见 Fixed 的 tmp ^0.2.6。注:1 个 high 是 Electron 37 CVE,**桌面端实际威胁面低**(`contextIsolation: true` + 仅加载可信 `localhost:51735`,CVE 多需加载不受信任 web 内容才可利用),server 模式不用 Electron 完全不受影响;升级被 better-sqlite3 12.10 上限约束,等上游适配。
- **证据脱敏先于截断**(W5 单测锁定):`EvidenceKnowledgeStore.indexItems` 先 `redactSecrets`(sk-/ghp-/gho-/xox-/AKIA/PEM 私钥头)再 slice(0, MAX_CONTENT=4000),长内容末尾(超 4000)的密钥仍被脱敏后不入索引、不可搜。(`4da3af8`)
- **路由错误处理审计**:全库 143 处 handler 仅返 `e.message` 不含 stack;`send500` 仅在 `PANEL_DEBUG=1` 露 message。补齐 2 个无 try/catch 文件(见 Fixed)。无 stack 泄漏路径。(`4804b1f`)

[Unreleased]: https://github.com/BB20260410/xikelab/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/BB20260410/xikelab/releases/tag/v2.0.0
