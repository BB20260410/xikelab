# 聊天归档系统 — 使用指南

> v0.54 Sprint 4.5。每个房间完成后把内容自动导出成 markdown 文件存到用户指定目录，按时间/房名分类。

---

## 1. 快速开始

1. 顶栏点 📂 按钮打开配置 modal
2. 改 `rootPath`（默认 `~/Documents/xikely-archive`）
3. 选目录结构：
   - **按时间分类 → 房间名分类**（推荐）：`<root>/2026-05-20/搜索2-b31b9a35/`
   - **按房间名分类 → 时间分类**：`<root>/搜索2-b31b9a35/2026-05-20/`
   - **扁平**：所有文件混在 root 下（仅适合房很少的场景）
4. 勾选「房完成后自动归档」
5. 点保存

下次 debate/squad/arena 跑到 done 时，会自动生成 3 个文件：

```
<root>/2026-05-20/搜索2-b31b9a35/
├── final-consensus.md     # 最终结论 + topic + 元信息
├── full-transcript.md     # 全部 turns / conversation / tasks 内容
└── meta.json              # 元数据（房 id、成员、模型、token 等）
```

---

## 2. 文件内容

### final-consensus.md
```markdown
# 搜索2 · 最终输出

- **模式**：debate
- **创建于**：2026-05-20T03:00:00.000Z
- **房 ID**：b31b9a35-...

## 任务 / topic
（topic 原文）

## 最终共识 / 输出
（finalConsensus，或降级版 R3 终稿合并）
```

### full-transcript.md
- debate / arena：按 round 列出每个 turn（含 token / 时间 / 错误标记）
- squad：列 taskList，含 attempts 折叠区 + reviews 列表
- chat：按时间列对话气泡

### meta.json
```json
{
  "id": "...",
  "name": "搜索2",
  "mode": "debate",
  "createdAt": "...",
  "members": [...],
  "debateRounds": 3,
  "topic": "...",
  "roundCount": 12,
  "archivedAt": "...",
  "archivedBy": "panel-v0.54-Sprint4.5"
}
```

---

## 3. 房级覆盖

某些房想存到不同目录（比如「研究项目 A」的房存到 `~/projects/A/research/`），可在房级覆盖：

```bash
curl -X PATCH http://localhost:51735/api/rooms/<roomId> \
  -H 'Content-Type: application/json' \
  -d '{ "exportPath": "/Users/me/projects/A/research" }'
```

或在 UI（v0.54 暂未做房级编辑入口，留 Sprint 5.5）。

房级 `exportPath` 只覆盖 `rootPath`；目录结构、时间格式仍用全局配置。

---

## 4. API 参考

| 端点 | 说明 |
|---|---|
| `GET /api/archive/config` | 读全局配置 |
| `PUT /api/archive/config` | 改配置（body: `{rootPath, structure, timeFormat, autoArchive, events}`）|
| `POST /api/archive/rooms/:id` | 手动归档某房（覆盖 autoArchive=false 也能用）|
| `GET /api/archive/list` | 扫 rootPath 子树，列已归档房（按 archivedAt 倒序） |

---

## 5. 安全沙箱

`rootPath` 和 `exportPath` 都走 `safeResolveFsPath`：
- ✅ 允许：home 子树（`~/...`）、`/tmp`、`/private/tmp`、`/Volumes/*`
- ❌ 拒绝：`/etc`、`/Library/Keychains`、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.docker`、`~/.kube` 等敏感目录
- 文件名 sanitize：`/ \ : * ? " < > |` 和控制字符替换为 `_`，保留中文

---

## 6. 常见场景

**场景 A：每天的房归档到 iCloud 同步**

```
rootPath: ~/Library/Mobile\ Documents/com~apple~CloudDocs/Claude-Panel-Archive
structure: time-then-room
timeFormat: YYYY-MM-DD
autoArchive: true
```

每天的房自动落到 iCloud 文件夹，多设备可见。

**场景 B：按项目分类归档**

每个项目一个 rootPath，临时切换：

```bash
# 切到项目 A
curl -X PUT http://localhost:51735/api/archive/config \
  -H 'Content-Type: application/json' \
  -d '{ "rootPath": "/Users/me/projects/A/notes/claude-rooms" }'

# 跑几个房（自动归档）
# ...

# 切回默认
curl -X PUT http://localhost:51735/api/archive/config \
  -d '{ "rootPath": "~/Documents/xikely-archive" }'
```

或者每个房用 `exportPath` 单独配，rootPath 留默认。

**场景 C：归档转 Obsidian / 个人 wiki**

`rootPath` 设到 Obsidian vault 目录。markdown 文件直接被 Obsidian 索引。`structure: room-then-time` 让每个 topic（房名）成为长期更新的文件夹。

---

## 7. 关于不归档的内容

- 房间内的图片、附件：当前 panel 不存图片，所以归档也没图片
- WS 推送的 progress 心跳：不归档（只归档 turn 完成后的最终 content）
- adapter token 估算成本：归档在 meta.json `tokensIn/tokensOut`（如果实现了汇总；当前 v0.54 没汇总，可后续加）
- 归档之后房本身不删：rooms.json 还在；要清房用 UI 的 🗑 删除按钮

---

## 8. 故障排查

**Q：autoArchive 开了但没生成文件**
- 看 panel log：`[archive] auto failed: <原因>`
- rootPath 越权？沙箱拒。改成 home 子树
- 房是 chat 模式且没跑过？chat 没有 *_done 事件，只能手动归档
- 房是 paused/error 不是 done？autoArchive 只在 done 触发；手动归档不限状态

**Q：rootPath 设了 iCloud 路径，写盘超慢**
- iCloud Drive 同步是异步的，本地写盘应该很快；如果慢可能是 macOS 后台 indexer。试试 `~/Documents` 本地路径

**Q：怎么验证归档真的工作？**
```bash
curl -X POST http://localhost:51735/api/archive/rooms/<roomId> | jq
# 看返回 { ok: true, dir: "...", files: [...] }
ls -la <dir>
```
