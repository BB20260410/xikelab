# IMPROVEMENTS.md — 改进清单（冻结版）

> 用途：作为 `/goal` 长任务的客观判据来源。Claude 完成一条就把 `[ ]` 改成 `[x]`，无法完成的就在该条下追加 `> 跳过原因：xxx`。
>
> **此清单已冻结，迭代期间不允许新增条目**。新发现的改进点请记到 `NEXT_ROUND.md`（如不存在则不记），下一轮 `/goal` 才重新整理。

---

## 高优先级（修完直接提升体验/可分发性）

- [ ] **I-01 新建表单 cwd 路径校验**
  前端 `app.js:248-251` 提交前用 `/api/files?path=` 试探一次，若 404 或 500 则阻止提交并 toast 提示。后端 `server.js:173-198` 也加 `fs.existsSync + isDirectory` 校验，非法直接 400 拒绝。
  **判定**：测试用例「新建 session 时 cwd 填 'abc' → 应被拒绝且不写入 data.json」通过。

- [ ] **I-02 `/api/files` 和 `/api/file` 增加路径沙箱**
  限制 `path` 必须是 `homedir()` 或某个白名单根（如 `~/Desktop`、`~/Documents`）的子路径。`path.resolve` 后 startsWith 检查，否则 403。
  **判定**：`curl 'http://localhost:5173/api/file?path=/etc/passwd'` 返回 403。

- [ ] **I-03 持久化在 SIGINT/SIGTERM 退出前 flush**
  `server.js:376-381` 的 SIGINT handler 中先 `saveData()` 再 exit，新增 SIGTERM 同等处理。
  **判定**：发消息后 200ms 内 `kill -TERM <pid>`，重启后 data.json 仍含该消息。

- [ ] **I-04 interrupt 等子进程退出再清 busy**
  `server.js:286-294` 改成：发 SIGINT 后挂 `child.once('exit')`，在 exit 回调里再 `busy=false` 并 broadcast。
  **判定**：发长任务 → 立即 POST `/interrupt` → 后续 WS 不再收到该 session 的 message 推送。

- [ ] **I-05 token / cost 统计**
  claude stream-json 输出含 `usage`（input_tokens / output_tokens）。在 server.js `child.stdout.on('data')` 解析时累加到 session.usage，前端 inspector「信息」tab 展示累计 tokens 和粗估成本。
  **判定**：session 详情 JSON 多出 `usage: {inputTokens, outputTokens}` 字段，前端可见。

## 中优先级（用户体验提升）

- [ ] **I-06 WebSocket partial message stream（流式打字）**
  当前是 claude 子进程整体输出完才 push assistant message。改成：解析 stream-json 的 `content_block_delta` 事件，前端拼成逐字显示。涉及 server.js 解析逻辑改写 + 前端 appendMessage 改为支持「追加到既有 div」。
  **判定**：发消息后能在 UI 看到逐字增长（不是一次性整段出现）。

- [ ] **I-07 session 名称 / cwd 创建后可编辑**
  右键 session 项弹菜单（重命名/改路径/关闭），后端新增 `PATCH /api/sessions/:id`。
  **判定**：右键已有 session 能改 name 和 cwd，刷新页面保留。

- [ ] **I-08 v0.4 命令面板（⌘K）**
  仿 Codex 的 `cmdk` 风格弹窗：⌘K 打开 → 模糊搜 session、最近文件、动作（新建/全开 Terminal/导出）→ Enter 执行。
  **判定**：⌘K 弹出面板，能搜并切换到任意 session。

- [ ] **I-09 导出 session 为 markdown**
  每条 session 加「⤓ 导出」按钮，后端 `/api/sessions/:id/export` 返回 markdown 文件（user/assistant/tool_use 三种角色分别标题化）。
  **判定**：下载文件能在 Typora 打开，user/assistant 分段清晰。

- [ ] **I-10 前端 markdown 段落支持**
  `app.js:65` 把所有 `\n` → `<br>` 改成：先按 `\n\n+` 切段落用 `<p>` 包，段内 `\n` 才用 `<br>`。
  **判定**：发 "段1\n\n段2" 后渲染为两个独立 `<p>`。

## 低优先级（打包/分发）

- [ ] **I-11 electron-builder 打包 .dmg**
  装 `electron-builder` 配 `build` 字段（appId / mac.icon / target=dmg）+ 准备 icon.icns，`npm run package` 出 dmg。
  **判定**：双击 .dmg → 拖进 Applications → 启动应用 → panel 正常工作。

- [ ] **I-12 加自动化测试套件**
  最小集合：vitest 跑 server.js 的 API（POST/GET/DELETE /api/sessions），mock spawn 不真启 claude。
  **判定**：`npm test` 输出 ≥5 个 passing test。

---

**清单已冻结 — hxx 2026-05-17**
**总条目数：12（高 5 / 中 5 / 低 2）**
