# Claude Code Router (CCR) 可选集成 — v0.47

panel 检测 `which ccr` 命中时自动注册 CCR 为 RoomAdapter，可在房间成员里选。**未安装时静默跳过，不影响其他功能**。

## 是什么

[claude-code-router](https://github.com/musistudio/claude-code-router) 是 JS 中间件，按场景（background / thinking / long-context）把 `claude` 调用自动路由到不同模型（Haiku 跑 watcher / Sonnet 跑 debate / Opus 跑关键 Dev），**省 20x plan 配额**。

## 怎么启用

```bash
npm install -g @musistudio/claude-code-router
ccr -h   # 确认安装成功
```

第一次运行 `ccr` 会引导你配 `~/.claude-code-router/config.json`，按它向导填即可。

## 怎么在 panel 里用

启动 panel 时会打印：

```
✅ 检测到 claude-code-router (ccr)，已加入 adapter 池
```

然后：
1. 💬 聊天室 → 新建 Squad/Debate 房 → 房间成员里 adapterId 选 `ccr`（显示名 🔄 Claude Router）
2. 后端 spawn `ccr code --print --dangerously-skip-permissions ...` 替代 `claude`
3. CCR 按你配置的路由规则自动选 model

## 注意

- CCR 的 bug 会影响 panel 内所有 spawn ccr 的 turn
- 第一次集成建议先在新建房间里**只把一个成员**改成 ccr 试，跑 1-2 个任务确认稳后再批量切
- 卸载：`npm uninstall -g @musistudio/claude-code-router`，panel 下次启动自动剔除 ccr adapter

## 故障排查

```bash
# 检测 panel 是否识别到 ccr
node -e "const{spawnSync}=require('child_process');console.log(spawnSync('which',['ccr']).stdout.toString())"

# 看 ccr 实际跑哪个 model
ccr code --print "hi" 2>&1 | head -5
```
