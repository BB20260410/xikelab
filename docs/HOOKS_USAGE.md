# Claude Code Hooks 接入 Panel — v0.47

panel 暴露 `POST /api/hooks/:event` 接收 12 种 Claude Code hook 事件，存到 session.hookEvents + 全局环形，让 inspector 安全 tab 能看子进程实时行为。**panel 自己不动你的 ~/.claude/，你按需自己配。**

## 支持的 12 个事件

| 事件 | 触发时机 |
|---|---|
| `SessionStart` | Claude session 启动 |
| `SessionEnd` | session 结束 |
| `UserPromptSubmit` | 用户发消息 |
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具返回后 |
| `Notification` | 系统通知（待响应等） |
| `Stop` | turn 完成 |
| `SubagentStart` | 子 agent 开跑 |
| `SubagentStop` | 子 agent 结束 |
| `SubagentResult` | 子 agent 出结果 |
| `PreCompact` | 上下文压缩前 |
| `PostCompact` | 上下文压缩后 |

## 怎么配 hook

编辑 `~/.claude/settings.json`（全局）或项目级 `.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:51735/api/hooks/PreToolUse -H 'Content-Type: application/json' -d \"$CLAUDE_HOOK_PAYLOAD\""
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:51735/api/hooks/PostToolUse -H 'Content-Type: application/json' -d \"$CLAUDE_HOOK_PAYLOAD\""
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:51735/api/hooks/Stop -H 'Content-Type: application/json' -d \"$CLAUDE_HOOK_PAYLOAD\""
      }]
    }]
  }
}
```

按需复制粘贴其它事件。

## 怎么看结果

### A. 通过 panel UI
打开 session → 右栏 inspector → 🛑 安全 tab → 滚到底看"Hook 事件流"段（v0.47+ 显示）

### B. 通过 API
```bash
# 全局最近 50 个
curl http://localhost:51735/api/hooks?limit=50 | jq .

# 某个 session 的
curl 'http://localhost:51735/api/hooks?sessionId=xxx-xxx&limit=100' | jq .
```

### C. WS 实时
chat session 的 WS 通道接 `{ type: 'hook_event', record }`，前端 inspector 安全 tab 实时增量。

## 限额

- 单 session 内 hookEvents 限 **200 条**（超出滚动丢前面）
- 全局环形限 **2000 条**
- 持久化 `data.json` 仅存最近 **100 条/session**（节省磁盘）
- 不验证来源 IP，仅 localhost 安全前提（不要把 51735 暴露公网）

## 故障排查

```bash
# 1. 手动 POST 一个测试事件
curl -X POST http://localhost:51735/api/hooks/SessionStart \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test","cwd":"/tmp","tool_name":"manual"}'

# 2. 看是否落进全局
curl http://localhost:51735/api/hooks?limit=1

# 3. 看 panel server 日志（如果有报错）
tail -20 /tmp/panel-*.log
```

## 不支持的

- `panel 自启动 claude session` 当前还是 spawn 模式（不走 hook 机制），hookEvents 主要给**外部 claude session**（用户自己在 Terminal/Codex 里跑 claude）观察用
- 后续如果 panel 主动 spawn 时也写入 hook，会让两条线汇总到同一 session.hookEvents
