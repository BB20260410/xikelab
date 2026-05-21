# v0.84 minimum — 散落 state 合并到 SSOT 实际迁移指南

> 当前：5 个全局散落 state（state/roomState/pluginState/archiveState/autopilotState）
> SSOT framework 已在：public/src/web/state.js（exports get/set/subscribe）

## 迁移阶梯

### 阶梯 1（最低风险）：只读 mirror
- 在 app.js 各 state 改完后 dispatch 到 SSOT
- 不依赖 SSOT 读，依然用 const state.X
- 收益：可在 inspector 看 SSOT 镜像，验证一致性

### 阶梯 2（中风险）：双向同步
- 关键 read 也走 SSOT
- subscribe pattern → 自动 UI re-render
- 收益：状态变化自动反映 UI，少手动 render() 调用

### 阶梯 3（高风险）：全量迁移
- app.js 顶层 const state/roomState/... 删除
- 全部走 PanelStore.get('sessions')/set('roomActive', x)
- 收益：单一来源真理，可调试 / 可回滚

## 当前 minimum 行动（v0.84）
- 不做实际迁移（高风险）
- 仅在 state.js 加 5 个 state 对象的 schema 定义 + JSDoc
- 等用户专注期再做阶梯 1
