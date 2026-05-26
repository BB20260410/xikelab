# Xike Lab 文档

> 你正在看的是 Xike Lab v2.x 的开发者文档。
> 未来用 Docusaurus / Astro Starlight 起独立站，目前为 markdown 集合。

## 🚀 新手必读

1. [getting-started.md](./getting-started.md) — 5 分钟上手
2. [four-room-modes.md](./four-room-modes.md) — 4 种 AI 协作模式详解
3. [mcp-quickstart.md](./mcp-quickstart.md) — MCP 30 秒接入
4. [autopilot-guide.md](./autopilot-guide.md) — Autopilot 自驾完整指南

## 📚 进阶 / 模块文档

- [ARCHIVE_GUIDE.md](./ARCHIVE_GUIDE.md) — 归档系统
- [METRICS_GUIDE.md](./METRICS_GUIDE.md) — 度量 / 成本
- [HOOKS_USAGE.md](./HOOKS_USAGE.md) — Hook 事件
- [CCR_USAGE.md](./CCR_USAGE.md) — Claude Code Router
- [PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md) — Plugin 开发
- [QUICK_API.md](./QUICK_API.md) — API 速查
- [local-governance-learning-record.md](./local-governance-learning-record.md) — Paperclip 学习沉淀的本地治理能力记录
- [xikelab-agent-skill-registry.md](./xikelab-agent-skill-registry.md) — Agent/Skill Registry、Model / Skill Center、Model Recommendations、Skill Source & Risk、Agent Run、Session Timeline、Session Evidence Chain、Session Evidence markdown UI 导出、Session Evidence markdown 文件归档、Governance Center、Approval Actions、Preflight Review、批准并续跑、approve-before-run diff gate、多文件 staged diff review、命令覆盖映射、命令覆盖解释、覆盖状态过滤、风险排序、可折叠 diff 文件、命令反跳、风险解释、approval resume gate audit、gate id/hash 过滤、Activity gate audit 深链、Gate audit report 对账导出与文件归档、gate audit 分区 mismatch、归档 artifact 反查与安全下载、执行前 diff 审查、Idea-to-Archive guided path、Recommended next、Idea-to-Archive action dedupe、final archive summary、Idea-to-Archive、generated work manifest draft、本地 Agent file-change plan、可选模型 source patch manifest、patch quality、work evidence、受治理文件改动、approval resume file change、expanded command policy、artifact evidence、安全自动验证执行器、工程上下文分派、Code Evidence、Codebase Index、dynamic import、route-to-test citation chain、unresolved reference summary、code question、本地答案引用链、Codebase Answer 注入 Dispatch prompt / Run archive、Symbol Graph、类型实现证据、本地向量融合、持久化快照、类型/成员引用链与权限治理
- [crow5-local-research-evidence-map.md](./crow5-local-research-evidence-map.md) — Crow5 本地研究证据地图、合法吸收边界、Xike Lab 自研替代方案与 P0-P9 路线
- [crow5-deep-analysis-personal-growth-plan.md](./crow5-deep-analysis-personal-growth-plan.md) — Crow5 深度分析与个人能力提升落地计划

## 🛠 部署 / 运维

- [packaging.md](./packaging.md) — 打包 + 上架
- [v0.70-RELEASE-NOTES.md](./v0.70-RELEASE-NOTES.md) — v0.70 发布说明
- 见根目录 `RELEASE_NOTES_v1.0.md` — v1.0 发布说明

## 🗺 商品化路线

- v1.0 ✅ 完成（Sentry / Tauri 评估 / electron-updater / i18n / onboarding）
- v1.5 ✅ 完成（License / Pro vs Free）
- v2.0 ✅ 完成（SQLite 数据底座 / workspace / 向量搜索）
- v3.0 规划中（debate 置信度 / 成本日历 / squad 角色卡 / CLI 检测接管）

## 💬 反馈渠道

- GitHub Issues
- 内置 Telemetry（默认关，用户开启后崩溃自动上报到自己的 Sentry）
