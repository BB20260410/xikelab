# /api/rooms/quick — CLI 一键起房

> v0.54 Sprint 4。从外部 shell 一行命令就能起房 + 立即启动，省去打开 panel UI。

---

## 基础调用

```bash
# 启动一个 arena 房（多组对决，自动核对事实）
curl -X POST http://localhost:51735/api/rooms/quick \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "arena",
    "topic": "2026 iOS 18 引入了哪些 SwiftUI 新 API？给出最权威的核对版",
    "startNow": true
  }'
```

返回：
```json
{
  "ok": true,
  "room": { "id": "...", "name": "快速 arena 房", "mode": "arena", "status": "running", ... },
  "started": true
}
```

---

## 用模板起房（推荐）

先列模板：

```bash
curl http://localhost:51735/api/room-templates | jq '.templates[] | {id,name,mode}'
```

挑一个 id 起：

```bash
curl -X POST http://localhost:51735/api/rooms/quick \
  -H 'Content-Type: application/json' \
  -d '{
    "templateId": "builtin:debate-tech-review",
    "topic": "评审这个 API 设计：POST /api/orders 接受 { items, address, paymentMethod }，幂等性怎么保证？",
    "name": "API 设计评审 #2026-05-20",
    "startNow": true
  }'
```

`templateId` 会自动套上：mode / members / debateRounds / qaStrictness。`name` 可覆盖模板默认名。

---

## 参数表

| 字段 | 类型 | 说明 |
|---|---|---|
| `topic` | string | **必填**。任务/讨论内容。≤120K 字符 |
| `mode` | "debate"\|"squad"\|"arena"\|"chat" | 房模式，默认 debate；用 templateId 时自动 |
| `name` | string | 房名，默认"快速 X 房"；用 templateId 时取模板名 |
| `templateId` | string | 用模板（builtin: 或 user: 前缀）|
| `members` | array | 自定义成员（不用 templateId 时生效） |
| `debateRounds` | integer 1-10 | 仅 mode=debate；默认 2 |
| `qaStrictness` | "loose"\|"standard"\|"strict" | 仅 mode=squad |
| `cwd` | string | 房工作目录（沙箱内）|
| `startNow` | boolean | true 时立即启动 dispatcher |

---

## 几个常用场景

**场景 A：每天定时跑一次"今日科技要闻多源对决"**

```bash
# 加到 crontab 或 launchd:
# 0 9 * * *  /Users/me/scripts/morning-brief.sh

curl -X POST http://localhost:51735/api/rooms/quick \
  -H 'Content-Type: application/json' \
  -d '{
    "templateId": "builtin:arena-fact-check",
    "name": "晨报 '"$(date +%Y-%m-%d)"'",
    "topic": "汇总过去 24 小时全球科技要闻（中英文均可）并核对事实。优先 OpenAI/Anthropic/Apple/Google 官方公告 + Hacker News 头条",
    "startNow": true
  }'
```

配合 webhook 推到 Discord/Slack 看结果（见 🔔 配置）。

**场景 B：CI 失败自动起一个 debug 房**

```bash
# CI 脚本里：
if [ $TEST_EXIT -ne 0 ]; then
  curl -X POST http://localhost:51735/api/rooms/quick \
    -H 'Content-Type: application/json' \
    -d '{
      "mode": "debate",
      "topic": "测试失败排查：\n\n失败 test：'"$TEST_NAME"'\n错误日志：\n```\n'"$(cat $LOG_PATH | tail -100)"'\n```\n\n分析根因 + 修复方案",
      "name": "CI 失败 #'"$BUILD_NUMBER"'",
      "startNow": true
    }'
fi
```

**场景 C：从 macOS Shortcut 一键起房**

把 curl 包进 Shortcut，用 "Get Contents of URL" action 调用。或写个 alfred workflow。

---

## 与其他端点关系

- 起完房后：用 `GET /api/rooms/:id` 查状态；用 `/ws/room/:id` 订阅实时 turn 事件
- 不想立即启动：`startNow: false`（默认）→ 只建房，topic 保存到 room.topic，用户随后在 UI 启动
- 起完房想转给其他房：用 `POST /api/rooms/forward`
- 想接外部通知：配 webhook，房完成时自动推（见 🔔 Webhook modal）

---

## 错误

| code | 含义 |
|---|---|
| 400 | topic 缺/过长，mode 非法，templateId 不存在 |
| 403 | cwd 越权（沙箱拒） |
| 429 | 房间总数达上限（500）|

返回非 ok 时 `{ ok: false, error: "..." }` 给出具体原因。
