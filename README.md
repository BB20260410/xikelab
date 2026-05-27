# Xike Lab

> 本地多 AI 工作台 · v2.0
>
> Claude / GPT / Gemini / MiniMax / Ollama 8+ provider 一站接入
> 4 种 AI 协作模式（chat/debate/squad/arena）· MCP 一站式 · 数据全本地 0o600

![status](https://img.shields.io/badge/version-2.0.0-brightgreen) ![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x64-blue) ![Electron](https://img.shields.io/badge/Electron-42-9feaf9) ![License](https://img.shields.io/badge/License-Ed25519--offline-orange)

## 📦 下载 / 安装

- **源码运行**（推荐）：`git clone https://github.com/BB20260410/xikelab && cd xikelab && npm install && npm start`，浏览器开 http://localhost:51735
- **预编译 .app**：v2.0 暂未发布 .app（better-sqlite3 与 Electron 42 native ABI 兼容性等社区修复，源码运行 100% 可用）
- **v1.0.0 / v1.5.0 / v2.0.0 Release Notes**：见 [GitHub Releases](https://github.com/BB20260410/xikelab/releases)
- **定价 / 购买**：见 [pricing.html](./public/pricing.html) 或 panel UI 顶栏点 Free 徽章


---

## ✨ 这是什么

一个本地多 Claude Code 会话的可视化管理工具。你在终端能跑的 `claude` 命令，这里也能跑——只是用 Web GUI 管多个 session 同时进行。

**适合**：
- 同时跑多个 claude 项目（息刻 / FreelancerTimer / 自己的代码库），不用切窗口
- 想看流式输出 + 中断按钮 + 历史搜索（⌘K）+ 暗色模式
- 担心 claude 失控（rm -rf 误删 / 重复指令死循环 / 烧 token）
- 想在 panel 内直接打开真终端跑 `claude /login` 或 TUI 模式

**不适合**：
- 想替代官方 `claude` CLI（这是 wrapper，不是替代）
- 给团队多人共享一个账号（红线，会触发 Anthropic 风控）

---

## 🚀 快速开始

### 方式 1：双击 .app（最简）

```bash
git clone <repo> xikelab && cd xikelab
npm install
npm run dist          # 打包 .dmg 到 out/
open out/*.dmg        # 装到 Applications
```

或下载预编译 `.dmg` → 拖进 Applications → 双击启动（首次会有 Gatekeeper 提示，**控制面板 → 安全性 → 仍要打开**）。

### 方式 2：开发模式

```bash
npm install
npm start             # 浏览器开 http://localhost:51735
# 或
npm run electron      # Electron 窗口启动
```

### 前置

- macOS 11+（Linux/Windows 待打包）
- Node.js 22+
- `claude` CLI 已装在 `/Users/<you>/.npm-global/bin/claude`（或设环境变量 `CLAUDE_BIN=/path/to/claude`）
- `claude /login` 已登录过

---

## 🎯 核心功能

### 会话管理
- **多 session 并行**：同时管理多个 claude session，sidebar 按 cwd 自动分组（Codex 风格）
- **接力**：单 session ctx 满时一键归档 + 在 panel 内新建带 HANDOFF 上下文的接力 session
- **归档**：暂时收起（不删除）+ ⌘K 命令面板搜索 / 跳转 / 恢复
- **重命名**：双击 session 名 inline 编辑，或右键菜单 / hover ✏️ 按钮

### 实时对话
- **流式输出** token-by-token + ▍ 闪烁光标（claude --include-partial-messages）
- **中断按钮** ⏸ + Esc 快捷键，双击强制释放（防 child 卡死）
- **markdown 渲染** marked + DOMPurify，支持 GFM 表格 / 列表 / 嵌套
- **代码块** 复制按钮 + 折叠（>12 行默认折叠）+ 语言标签
- **Edit/Write/MultiEdit tool_use 渲染 unified diff**（红绿对照）
- **stderr 聚合** 折叠显示 + 字节数 + 时间戳

### 内嵌真终端 💻
- panel 顶部 💻 按钮打开 PTY 真终端（xterm.js + node-pty）
- 跑 `claude` TUI / `git` / `vim` / 任意命令
- light/dark 主题同步 + 自动 fit resize

### 安全护栏（融合自 MindMirror）
- **LoopGuard** 4 道熔断：单任务步数 / 重复指令 / 5min 成本激增 / 文件颤动
- **DangerousPatternDetector** 25+ 规则：`rm -rf`、`git push --force`、`DROP TABLE`、远程脚本执行等
- **Focus Chain** 每 5 个 user 消息自动注入主目标 + 最近 5 步摘要给 claude 防漂移
- **AgentStateMachine** 解析 stream-json 实时识别 idle/thinking/running/completed/error
- **CostTracker** 按 model 估算每 turn 成本 + 30min 趋势 sparkline

### 集成
- **07 Continuum 接力**：右侧"事实"tab 实时显示 `~/.claude/state/<cwd-hash>/snapshot.md` + 接力链 history
- **方案 B 项目监控**：右侧"项目"tab 扫 `~/Desktop/00_项目/` 下所有 PROGRESS.md 项目，显示 cycle 数 / ASC state / 在跑状态

### 设计（融合自 AgentsView + Codex）
- 完整暗色模式（🌓 切换 + localStorage 持久化）
- 底部 StatusBar：同步时间 / 活跃 N / 在跑 N / 归档 N / 累计 $
- ⌘K 命令面板（搜索会话 + 切换主题 + 接力等命令）
- 右键 portal 菜单（重命名 / 编辑主目标 / 归档 / 删除）
- WAI-ARIA 完整：aria-label / aria-expanded / focus-visible 蓝色 outline

---

## ⌨️ 快捷键

| 按键 | 动作 |
|---|---|
| ⌘N | 新建会话 |
| ⌘K | 命令面板（搜索/跳转） |
| ⌘D | 切换暗/亮主题 |
| ⌘1-9 | 切换到第 N 个 session |
| ⌘↵ | 发送消息 |
| Esc | 中断当前 claude turn（无 modal 时） |

---

## 🔐 关于 Claude 配额 / 风控

- panel 是**本地工具**，跟你直接跑 `claude` CLI 用同一份 Max 订阅
- LoopGuard + DangerDetector + 成本监控自动节流，**不会烧爆配额**
- ❌ 不要部署到云服务器让多人共享你的账号（reseller 红线）
- ❌ 不要装 launchd plist 让 panel 7×24 无人值守跑（容易触发账户审查）
- ✅ 单人本地用 + 单 Max 订阅 = 完全合规

---

## 📂 项目结构

```
.
├── server.js                  Express + WS 后端（~4100 行；含遗留 inline route）
├── electron-main.js           Electron 主进程
├── public/                    前端
│   ├── index.html
│   ├── style.css              ~3900 行（Anthropic + Codex token + @layer 框架）
│   ├── app.js                 ~7100 行（IIFE，S18 已抽 Modal/UI 组件）
│   ├── main.js                ES module 入口（S18 启动，桥接 window.PanelUtils/Store）
│   └── src/
│       ├── components/        Modal.js / UI.js（IIFE 全局组件）
│       └── web/               utils.js / state.js（ES module，渐进迁移期）
├── src/                       后端核心模块
│   ├── safety/                LoopGuard / DangerousPatternDetector
│   ├── planner/FocusChain.js
│   ├── state/AgentStateMachine.js
│   ├── cost/CostTracker.js
│   ├── room/                  DebateDispatcher / CollaborationDispatcher / ArenaDispatcher / 各 adapter
│   ├── mcp/                   McpStore + McpClientManager
│   ├── webhook/ archive/ autopilot/ skills/ knowledge/ metrics/ templates/ plugin/ watcher/
│   └── server/routes/         已拆出的路由 module（继续从 server.js 迁移）
├── HANDOFF.md                 项目交接文档（给 AI 接手时读）
├── PROGRESS_LOOP.md           cycle 进度档案（loop 自驱时维护）
├── .audit-progress.json       Sprint 18+ 体检 manifest
└── .loop-prompt.md            cron 自动迭代任务池
```

---

## 📚 文档索引

项目根有多个 .md 文件，各自用途：

| 文件 | 用途 | 谁看 |
|---|---|---|
| `README.md` | 本文件，快速上手 + 项目结构 | 新用户 / 浏览者 |
| `CLAUDE.md` | Claude Code 项目规则（工程约束 / 代码风格 / 目录约定） | AI / Claude Code 自动加载 |
| `HANDOFF.md` | 完整变更历史 + 设计决策（每版增量） | AI 接手 / 深度排查 |
| `HANDOFF_NEW_CHAT.md` | 给新会话的初始上下文 prompt 模板 | 新开 Claude 会话时复制 |
| `项目说明.md` | 早期项目立项说明（偶尔回溯用） | 历史归档 |
| `BUGS.md` | 已知 bug 列表（实时维护） | 找未修问题 |
| `IMPROVEMENTS.md` | 改进建议池（未排期） | 灵感参考 |
| `PROGRESS_LOOP.md` | cycle 进度日志（loop 自驱时追加） | 自动化进度 |
| `.audit-progress.json` | Sprint 体检 manifest（结构化进度） | 自动化 + Claude Code 恢复 |

---

## 🛠 开发

```bash
npm start                     # node server.js（开发用，热 reload 跑 npm run dev）
npm run electron              # 在 Electron 窗口启动
npm run package               # electron-builder --mac --dir（快速验证，不压 DMG）
npm run dist                  # 打 .dmg 到 out/
```

### 测试

```bash
npm test                      # vitest 全量单测（NODE_MODULE_VERSION 不匹配 → npm rebuild better-sqlite3）
npm run test:e2e:managed      # 推荐：随机端口+隔离 HOME 起服务→跑 playwright→必清端口（免手动起服务/查端口）
npm run test:e2e              # 仅跑 walkthrough，需自行先起服务（PANEL_URL 指向它）
E2E_REAL_HOME=1 npm run test:e2e:managed   # 复用真实 ~/.claude-panel 数据（验证有数据时的行为）
```

### 本地数据 / 索引调参

- **数据底座**：`~/.claude-panel/panel.db`（SQLite，0o600）。schema 走版本化迁移框架（`SqliteStore.SCHEMA_MIGRATIONS`），升级既有库前自动备份 `panel.db.bak`。
- **证据知识库**：顶栏「📚 知识」= 跨 Agent Run / 工具结果 / 审计的本地 FTS 检索；run 归档自动增量索引，命中可跳对应 Agent Run / 会话审计。也可在面板内点「重建索引」。
- **Codebase Index 上限**：可建 `~/.claude-panel/codebase-limits.json` 覆盖 `maxScanFiles/maxFocusFiles/maxFileBytes/maxFtsRows/maxVectorRows/maxSnapshotsPerCwd` 等（缺省见 `src/agents/codebaseLimits.js`）。
- **安全审计**：已审查机制与残留限制见 `docs/SECURITY_AUDIT.md`。

### 调环境变量

```bash
PORT=51735           # server 端口
CLAUDE_BIN=/path     # claude CLI 路径（默认 /Users/<you>/.npm-global/bin/claude）
```

---

## 📜 License

私有项目，未开源。

## 🙏 设计参考

- [Codex.app](https://github.com/openai/codex)（OpenAI）— design token + 按钮系统
- [AgentsView](https://github.com/agentsview/agentsview)（Wes McKinney）— 暗色 / ⌘K / 右键菜单
- [MindMirror](#)（思维镜）— LoopGuard / DangerDetector / Focus Chain
- [Claude Code](https://docs.claude.com/en/docs/claude-code)（Anthropic）— stream-json / --include-partial-messages

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
