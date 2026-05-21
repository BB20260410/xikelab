# Claude Panel v1.0 Release Notes

> 2026-05-21
> 商品化首发版本

## 🎯 v1.0 核心特性

panel 是一个**多 AI 工作台**，让你在一个界面里：
- 用 Claude / GPT / Gemini / MiniMax / Ollama 等 8+ AI provider
- 4 种 AI 协作模式：单聊 / 多模型辩论 / AI 团队拆活 / 多模型联网核对
- MCP（Model Context Protocol）一站式：filesystem / github / playwright / 自定义
- Skills + Plugin + Autopilot 自驾 + Knowledge Base 内建
- 本地优先，数据全部 0o600 文件权限

## 🆕 v1.0 新增（vs v0.56）

### 商品化基础设施
- **Task 1.1 Sentry 兼容错误上报**（默认 disabled，用户可填 DSN 自启）
- **Task 1.2 electron-builder 打包验证**（macOS .app 304MB 真启动通过）
- **Task 1.3 electron-updater 自动更新**（GitHub Release 作 update server）
- **Task 1.4 i18n 中英双语**（zh.json + en.json，60 行轻量实现）
- **Task 1.5 新手 walkthrough**（首次访问 6 步引导，自实现 100 行）

### 之前 v0.7-v0.9 累计功能（共 50+ commits）
- 4 房模式（chat/debate/squad/arena）完整 + 4 dispatcher 单测
- 9 个 helper 全接入主流程 + 5 个 UI 入口
- 4 个 backlog 真做（autopilot log UI / MCP resources / img cache / 划词浮层）
- 完整 token / CSS 拆分 / 模块化进展
- vitest 65 case + playwright e2e 35 case + 4 smoke 套件 68 case

## 📦 安装

### macOS（推荐）
1. 从 GitHub Release 下载 `Claude Panel.app.zip`
2. 解压 → 拖到 Applications
3. 首次启动右键选「打开」绕过 Gatekeeper（未签名）
4. 自动触发 onboarding walkthrough

### 源码运行
```bash
git clone https://github.com/hxx-panel/claude-panel.git
cd claude-panel
npm install
npm start                 # 后端 server 51735
# 浏览器开 http://localhost:51735
```

## 🔐 隐私 / 安全

- 所有数据本地存 `~/.claude-panel/`（0o600 权限）
- 错误上报默认关闭（用户主动 accept 才启用）
- API key / token 在配置文件外不出现（不写日志、不入 telemetry）
- MCP / Plugin 沙箱：命令白名单 / 禁危险字符
- WS Origin 白名单防 CSRF

## 🌍 国际化

- 中文（默认）
- English

切换：`PanelI18n.loadLocale('en')` 或浏览器 `Accept-Language` 自动

## 📊 性能

- LCP < 100ms（panel 主页面）
- 8 个核心 endpoint TTFB < 10ms
- 进程 RSS ~96MB（健康）

跑 `npm run perf-check` 看实时数据

## 🧪 测试覆盖

- 4 份 smoke 套件：**68/68** ✅
- vitest 单测：**65/65** ✅
- playwright e2e walkthrough：**35/35** ✅
- 沙箱 fuzz + secrets 掩码 audit 通过

## 🛣 路线图

- **v1.1**：PostHog 自托管 + Docusaurus 文档站 + shadcn/ui 设计系统迁移
- **v1.5**：License key + Pro/Free 分级 + Lemon Squeezy 收费集成
- **v2.0**：Tauri 替 Electron（304MB → 20MB）+ libsql 替 jsonl + workspace 隔离

## ❤️ 致谢

学习来源：
- LibreChat / LobeChat / Cherry Studio - 多 provider 抽象
- AutoGen / CrewAI / LangGraph - 多 agent 编排
- MCP Inspector / goose - MCP 一等公民
- aider / Cline / plandex - CLI agent
- Flowise / Langflow - workflow dry-run
- AnythingLLM / R2R / Verba - hybrid RAG
- promptfoo - output assertion
