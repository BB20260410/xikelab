# Autopilot 自驾完整指南

Autopilot = 房间事件驱动的自动 forward / notify。

**用例**：跑完 debate → 自动转 squad 落地；房出错 → 自动 forward 到调试 chat。

## 默认关

新装 panel 后 autopilot 默认 disabled。需要你主动开启。

## 配置（30 秒）

1. 顶栏 🤖 Autopilot
2. 默认 4 条内置规则（disabled）：
   - debate done → forward squad
   - squad done → forward arena
   - arena done → forward chat
   - 任何房 error → 仅记录日志
3. 启用某条 → 点对应 toggle
4. 点 **▶ 启用** 总开关

## 🧪 试跑（W9 接入）

配完规则不放心？点 **🧪 试跑** 按钮：
- 输入模拟事件 type（`room_done` / `room_error` / `room_auto_paused`）
- 弹窗显示哪些规则匹配 / 会触发什么 action / 跳过哪条 & 为什么

**不真触发任何 forward**，只是验证。

## 📊 执行日志 UI（B-018）

下方表格实时显示历史：
- 列：时间 / 事件 / 规则 / 详情
- 按天分组 + 类型彩色 + 图标
- 过滤下拉（所有/✅fired/❌error/⏭skipped）
- 搜索框（按规则名/房 ID 实时过滤）

## 链路控制

每条规则可配：
- **eventTypes**：哪些事件触发（room_done / error / auto_paused / claim 等）
- **sourceRoomFilter**：仅源房 ID 匹配时触发（可空=所有房）
- **action**：`forward` / `notify` / `archive` 等
- **targetMode**：forward 时新房模式（squad/debate/arena/chat）
- **autoStart**：新房自动开跑还是等用户手动

## 防自动循环

panel 内置：
- 每个链路（hop chain）最多 N hop（默认 5，可配）
- 同 source 短时间内重复 forward 自动 skip
- 用户主动 claim 的房不再被 autopilot 操作

## 安全考虑

- forward 会真创建新房，可能跑真 LLM 烧钱 → 默认 `autoStart=false`，让你看到新房再手动点
- 日志 `~/.claude-panel/autopilot-log.jsonl` 0o600 保留 1000 条
- 配置 `~/.claude-panel/autopilot.json` 0o600

## 实战场景

### 场景 1：辩论 → 落地一条龙

```
你出 debate topic → 跑完 → autopilot 自动开 squad → PM 拆任务 → Dev 实现 → QA 审
```

效果：你只手动开第一个 debate，后续 squad 自动开跑，你睡觉前定个长 topic，醒来看 squad 落地成果。

### 场景 2：错误自动归档

```
任何房 error → autopilot 触发 archive 规则 → 自动 markdown 导出到 ~/Documents/claude-panel-archive/
```

效果：失败房不丢，事后能复盘。

### 场景 3：联网核对前置

```
arena done → autopilot 把 verified 结果转 chat 让你追问
```

## 高级（v2.0+）

backlog 计划：
- B-016 dry-run UI 升级（更直观的可视化）
- B-017 if-node 条件分支（如果 score < 7 才 forward）
- AutoGen-style 终止条件接入

详见 `study/backlog.md`。

下一步：返回 [README.md](./README.md) 看其他文档
