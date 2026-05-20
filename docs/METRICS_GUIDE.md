# Metrics 指标采集 / 总览面板 — 开发指南

> v0.53 Sprint 3 引入。本文档说清楚指标数据怎么采、怎么聚合、UI 怎么用，以及定价表怎么改。

---

## 1. 总体架构

```
[Dispatcher]                [MetricsStore]                 [HTTP / WS]
 ┌───────────────┐  record   ┌──────────────┐    JSONL     ┌──────────────┐
 │ Debate        │ ────────▶ │ MEM cache    │ ─append───▶  │ ~/.claude-   │
 │ Collaboration │           │ (2000 条)    │              │  panel/      │
 │ Arena         │           │              │              │  metrics-    │
 │ SoloChat      │           │  query()     │ ─readFile──▶ │  YYYY-MM.    │
 └───────────────┘           │  aggregate() │              │  jsonl       │
                             │  byAdapter() │              └──────────────┘
                             │  overview()  │                     ▲
                             └──────┬───────┘                     │ 50MB 滚动
                                    │
                                    │ broadcast(metrics_update)
                                    ▼
                             [WS /ws/global]
                                    │
                                    ▼
                              [Browser]
                                    │
                                    ▼
                              📊 总览页（Chart.js）
```

- **写**：每完成一个 turn（debate/arena 提案 / R1-R3 / judge、squad PM/Dev/QA、chat AI 回复）调一次 `metricsStore.record({...})`
- **存**：内存 cache 2000 条（最近）+ 月度 jsonl 文件（按 `ts.slice(0,7)` 分文件）
- **读**：4 个 HTTP 端点 + WS `metrics_update` 增量推送

---

## 2. 一条 turn record 字段

```json
{
  "ts": "2026-05-20T03:15:42.123Z",
  "roomId": "uuid-或-空",
  "roomMode": "debate|squad|arena|chat",
  "roomName": "房间名",
  "turn": "r1_propose@1:claude  |  dev:T3#i2  |  proposals:A  |  arena_judge",
  "adapter": "claude|codex|gemini-cli|gemini|gemini-openai|minimax|ollama|ccr|custom:xxx",
  "model": "claude-sonnet-4-6 / 空字符串",
  "latencyMs": 18420,
  "tokensIn": 1240,
  "tokensOut": 2350,
  "estCostUSD": 0.0182,
  "success": true,
  "errorKind": null  // 失败时为 "AbortError" / "TypeError" 等
}
```

字段约束（`MetricsStore.record` 内部做了校验）：
- 数字字段会被 clamp 到 `>= 0`
- 不合法对象（非 object / 缺 turn 字段）→ `record()` 返回 `null` 但不抛
- `estCostUSD` 由 `pricing.js` 估算填入

---

## 3. HTTP 端点

| 端点 | 入参 | 返回 |
|---|---|---|
| `GET /api/metrics/overview` | 无 | `{ today: {tokensIn, tokensOut, costUSD, turns, activeAdapters}, rooms: {running, paused, ...}, activeRooms: [...] }` |
| `GET /api/metrics/timeseries?from&to&bucket` | `bucket=hour\|day`，from/to ISO | `{ series: [{ts, tokensIn, tokensOut, costUSD, turns}] }` |
| `GET /api/metrics/by-adapter?from&to` | from/to ISO | `{ adapters: [{id, count, successRate, avgLatencyMs, totalTokens, totalTokensIn, totalTokensOut, totalCostUSD}] }` |
| `GET /api/metrics/health` | 无 | `{ panel: {rssMB, heapMB, uptimeS, pid}, activeRooms, files: {...}, warnings: [] }` |
| `GET /api/metrics/pricing` | 无 | `{ pricing: {...}, note: '估算 ±20%' }` |
| `GET /api/health/processes` | 无 | `{ panelPid, activeDispatchers: {...}, children: [{pid, rssMB, etime, command}], terminals: [...] }` |

