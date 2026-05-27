# Xike Lab 安全审计汇总（P9）

更新时间：2026-05-27 CST
适用分支：`codex/paperclip-local-governance`

本文件汇总已审查并有测试/代码支撑的安全机制，以及当前明确的残留限制。**威胁模型**：本地优先单机工具，主要防护对象是「本机其他 UID 进程」与「Agent/请求方注入」，而非多租户公网服务。所有数据本地存储、敏感文件 `0o600`，不做云同步。

## 一、已审查机制（含代码出处）

### 1. Owner-token 全局守卫
- `server.js:279-296`：默认所有 `/api/` 与 `/v1/` 强制 owner-token，仅白名单豁免（`_ownerTokenUnauth`）。
- 威胁：本机其他 UID 进程 `curl` 拿 RCE / 读数据。Token 经 `getOrCreateOwnerToken` 存 `~/.claude-panel/owner-token.txt`。
- 知识库证据检索/重建索引端点（`/api/knowledge/evidence/*`）同样 owner-token（`src/server/routes/knowledge.js`）。

### 2. SSRF 防护（出站请求）
- `src/server/routes/img-cache.js:26` `isPrivateIp`：拒 loopback / 私网 / 链路本地 / 多播 / 元数据服务；含 IPv4-compatible IPv6（`::a.b.c.d`，img-cache.js:59）。
- `src/server/routes/webhook.js:52` `assertPublicUrl`：webhook URL 入库前拒私网/loopback/非 http(s)/非默认端口。

### 3. 出站上传 domain allowlist（可选）
- `src/security/uploadAllowlist.js`：`~/.claude-panel/upload-allowlist.json` 配置后，网络上传/webhook 仅允许列表内 host（在 SSRF 私网防护之上的额外收敛）。

### 4. Artifact 下载边界（`AgentRunStore.readArtifact`，本轮 C1 加固）
- `src/agents/AgentRunStore.js:10` `ARCHIVE_ARTIFACT_DOWNLOAD_ROOTS` 白名单（仅 `output/playwright/session-evidence`、`output/playwright/gate-audit-reports`）。
- `:39` `normalizeArtifactRelPath`：拒 `..`、null 字节、反斜杠归一、去前导 `/`。
- `:88` `downloadable` **由服务端按路径重算**（`artifactPathDownloadRoot`），**忽略**请求方/payload 注入的 `downloadable` 字段。
- `:2621` `readArtifact` 链路校验：① artifact 必须已被该 run 记录（不可请求任意路径）→ ② `downloadable` 为真 → ③ relPath 落在 allowlist root → ④ `resolve(cwd, relPath)` 必须 `startsWith(safeRoot)`（lexical 逃逸检查）→ ⑤ `existsSync` + `isFile` → ⑥ **`realpathSync` 校验真实目标仍在 root 内（防 symlink 越界，E1 加固，与机制 5 对齐）** → ⑦ 内容 `sha256` 与记录不符则抛 `digest mismatch`（防篡改）。
- 单测覆盖（`tests/unit/agent-run-store.test.js`）：happy path、文件删除、非 allowlist root、`../` traversal、**payload 伪造 downloadable 被忽略**、**sha256 篡改 digest mismatch**、**目录非文件**、**allowlist root 内 symlink 指向外部被 realpath 拒**。

### 5. Symlink 越界防护（项目上下文扫描）
- `src/context/ProjectContextBundle.js:81,99`：root 与每个文件均经 `realpathSync` 解析后再判定是否在项目根内，防符号链接逃逸。

### 6. 命令 / 文件改动 allowlist（不自动重放危险命令）
- `src/agents/AgentRunVerificationExecutor.js`：文件改动路径过 `isAllowedFileChangePath`（:223）；验证命令必须是精确 allowlist（npm 脚本 :301、git :349、其余 :339 拒绝）。危险终端命令不接入「审批后自动重试」机制（见 `public/app.js` `requestWithApproval` 注释）。

### 7. 本地敏感文件权限 `0o600`
- `WebhookStore.js:127`、`MetricsStore.js:48/117`（财务敏感 cost/token）、`RoomAdaptersConfig.js`（含 apiKey）等写入即 `0o600` + 启动期一次性 `chmodSync` 收敛。

### 8. 证据知识库密钥脱敏（P4/A1）
- `src/knowledge/EvidenceKnowledgeStore.js` `redactSecrets`：索引前移除常见密钥格式（`sk-`、`ghp_`、`gho_`、`xox[bpas]-`、`AKIA…`、PEM 私钥头），避免敏感原文进入可全文检索的本地索引。

## 二、残留限制（已知、未来可加固）

1. ~~**`readArtifact` 逃逸检查用 `resolve()` 而非 `realpathSync`**~~ **（E1 已修，2026-05-27）**：`readArtifact` 现在在 lexical `startsWith` 之外，额外用 `realpathSync` 校验真实目标仍在 allowlist root 内，allowlist root 内指向外部的符号链接会被拒（单测覆盖）。与机制 5 对齐。
2. **`redactSecrets` 为模式匹配**：覆盖常见 token 格式，新型/自定义密钥格式可能漏过。脱敏是「尽力而为」的二级防线，不替代「不把密钥写进证据」的源头约束。
3. **upload allowlist 默认关闭**：未配置时仅 SSRF 私网防护生效，出站可达任意公网 host。需要强约束的场景应显式配置 `upload-allowlist.json`。
4. **owner-token 落盘明文**：单机威胁模型下以文件权限（`0o600` + 同 UID）为边界，未做额外加密；多用户共享机器场景不在当前威胁模型内。

## 三、审计结论

上述机制均有代码与单测支撑，覆盖本地优先工具的核心威胁面（本机越权访问、SSRF、路径逃逸、artifact 篡改、危险命令自动重放、敏感数据落盘）。残留限制 1-4 已明确记录，均属「当前威胁模型下可接受、未来可加固」范畴，无需阻塞当前迭代。
