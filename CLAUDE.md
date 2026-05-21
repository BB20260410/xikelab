# Roundtable — Claude Code 项目规则

> 给 AI 接手时读：本文件描述项目工程约束、代码风格、目录约定。
> 用户视角入门看 `README.md`；变更历史看 `HANDOFF.md`。

## 项目本质

- 本地多 Claude session 管理面板：Express + WebSocket 后端 + Web GUI 前端
- 运行模式：`npm start` 起 `node server.js`（端口 51735，仅 127.0.0.1）；或 `npm run electron` 包成桌面 app
- 当前版本：v0.56 (代码内 v0.XX 注释为权威；README/package.json 同步更新)

## 工程约束（硬规则）

- **文件 < 500 行**（CLAUDE.md/约定）；当前 `public/app.js` 6500+ 行 / `server.js` 4100+ 行违反，逐 sprint 拆分中
- **修代码前必须 Read** 原文件，禁止凭印象改
- **不 git commit / push** 除非用户明说
- **不自主重启 panel**（红线）：改 server.js 后告知用户「需要重启」
- **不 npm install 新依赖** 除非诊断报告明列且用户同意
- **不删除/重命名/移动用户已有文件**
- **不 launchctl / cron / systemd** 系统级调度
- **不 spawn `claude -p` / `codex -p` 子 LLM**（烧用户配额）

## 代码风格

### 前端 (public/)
- `app.js` IIFE 顶层，非 module（S18 渐进迁移到 ES module）
- `main.js` ES module 入口，桥接 `window.PanelUtils` / `window.PanelStore`
- `src/components/Modal.js + UI.js`：IIFE 全局组件，挂 `window.Modal` / `window.UI.*`
- `src/web/utils.js + state.js`：ES module，未来主迁移目标
- 命名：JS camelCase；CSS BEM-ish；data-attr kebab-case
- 错误反馈优先 `toast(msg, kind)`；模态确认用 `confirmModal({...danger:true})`；输入用 `promptModal({...})`
- 禁用 `confirm() / prompt() / alert()` native dialog

### 后端 (server.js + src/)
- ES module（`package.json type: module`）
- 路由按域拆 `src/server/routes/*.js`：`export function register<Name>Routes(app, deps) { ... }`
- 每个 route 函数体 try/catch 包；错误返 `{ok: false, error: msg}` + 合适 HTTP code
- body length cap：JSON.stringify(body).length > N 检查（防 DoS）
- 路径接收 user input 走 `safeResolveFsPath()` 沙箱
- HTTP Origin 白名单（CSRF 防护）

## 目录约定

```
public/
  index.html
  style.css            ~3900 行（顶部声明 @layer base, components, layout, utilities）
  app.js               主前端 IIFE
  main.js              ES module 入口
  src/
    components/        IIFE 全局组件 (Modal/UI)
    web/               ES module helper (utils/state)

src/                   后端 module
  safety/ planner/ state/ cost/ room/ mcp/ webhook/ archive/
  autopilot/ skills/ knowledge/ metrics/ templates/ plugin/ watcher/
  server/routes/       S18-2 抽出的 8 个路由 module

.audit-progress.json   Sprint 体检 manifest（结构化进度）
HANDOFF.md             完整变更历史
README.md              用户上手 + 文档索引
```

## 协作模式（Sprint + 6 阶段）

每个 task 走 6 阶段：实施 → 反思（5 问）→ 全面审核 → 修复 → 自检 → 更新 manifest + 汇报 + 等同意。
详见 `.audit-progress.json` 内 sprint 计划。

每 3 个 task 强制全面回归 smoke：`node .s18-2-routes-smoke.mjs && node .s18-7-panel-smoke.mjs && node /tmp/panel-s18-3-smoke.mjs && node .s18-2a-webhook-test.mjs` 应得 68/68。

## 测试

- 无 jest/vitest/playwright（项目无自动测试框架；不装新依赖）
- 自建 4 个 Node smoke 套件 (`.s18-*.mjs`)：68/68 全过为绿线
- mcp playwright（外部工具）可用于真浏览器 e2e，不需装包

## 安全护栏（既有）

- Origin 白名单 (`server.js:169, 3945`)
- 路径沙箱 `safeResolveFsPath` (`server.js:426`)
- body length cap 19+ 处
- 子进程 `--mcp-config args` 校验禁含 shell metacharacter
- listen 127.0.0.1 only (`server.js:4042`)

## 已知技术债（按 sprint 路线消化）

| ID | 痛点 | sprint |
|---|---|---|
| D1 | app.js 6566 行 | S24 full migration |
| D2 | server.js 4134 行（含 177 行 dead code 注释） | S23 清理 |
| D3 | style.css 3879 行 | S25 按 view 拆 |
| D6 | app.js 内 128 处 try/catch 重复 | S20 抽 apiCall helper |
| D7 | 116 处硬编码 # 颜色 | S22 token 化 |

完整列表见诊断报告（本对话或恢复后 Read `.audit-progress.json`）。
