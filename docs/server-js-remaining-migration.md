# server.js 剩余 endpoint 迁移清单

> 当前状态：server.js inline endpoint = 66，src/server/routes/ 已拆 22 文件

## 待迁分组（按 endpoint 前缀）

  18 /api/sessions
  11 /api/rooms
   7 /api/metrics
   6 /api/plugins
   3 /api/term
   3 /api/safety
   3 /api/prompts
   2 /api/projects
   2 /api/hooks
   1 /v1/models
   1 /v1/chat
   1 /api/spawn-batch
   1 /api/search
   1 /api/reports
   1 /api/login-claude
   1 /api/health
   1 /api/files
   1 /api/file
   1 /api/docs
   1 /api/browse

## 已迁分组

- `/api/version` → `src/server/routes/version.js`
- `/api/watcher/config` / `/api/watcher/providers` / `/api/watcher/test` → `src/server/routes/watcher.js`
- `/api/room-adapters` / `/api/room-adapters/providers` → `src/server/routes/roomAdapters.js`
- `/api/rooms` 主 CRUD + `/api/rooms/search` → `src/server/routes/rooms.js`
  - `GET /api/rooms` / `?archived=1` 默认返回 compact summary，避免把完整 rounds/conversation/taskList 拉到列表页。
  - 旧完整列表兼容路径：`GET /api/rooms?full=1` 或 `GET /api/rooms?archived=1&full=1`。

## 迁移方法（单 sprint 拆 1 组）

每组：
1. 新建 `src/server/routes/<group>.js`，签名 `export function registerXRoutes(app, deps) { ... }`
2. server.js import + 调用
3. 删 server.js 中原 inline 块
4. 跑 4 smoke 验证 routes count 不变

## 当前阻塞
endpoint 很多依赖 server.js 中的闭包变量（如 broadcastRoom / roomStore / cwdGetter），
直接迁会导致依赖参数列表很长。
建议先做 deps container（v0.84 SSOT 后再迁）。
