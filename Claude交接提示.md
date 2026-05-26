# 给 Claude 的可复制交接提示

请接手 Xike Lab / Claude 可视化面板项目。

项目路径：

```bash
/Users/hxx/Desktop/00_项目/05_Claude可视化面板
```

当前分支：

```bash
codex/paperclip-local-governance
```

先执行并核对：

```bash
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
test ! -e STOP
git log --oneline --decorate -8
```

然后按顺序阅读：

1. `任务交接.md`
2. `上下文交接.md`
3. `docs/local-governance-learning-record.md`
4. `docs/README.md`
5. `docs/xikelab-agent-skill-registry.md`
6. `docs/crow5-deep-analysis-personal-growth-plan.md`
7. `docs/crow5-local-research-evidence-map.md`

项目定位：

- 这是 Xike Lab，本地可控的多 AI Agent 开发面板，不是 SaaS。
- 当前分支吸收 Paperclip 本地治理思想和 Crow5 工程上下文/Agent Registry 能力，但必须保持本地优先。
- 不要删除预算、审批、审计、委派、Autopilot、Agent Run、Codebase Index、Agent/Skill Registry。
- 不要把 Xike Lab 改成企业多租户 SaaS。
- 不要做 Crow5 授权、付费、登录、加密、DRM 绕过；只能做合法授权范围内的研究、审计、能力拆解和自研复刻。
- 当前工作区有大量未提交增量，禁止 `git reset --hard`，禁止大范围 `checkout`，禁止 `git add .`。

当前已完成到可交接状态：

- P0-A Codebase Index 三期第一刀：dynamic import、route-to-test citation chain、unresolved reference summary、本地答案限制说明。
- P0-B Agent Run 归档 artifact 反查：Session Evidence / Gate Audit Report markdown artifact 可在 Run detail 与 Activity 反查、复制路径、打开下载；读取限定在允许目录并校验记录和 sha256。
- P0-C Gate Audit Report 分区 mismatch：file / command / risk / coverage / artifact 分区 digest，明确 source、partition、reason、缺字段或 digest 不一致；`coverageExplanations` 不参与跨来源 digest。
- P1 产品主路径：Dispatch Preview 和 Run detail 已形成 `Idea-to-Archive Path`，包含 Recommended next、Other actions、action 去重、final archive summary 和 Review Archive 聚焦。
- P1 Model / Skill Center 已收口：Agent Center 新增 `Models/Skills` tab，聚合本地 provider 状态、模型候选清单、No live ping 边界、Model Recommendations、Skill Injection Matrix、Skill Source & Risk、missing bindings 与 dispatch hint 缺口；只读本地状态，不展示密钥，不写 provider 配置，不接云账号或 SaaS 租户。

最近验证结果：

```bash
node --check public/app.js
node --check tests/e2e/panel-ui-walkthrough.mjs
npm run lint
npm test
git diff --check
HOME=/tmp/xikelab-e2e-52103 PORT=52103 npm start
HOME=/tmp/xikelab-e2e-52103 PLAYWRIGHT_BROWSERS_PATH=/Users/hxx/Library/Caches/ms-playwright PANEL_URL=http://127.0.0.1:52103 npm run test:e2e
lsof -nP -iTCP:52103 -sTCP:LISTEN
```

结果：

- `npm run lint` 通过。
- `npm test` 通过：62 个测试文件 / 325 个测试。
- `git diff --check` 通过。
- e2e 通过：125/125。
- 临时服务端口 `52103` 已停止并确认无监听。

下一步建议：

1. 如果继续做功能，优先 P2 权限治理 UI 闭环：对 plugin / MCP / webhook / provider 等非 Agent Run 高风险入口补 `approvalId` 安全重试，但必须绑定原 action/target，不自动重放危险 shell。
2. 如果先稳定化，按拆分建议提交：Codebase Index 后端与测试、Agent Run 后端与测试、Governance Center / Runs / Codebase Center 前端、e2e 与文档。不要 `git add .`，逐文件审查后分批 stage。
3. 如果继续 P1 Model / Skill Center，只补无副作用 provider health check 历史、最近错误摘要、usage analytics；不要做真实外部 ping 作为默认渲染行为，避免触发账号、额度或网络副作用。
4. 如果回到 P0-A，继续 Tree-sitter/LSP 级证据深化：跨文件/跨语言引用、dynamic import 深化、route -> handler -> service -> test citation path，保持 CodebaseQuestionAnswer 只输出本地证据和限制，不做黑盒总结。

每个阶段完成前必须跑：

```bash
npm run lint
npm test
git diff --check
```

如果改 UI，必须再跑：

```bash
HOME=/tmp/xikelab-e2e-<port> PORT=<port> npm start
HOME=/tmp/xikelab-e2e-<port> PLAYWRIGHT_BROWSERS_PATH=/Users/hxx/Library/Caches/ms-playwright PANEL_URL=http://127.0.0.1:<port> npm run test:e2e
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

注意：启动的测试服务跑完必须停止并确认端口无监听。
