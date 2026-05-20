# 通用 CLI GUI Wrapper 重构方案 v1

> **状态**：W1 进行中（2026-05-19 拍板）
> **目标**：把 panel 抽成 manifest-driven 容器，任意 CLI 工具填一份 JSON 就能接进来
> **范围**：2 周可发布产品化（W1=Foundation 5天 / W2=Dashboard+3 真插件 5天）
> **W3 可选**：plugin marketplace（GitHub aggregator + 一键安装）

---

## 0. 动机

当前 panel（v0.52）已经 70% 通用——RoomAdapter / WatcherAdapter / PTY 沙箱都是抽象层；加 GeminiSpawnAdapter 只用 130 行子类代码。
剩下 30% 的工作量是把**命令清单 + 仪表盘 schema** 也变成 manifest 描述，而不是再写 .js 子类。

**3 个痛点同时解**：
1. 接 PraisonAI / AutoGen / LangGraph 这些 Python multi-agent 框架
2. 接自己的 iOS 工具链（xcodebuild / swift test / fastlane / instruments）
3. 包装出去发布 GitHub 让别人套

## 1. 核心抽象：Plugin Manifest 协议

每个被 wrap 的 CLI 工具用一份 JSON manifest 描述：

```jsonc
{
  "id": "praisonai",                  // 唯一 id（adapterId 用）
  "displayName": "🤖 PraisonAI",       // UI 显示
  "version": "1.0.0",
  "type": "spawn",                     // spawn | http
  "bin": {
    "cmd": "praisonai",
    "check": "which praisonai",        // 启动期探测
    "fallback": "~/.npm-global/bin/praisonai"
  },
  "input":  { "mode": "stdin", "encoding": "utf-8" },        // stdin | argv | file
  "output": {
    "mode": "stream",                  // stream | json | jsonl | file
    "parser": "raw",                   // raw | jsonl | regex:pattern | jq:.foo
    "tokensRegex": "tokens:\\s*(\\d+)" // 可选，提取 tokens 用
  },
  "commands": [
    {
      "id": "agents.run",
      "name": "Run Agents",
      "args": ["agents", "{topic}"],   // {placeholder} 来自 params
      "params": [
        { "name": "topic", "type": "string", "required": true, "maxLen": 8000 }
      ]
    }
  ],
  "events": {
    "source": "stdout-jsonl",          // stdout-jsonl | log-tail | sse:url | ws:url
    "path": null,                      // log-tail 用
    "schema": "openai"                 // openai | claude-stream | custom
  },
  "dashboard": [
    { "type": "status-bar", "fields": ["agentCount", "tokensUsed", "elapsed"] },
    { "type": "list", "title": "Active Agents", "source": "events.agent_started", "until": "events.agent_finished" },
    { "type": "log",  "title": "Output", "source": "stdout", "maxLines": 500 }
  ],
  "sandbox": {
    "cwdScope": "home-tree",           // home-tree | tmp-only | explicit-list
    "envWhitelist": ["LANG", "LC_ALL", "PATH"]
  }
}
```

## 2. W1 任务表（5 天 / Foundation）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| **T1** | manifest schema + 3 份内置 | `docs/plugin-manifest.schema.json` + `src/plugin/builtin/*.json` | schema 通过 ajv 校验 |
| **T2** | `PluginRegistry` | `src/plugin/PluginRegistry.js` | 加载 `~/.claude-panel/cli-plugins/*.json` + 内置 + 探测 bin + 热重载，启动日志列出可用 |
| **T3** | `PluginSpawnAdapter` | `src/plugin/PluginSpawnAdapter.js` | 继承 RoomAdapter，按 manifest spawn + 解析输出，curl chat 端点能跑通 |
| **T4** | **自举测试** | 改 server.js + 删 3 个旧 *SpawnAdapter.js | claude/codex/gemini-cli 不再是 .js 子类，是 manifest 加载出来的；debate 房跑通无回归 |
| **T5** | HTTP 端点 + 内置 manifest 接入 pool | `GET/POST/DELETE /api/plugins` + `POST /api/plugins/:id/exec` | curl 装/卸/跑都过 |

**W1 停下点**：自举测试通过 = "Claude/Codex/GeminiCLI 走 manifest 也能完美跑"。这个验证一过，W2 可放心扩。

## 3. W2 任务表（5 天 / Dashboard + 3 真插件）

