# BUGS.md — Bug 清单（冻结版）

> 每条含：**复现步骤** + **期望结果** + **当前实际**。修完把 `Status: Open` 改为 `Status: Fixed`，无法修的标 `WontFix` 并写原因。
>
> **此清单已冻结**，新发现的 bug 记到 `NEXT_ROUND.md`（如不存在则不记）。

---

## B-01 cwd 字段接受任意字符串 → 产生不可用 session
**Status: Open**
**严重度**：HIGH（产生脏数据，已实测发生过 cwd="回答"/"1" 两条）
**位置**：`server.js:173-198`、`public/app.js:248-251`

**复现步骤**：
1. 启动 panel，UI 点「＋ 新建会话」
2. 名称随便填，**cwd 字段填 `abc`**（一个不存在的字符串）
3. 点「创建」

**期望结果**：前端拒绝提交，提示「路径不存在」；或后端返回 400。

**当前实际**：session 被创建并持久化到 `data.json`，cwd 字段直接是字符串 `"abc"`。后续向该 session 发消息会让 `spawn(claude, {cwd:'abc'})` 失败，但 UI 不显示错误。

---

## B-02 `/api/files` 与 `/api/file` 无路径沙箱（可读任意文件）
**Status: Open**
**严重度**：HIGH（安全）
**位置**：`server.js:247-283`

**复现步骤**：
```bash
curl 'http://localhost:5173/api/file?path=/Users/hxx/.ssh/id_rsa' \
  | python3 -m json.tool | head -5
```

**期望结果**：返回 403 Forbidden（或类似拒绝），不暴露文件内容。

**当前实际**：直接返回文件全文（只要 < 1MB）。

---

## B-03 interrupt 后 `busy` 立即标 false，但子进程仍可能在推消息
**Status: Open**
**严重度**：MEDIUM（UI 状态不一致）
**位置**：`server.js:286-294`

**复现步骤**：
1. 给一个 session 发个会触发长任务的 prompt（如「分析整个 Desktop 目录」）
2. 立刻（500ms 内）调 `POST /api/sessions/:id/interrupt`
3. 观察 WS 推送

**期望结果**：interrupt 后不再有该 session 的 `message` 类型推送。

**当前实际**：`busy` 立刻变 false 但子进程实际还要数百 ms 才退出，期间 stdout 已 parse 的消息继续 broadcast，前端看到「明明显示空闲了却又冒出 assistant 消息」。

---

## B-04 进程被 kill（SIGTERM / kill -9）会丢最近 500ms 内未保存的消息
**Status: Open**
**严重度**：MEDIUM（数据丢失）
**位置**：`server.js:33-50, 376-381`

**复现步骤**：
1. 给 session 发消息，等 assistant 开始回（确认 stdout 已写入 session.messages）
2. 在 500ms 内 `kill -TERM <server pid>`
3. 重启 server 看 `~/.claude-panel/data.json` 是否含这条 assistant 消息

**期望结果**：消息持久化到 data.json，重启后仍可见。

**当前实际**：debounce 还没触发 saveData 就被 kill，消息丢失。SIGINT handler 只 kill children，没调 saveData。

---

## B-05 `/api/file` 截断时返回占位字符串当作内容附进 chat
**Status: Open**
**严重度**：LOW（误导）
**位置**：`server.js:269-283`、`public/app.js:308-323`

**复现步骤**：
1. 准备一个 > 1MB 的文本文件（如 `head -c 1500000 /dev/urandom | base64 > /tmp/big.txt`）
2. UI inspector 文件 tab 浏览到该文件
3. 点击文件 → 内容被附进 chat 输入框

**期望结果**：UI 提示「文件过大已截断」，附入 chat 的应是文件前 N 字节真实内容或拒绝附入。

**当前实际**：chat 输入框被填入 `参考文件 /tmp/big.txt:\n\`\`\`txt\n(file > 1MB, truncated)\n\`\`\``——字符串 `(file > 1MB, truncated)` 被当成文件内容发给 claude。

---

## B-06 删除非 active session 时未关闭 WS
**Status: WontFix**
**严重度**：LOW（小内存泄露）
**位置**：`public/app.js:38-45`

**复现步骤**：
1. 创建 2 个 session A 和 B
2. 选中 A（建立到 A 的 WS）
3. 右键 B 的列表项 → 关闭 B
4. 浏览器 DevTools Network → WS 标签

**期望结果**：删除 B 时不应影响 A 的 WS；删除 A 时应主动关 A 的 WS。当前删除 A 已处理（line 40-42），逻辑本身正确。

**当前实际**：实际审视后发现 — 删除非 active 的 B 时，B 本来就没有活跃的 WS（state.ws 只指向 activeId 对应的连接），所以**这条不构成 bug**。

> 跳过原因：复盘代码后确认伪 bug，仅 active 的 session 才有 WS 实例。Status 改为 **WontFix**。

---

**清单已冻结 — hxx 2026-05-17**
**总条目数：6（Open: 5 / WontFix: 1）**
