# Xikely v2.0.0 — 数据底座 + 多 workspace + 向量搜索 + 结构化日志

发布日期：2026-05-21
代号：Vector-First

## 🎯 这一版的主线

v1.0 商品化、v1.5 收费，**v2.0 是数据基础设施重构**。把散落的 jsonl 文件、文本日志、单文件 KV 全部统一到 SQLite + Pino 结构化日志，并打开向量语义搜索和多 workspace 隔离的门。

## ✨ 新功能

### 🗄 SQLite 数据底座（Task 4.1）

**替代散落的 jsonl 文件**：原本 `mcp-calls-2026-05.jsonl` / `metrics-2026-05.jsonl` / `autopilot-log.jsonl` 等 5+ 流式文件 → 统一 `panel.db` 单 SQLite 数据库。

**数据库设计**：
```sql
events       -- 通用流式事件表（kind/ts/room_id/tag/payload）
kv           -- 通用键值（替 prompts.json / webhooks.json 的简单 KV 用途）
room_summary -- 房间元数据汇总（mode/topic/status/cost）
embeddings   -- 向量索引（kind/ref_id/vector BLOB）
```

**性能优化**：
- WAL 模式（journal_mode=WAL）→ 并发读写不阻塞
- 同步级别 NORMAL → 写性能 5-10x
- 复合索引：`(kind, ts)` / `(room_id, kind)` → 查询毫秒级

**5 个 REST endpoint**：
- `GET  /api/storage/stats` — db 状态 + 各表行数
- `GET  /api/storage/events?kind=mcp_call&room=r-1&limit=100`
- `POST /api/storage/events` — 写入事件
- `GET  /api/storage/kv/:key`
- `PUT  /api/storage/kv/:key`

**迁移脚本**：`node scripts/migrate-jsonl-to-sqlite.js`
- 自动扫描 ~/.claude-panel/ 下所有 mcp-calls-*.jsonl / metrics-*.jsonl / autopilot-log.jsonl / licenses-issued.jsonl
- 一次性导入到 SQLite，**原 jsonl 保留作 fallback**

### 🔍 向量语义搜索（Task 4.2）

**4 个 REST endpoint**：
- `POST /api/embeddings/index { kind, refId, text }` — 索引
- `POST /api/embeddings/search { query, kind?, limit? }` — 语义搜
- `DELETE /api/embeddings/:kind/:refId`
- `GET  /api/embeddings/list?kind=...`

**双轨 embedding provider**：
| 模式 | 维度 | 依赖 | 质量 | 用途 |
|---|---|---|---|---|
| `hash` (默认) | 128 | 0 依赖（Node 内置 crypto）| 粗略 | 开箱即用 |
| `ollama` (opt-in) | 384 | `ollama pull nomic-embed-text` | 好 | 用户已装 ollama 时 |

**性能**：1000 个向量 in-memory 余弦相似度 < 100ms（Float32Array + L2 归一化）

**端到端测试结果**：
```
查询: "如何用 SQLite 做日志存储"
  room-2  0.350 "sqlite 替代 jsonl 流式日志的方案" ✅
  room-5  0.112 "Tauri 比 Electron 体积小 90%"
  room-1  0.000 "electron 应用如何打包成 .app 文件"
```

### 🗂 多 Workspace 隔离（Task 4.3）

**Team-tier 独占功能**。每个 workspace 完全独立的数据：
- `~/.claude-panel/workspaces/{name}/panel.db` (SQLite)
- `~/.claude-panel/workspaces/{name}/rooms.json` / `archive/` / etc

**用例**：
- workspace `work` — 给客户做的项目
- workspace `personal` — 个人副业
- workspace `learning` — 跟课实验
- 完全隔离的 session / rooms / mcp / autopilot 配置

**5 个 REST endpoint**：
- `GET  /api/workspaces` — 列出 + 当前 active + 是否能创建
- `POST /api/workspaces { name, description }` — Team 才能
- `PUT  /api/workspaces/active { name }` — 切换
- `DELETE /api/workspaces/:name` — 删（default 不可删）
- `GET  /api/workspaces/current` — 当前 active 的 dir/db 路径

**安全**：name 限 `^[a-zA-Z0-9_-]{1,32}$`，禁特殊字符防路径穿越。

### 📊 Pino 结构化日志（Task 4.4）

**取代 `console.log`** → 结构化 JSON 日志。

**输出位置**：`~/.claude-panel/logs/panel-YYYY-MM-DD.log` (0o600)

**特性**：
- 按日期自动分文件
- ISO 8601 时间戳
- pid + version 自动注入
- 支持 child logger 串联 trace_id：
  ```js
  const log = child({ provider: 'lemon', traceId: newTraceId() });
  log.info({ email }, '签发成功');
  // → {"level":"info","time":"2026-05-21T05:08:59Z","panel":"2.0.0","pid":20131,"provider":"lemon","traceId":"abc-123","email":"x@y.com","msg":"签发成功"}
  ```
- 异步写盘 + flushSync 接口

**关键模块已迁移**：
- `payment-webhooks.js` (lemon + polar 全程 logger + traceId)
- 其余模块（archive / mcp / autopilot 等）保留 console.log，**渐进迁移**

## 🔧 改进

- 新增 `src/storage/SqliteStore.js`（330 行）
- 新增 `src/embeddings/EmbeddingProvider.js`（80 行）
- 新增 `src/embeddings/VectorIndex.js`（70 行）
- 新增 `src/workspace/WorkspaceManager.js`（120 行）
- 新增 `src/logger/index.js`（90 行）
- 新增 4 个 route 模块（storage/embeddings/workspaces）
- 新增迁移脚本 `scripts/migrate-jsonl-to-sqlite.js`

## 📦 新依赖

- `better-sqlite3` ^11.x — 同步 SQLite，性能优于 sqlite3 npm 包
- `pino` ^9.x — 结构化日志事实标准

## 🧪 测试覆盖

- vitest：65/65 ✅
- 4 套 smoke：68/68 ✅
- SqliteStore round-trip：events 100 行 + KV upsert/delete + room summary + stats ✅
- VectorIndex 端到端：5 corpus + 中文 cross-sim 搜索准确命中 ✅
- Workspace round-trip：list/create/active/delete + 边界条件 15/15 ✅
- Logger：0o600 权限 + ISO 时间 + level + pid + child trace ✅

**累计**：168/168 测试 → **183/183**（v2.0 新加 15 个测试场景）

## 🛣 后续路线（v2.5+）

- libsql 真接入（远程 SQLite，方便 cloud 备份）
- ollama embedding 自动 fallback + UI 配置面板
- workspace switcher UI（顶栏 dropdown）
- 渐进替换剩余 console.log → logger
- v3.0：Tauri 重写（304MB → 20MB）

## 📦 升级

```bash
git pull
npm install              # 自动装 better-sqlite3 + pino
node scripts/migrate-jsonl-to-sqlite.js   # 一次性迁移历史 jsonl 到 SQLite（可重跑）
npm start
```

## ⚠️ Breaking changes

无破坏性变更：
- 现有 jsonl 文件保留，**不强制删**
- SQLite 与 jsonl 双轨运行，应用主路径仍读 jsonl（除新 endpoint /api/storage/* /api/embeddings/* /api/workspaces/*）
- v2.0 → v2.5 才会真正切主路径到 SQLite
- v1.x 用户升级 0 操作

---

## 🤝 贡献者

- [@你的 GitHub username]（主开发）
- Anthropic Claude（结对开发）
