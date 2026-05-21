# server.js 剩余 endpoint 迁移清单

> 当前状态：server.js inline endpoint = 76，src/server/routes/ 已拆        8 文件

## 待迁分组（按 endpoint 前缀）

   3 /api/sessions/:id
   2 /api/watcher/config
   2 /api/sessions
   2 /api/room-adapters
   2 /api/plugins/:id
   1 /api/watcher/test
   1 /api/watcher/providers
   1 /api/version
   1 /api/sessions/:id/safety-history
   1 /api/sessions/:id/reset-busy

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