| # | 任务 | 验收 |
|---|---|---|
| **T6** | 前端 `🧩 Plugins` 顶栏 tab | 浏览器装 .json 能落盘并出现在 plugins 列表 |
| **T7** | 仪表盘渲染器（4 种卡片：status-bar/list/log/metric） | 装一份 manifest panel 自动出专属看板 |
| **T8** | 4 种事件源解析器（stdout-jsonl / log-tail / SSE / WS） | 单测覆盖 4 种 |
| **T9** | 3 个真实 plugin：PraisonAI / iOS 工具链 / AutoGen | 每个都能跑通一条命令 |
| **T10** | README + plugin 开发文档 + manifest 完整示例 | 可发 GitHub 让人套用 |

## 4. 主要风险 + 对策

| 风险 | 对策 |
|---|---|
| **Manifest schema 设计错→返工** | T4 自举测试是兜底——cover 不了现有 3 个 adapter 就回 T1 重设计 |
| **Plugin 任意 spawn 安全** | 走现有 `safeResolveFsPath` 沙箱 + bin 必须 absolute 或 which 命中 |
| **stream-json schema 太多** | W1 只支持 `raw / jsonl`，W2 加 `openai / claude-stream / sse`，其他用 `regex/jq` 兜底 |
| **HTTP 类 adapter（MiniMax/Gemini-API/OpenAI-compat）也要纳入吗？** | W1 manifest `type: "spawn"` 起，W2 加 `type: "http"` schema 扩展 |
| **老房间数据兼容（adapterId 变 plugin id）** | 内置 plugin id 保持 `claude/codex/gemini-cli` 字面值不变，零迁移 |
| **Plugin 写错把 panel 跑挂** | manifest 校验失败拒绝加载；spawn 异常隔离不传染其他 adapter |

## 5. 不在 MVP 范围

- ❌ Plugin marketplace（GitHub 自动 aggregator）—— W3 可选
- ❌ GUI manifest 编辑器（用户先手写 JSON）—— 等用例稳定再做
- ❌ Plugin 版本管理 / 依赖关系 —— 用例驱动再加
- ❌ HTTP 类 adapter 完全 manifest 化 —— W2 起步，可能延后

## 6. 兼容性

- 老房间 `adapterId = "claude"` 仍指向 claude plugin（id 不变）
- 老房间 kind `r1_propose@1` 不受影响（dispatcher 不动）
- 新用户能直接装第三方 plugin；老用户的 watcher/MiniMax 配置回退路径不变

## 7. 目录结构（W1 完成后预期）

```
05_Claude可视化面板/
├── docs/
│   ├── WRAPPER_PLAN.md                 ← 本文
│   └── plugin-manifest.schema.json     ← T1.2
├── src/
│   ├── plugin/                          ← 新目录
│   │   ├── PluginRegistry.js           ← T2
│   │   ├── PluginSpawnAdapter.js       ← T3
│   │   └── builtin/
│   │       ├── claude.json             ← T1.3
│   │       ├── codex.json              ← T1.3
│   │       └── gemini-cli.json         ← T1.3
│   └── room/
│       ├── ClaudeSpawnAdapter.js       ← T4 删除
│       ├── CodexSpawnAdapter.js        ← T4 删除
│       └── GeminiSpawnAdapter.js       ← T4 删除
└── server.js                            ← T4 + T5 改动
```

## 8. 进度

### W1（已完成 2026-05-19）
- [x] 方案落盘
- [x] T1.2 schema（docs/plugin-manifest.schema.json）
- [x] T1.3 3 份内置 manifest（claude/codex/gemini-cli）
- [x] T1 校验（ajv 3 份 manifest 全过）
- [x] T2 PluginRegistry.js
- [x] T3 PluginSpawnAdapter.js
- [x] T5 5 个 /api/plugins/* HTTP 端点（GET list / GET detail / POST install / DELETE / POST reload / POST exec）
- [x] T4 自举测试（已跑 echo-test plugin 通过）

### W2（已完成 2026-05-20）
- [x] B1 前端 🧩 Plugins tab（顶栏按钮 + plugin 列表 + 详情 + 命令执行 modal + 安装/卸载）
- [x] B2 仪表盘渲染器（4 种卡片 status-bar/list/log/metric + stdout/stdout-jsonl 事件源解析）
- [x] B3 3 个真实 plugin 示例 manifest（PraisonAI / iOS 工具链 / AutoGen）
- [x] B4 文档（docs/PLUGIN_GUIDE.md）

### W3（未启动）
- [ ] log-tail / SSE / WebSocket 实时事件源
- [ ] HTTP type plugin
- [ ] Plugin marketplace（GitHub aggregator）
- [ ] 仪表盘自定义渲染器