时间窗参数都通过 `parseMetricsRange()` 解析，长度上限 64 字符防 DoS。

---

## 4. WS 推送

打开 `/ws/global`（panel 级，不是房级），订阅事件：

```js
const ws = new WebSocket('ws://localhost:51735/ws/global');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'metrics_update') {
    // 每个 turn 完成时推一条
    // msg.delta 是完整的 record 对象
  } else if (msg.type === 'health_warning') {
    // 周期巡检（30 min 一次）发现告警
    // msg.warnings 是 string[]
  }
};
```

前端 `OverviewView` 用 1.5s 节流避免高频重绘。

---

## 5. 定价表（pricing.js）

`src/metrics/pricing.js` 维护 `TABLE`：

```js
const TABLE = {
  claude: {
    defaultIn: 3.00,    // USD per 1M tokens
    defaultOut: 15.00,
    modelOverrides: {
      'claude-opus-4-7':   { in: 15.00, out: 75.00 },
      'claude-sonnet-4-6': { in:  3.00, out: 15.00 },
      'claude-haiku-4-5':  { in:  1.00, out:  5.00 },
    },
  },
  codex: { ... },
  // ...
};
```

**改价**：直接编辑数字，重启 panel 立即生效（已写入的历史 `estCostUSD` 不会回溯重算，UI 显示的是写入时的快照）。

**custom:** 开头的自定义 adapter 用 `CUSTOM_DEFAULT = { in: 2.00, out: 8.00 }` 估，要精确就在 `TABLE` 加 `'custom:xxx': {...}`。

数字来源：2026 Q1 各家官网公开定价。UI 标"估算 ±20%"，因为：
- 部分 adapter 走 CLI（claude / codex CLI），实际后端模型 / 计费规则可能跟 API 不同
- prompt cache、长上下文阶梯定价等没建模
- 用户用免费层 / 企业折扣等

---

## 6. 持久化文件

| 文件 | 内容 | 权限 |
|---|---|---|
| `~/.claude-panel/metrics-YYYY-MM.jsonl` | 一个月一份，每行一条 JSON | 0o600 |
| `~/.claude-panel/metrics-YYYY-MM.jsonl.<ts>` | 单文件超 50MB 时滚动归档 | 0o600 |

**手动清理**：直接删 jsonl 文件即可，下次 record 自动重建。MEM cache 不删（除非 `metricsStore.clearCache()`）。

**导出**：

```bash
cat ~/.claude-panel/metrics-2026-05.jsonl | jq -s '.' > export-may.json
```

---

## 7. 常见问题

**Q：为什么 chat 房 turn 里 latencyMs 总是很大？**
A：chat 是 1v1，conversation 历史全发，token 多自然 latency 高。如果 latency > 60s 看 stdout 心跳是否还在。

**Q：byAdapter 里 ollama 永远 totalCostUSD=0？**
A：对，本地推理 pricing.js 配 `{ defaultIn: 0, defaultOut: 0 }`。

**Q：metrics 文件越来越大，能不能自动删老数据？**
A：当前没自动 retention，单文件 50MB 滚动一次。手动维护：保留最近 3 个月，老的 `rm metrics-2025-*.jsonl`。

**Q：UI 不显示数据？**
A：1) 看 `/api/metrics/overview` 直接 curl 是否返数据；2) 看 `~/.claude-panel/metrics-*.jsonl` 是否有内容；3) panel 没重启过 → 老代码没装新埋点。

---

## 8. 扩展点

1. **加新 adapter**：在 `pricing.js TABLE` 加一行即可。
2. **加新指标**：在 `MetricsStore.record` 接收的 turnSummary 加字段（如 `cacheHit`），同步改 dispatcher 传入。
3. **加新视图**：在 `MetricsStore` 加 `byHour() / byRoom()` 之类的聚合方法 + 新 HTTP 端点。
4. **改聚合粒度**：当前支持 `hour | day`，加 `15min | week` 改 `aggregate()` 里 `bucketKey()`。
