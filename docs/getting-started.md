# 5 分钟上手 Roundtable

## 🎯 panel 是什么

一个**多 AI 工作台**，让你在一个本地界面里：
- 用 Claude / GPT / Gemini / MiniMax / Ollama 等 8+ AI provider
- 4 种 AI 协作模式（不只是单聊，还有辩论 / 团队 / 联网核对）
- MCP 一站式（让 AI 调外部工具）
- 数据全部本地（0o600 权限，不上云）

## 安装（macOS）

### 方式 1 · 下载 .app（推荐普通用户）

1. 到 [GitHub Release](https://github.com/hxx-panel/roundtable/releases) 下载 `Roundtable.app.zip`
2. 解压 → 拖到 Applications
3. 首次右键选「打开」绕过 Gatekeeper
4. 自动启动 onboarding 引导

### 方式 2 · 源码运行（推荐开发者）

```bash
git clone https://github.com/hxx-panel/roundtable.git
cd roundtable
npm install
npm start    # 后端 51735
# 浏览器开 http://localhost:51735
```

需要 Node 22+。

## 🎬 第一次使用

打开 panel 后会自动弹 2 个引导：

### 1. 隐私选项（默认全关）

panel 不上云、不收数据。但你可以**主动**填：
- Sentry DSN → panel 崩溃时自动上报到你的 Sentry
- PostHog → 使用数据上报

都留空也行（同意但不发）。

### 2. 6 步 walkthrough

教你：品牌区 / 顶栏 11 图标 / + 新建会话 / 6 张快速开始卡 / inspector / 快捷键

## 🚀 第一个房间

试试**多模型辩论**：

1. 点欢迎页 🥊 卡片
2. 输入 topic：「设计一个能扛 10w QPS 的消息推送架构」
3. 选 2 大轮
4. 点「启动辩论」

panel 会：
- R1 让 3 个 AI 独立提案（互不可见）
- R2 互评修订
- R3 终稿表态
- 主持人合成共识

## 🔌 接 MCP（让 AI 用工具）

1. 顶栏点 🔌
2. ＋ 新建 → 选 stdio type
3. 填 command：`npx -y @modelcontextprotocol/server-filesystem ~/Desktop`
4. 保存 → 🧪 测试连接

Claude 房间下次启动会自动挂这个 MCP，能读 ~/Desktop 文件。

## ⌨️ 关键快捷键

| 键 | 功能 |
|---|---|
| ⌘N | 新建会话 |
| ⌘K | 命令面板 |
| ⌘1-9 | 切换 session |
| ⌘D | 切换主题 |
| ⌘↵ | 发送消息 |
| ⌘? | 完整快捷键 |
| ESC | 关任何 modal |

底栏点「⌨️ 快捷键」按钮看全部。

## 📁 数据位置

```
~/.claude-panel/
├── data.json              # session + hook events
├── rooms.json             # 所有房间（debate/squad/arena/chat）
├── room-adapters.json     # adapter API key（apiKey 0o600 + 掩码展示）
├── prompts.json           # prompt 模板
├── webhooks.json          # webhook 配置
├── autopilot.json         # autopilot 规则
├── mcp-calls-YYYY-MM.jsonl # MCP 调用日志
├── metrics-YYYY-MM.jsonl  # 度量数据
├── cli-plugins/           # 用户 plugin manifest
├── img-cache/             # AI 图片本地缓存
└── telemetry.json         # 错误上报 / 分析配置
```

权限都是 0o600（仅你能读）。

## 🆘 遇到问题

- **panel 启不起来**：`lsof -ti tcp:51735 | xargs kill`，再 `npm start`
- **MCP 连不上**：🔌 modal → 该 server → 🧪 测试连接看错误
- **某 AI 房卡住**：⏹ 立即结束 → 看错误 → ▶ 续跑
- **数据丢了**：rooms.json 自动 5MB 旋转，旧的在 ~/.claude-panel/rooms.json.bak

下一步：[four-room-modes.md](./four-room-modes.md)
