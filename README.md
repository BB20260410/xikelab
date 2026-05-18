# Claude Panel

> 可视化多 Claude Code 会话管理面板 · v0.30
>
> 浏览器 GUI / 真终端内嵌 / 思维镜安全机制 / Codex 风格设计

![status](https://img.shields.io/badge/version-0.30-orange) ![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x64-blue) ![Electron](https://img.shields.io/badge/Electron-42-9feaf9)

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
git clone <repo> claude-panel && cd claude-panel
npm install
npm run dist          # 打包 .dmg 到 out/
open out/*.dmg        # 装到 Applications
```

或下载预编译 `.dmg` → 拖进 Applications → 双击启动（首次会有 Gatekeeper 提示，**控制面板 → 安全性 → 仍要打开**）。

### 方式 2：开发模式

```bash
npm install
npm start             # 浏览器开 http://localhost:5173
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
├── server.js                  Express + WS 后端
├── electron-main.js           Electron 主进程
├── public/                    前端
│   ├── index.html
│   ├── style.css              ~1800 行（Anthropic + Codex token）
│   └── app.js                 ~1500 行
├── src/                       后端核心模块
│   ├── safety/
│   │   ├── LoopGuard.js
│   │   └── DangerousPatternDetector.js
│   ├── planner/FocusChain.js
│   ├── state/AgentStateMachine.js
│   └── cost/CostTracker.js
├── HANDOFF.md                 项目交接文档（给 AI 接手时读）
├── PROGRESS_LOOP.md           cycle 进度档案（loop 自驱时维护）
└── .loop-prompt.md            cron 自动迭代任务池
```

---

## 🛠 开发

```bash
npm start                     # node server.js（开发用，热 reload 跑 npm run dev）
npm run electron              # 在 Electron 窗口启动
npm run package               # electron-builder --mac --dir（快速验证，不压 DMG）
npm run dist                  # 打 .dmg 到 out/
```

### 调环境变量

```bash
PORT=5173            # server 端口
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
