# Xike Lab v2.x → v3.0 演进 Roadmap

> 文档版本：v1（2026-05-21 创建）
> 关联文档：`HANDOFF_v2.0_xikelab.md`、`RELEASE_NOTES_v2.0.md`
> 状态：草案，待你逐项拍板后执行

本 roadmap 基于 2026-05-21 对开源社区的横向调研（多模型 playground / 多 agent 编排 / 多 LLM 辩论 / SaaS boilerplate / Claude Code observability 五个方向），把"能借鉴的思路"映射为 Xike Lab 自身的 5 条演进路径（D1–D5），按依赖关系排成可执行步骤。

---

## 0. 排期总览

| 阶段 | 时长 | 内容 | 目标 |
|------|------|------|------|
| **P0 准备** | 1 天 | 决策 + 立项 + 分支策略 | 不进生产，先开 feature 分支 |
| **P1 双线并行** | 2-3 周 | D1（debate 置信度）+ D4（worker 开源） | 发售前差异化 + 拉社区曝光 |
| **P2 运维向** | 3-5 天 | D3(跨模型成本日历) | 留存功能、付费理由 |
| **P3 体验跃迁** | 1-2 周 | D2(squad 显式角色卡 UI) | 拉非技术用户 |
| **P4 扩展** | 1 周 | D5(本机 CLI 检测接管) | 高级用户粘性 |
| **P5 v3.0 发售** | 1 天 | tag + release notes + 社区铺设 | 商品化 |

**总计：约 6-8 周到 v3.0**。每阶段独立可发，不必走完全程才能停。

---

## P0. 准备阶段（1 天）

### Step 0.1 决策与立项
- 跟你过一遍：是否接受这份 roadmap，要不要砍/换某一阶段
- 决定每个 D 项的 owner（你做还是我做，还是混合）

### Step 0.2 分支策略
```bash
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
git checkout -b v2.x-feat-debate-confidence    # D1
git checkout -b v2.x-feat-worker-template      # D4(基于 main)
git checkout -b v2.x-feat-cost-calendar        # D3(P1 完成后基于 main 拉)
```

### Step 0.3 立基线
- 跑一次 `npm test`（如果有）记录当前测试通过数
- 截一份 `git log --oneline` 当 baseline，每个阶段完成都对比

---

## P1.D1 — debate 模块加置信度量化（核心差异化）

### 目标
把现有的"两个模型吵一架 → 看输出"升级为"**N 个模型给出立场 + 概率投票 + 共识/分歧标记 + 置信度分数**"。

### 参考实现
- [arbgjr/multi-agent-debate](https://github.com/arbgjr/multi-agent-debate) — Bayesian Consensus 范式
- [MALLM](https://github.com/Multi-Agent-LLMs/mallm) — 144 种 debate 配置矩阵
- [Free-MAD paper](https://arxiv.org/pdf/2509.11035) — 反向警示：不强求共识
- [Council Mode paper](https://arxiv.org/pdf/2604.02923) — 三阶段共识结构

### Step 1.1 现状摸底（半天）
- 读 `src/server/services/debate.js`（或对应文件，需先 grep 找）
- 画现状流程图：当前 debate 是 round-robin 还是并发？输出是什么结构？
- **交付物**：`docs/debate-current-flow.md`

### Step 1.2 设计新数据结构（半天）
```typescript
// src/server/services/debate-types.ts(新建)
type DebateRound = {
  roundId: number;
  positions: { model: string; stance: string; confidence: number }[];
  consensusScore: number;   // 0-1,越高越收敛
  divergenceScore: number;  // 0-1,越高越值得保留分歧
};

type DebateResult = {
  rounds: DebateRound[];
  finalConsensus?: string;          // 收敛时给
  retainedDisagreements?: string[]; // 不收敛时给
  bayesianPosterior: Record<string, number>; // 每个立场的后验概率
  meta: { totalTokens: number; cost: number };
};
```
- **交付物**：`src/server/services/debate-types.ts` + 在对话里跟你过一遍

### Step 1.3 实现 Bayesian aggregator（2-3 天）
- 新建 `src/server/services/debate-consensus.js`
  - `computeConfidence(round)` — 用熵 + 方差算单轮置信度
  - `bayesianUpdate(prior, round)` — 多轮后验更新
  - `shouldStopEarly(rounds)` — 何时收敛、何时主动保留分歧(Free-MAD 思路)
- 单元测试 `tests/debate-consensus.test.js`(mock LLM 输出,跑不同收敛/分歧场景)

### Step 1.4 改造 debate 主流程（2-3 天）
- 改 `src/server/services/debate.js`：每轮调用 consensus aggregator，输出新数据结构
- 改 `src/server/routes/debate.js`（API）：返回新结构
- **不破坏旧 API**：加 `?v=2` query 切换，旧 UI 还能用

### Step 1.5 改造 debate UI（2-3 天）
- 改 `public/debate.html`（或对应路径）：
  - 每轮显示各模型的 confidence 条
  - 最终如果不收敛，明确标注 "**分歧保留：以下两种观点都有道理**"
  - 加置信度雷达图（小型 SVG，不引入第三方库）

### Step 1.6 文档 + 录屏（半天）
- 写 `docs/debate-v2-design.md`：原理 + 使用场景 + 适合什么决策
- 录 30 秒 GIF 放官网首页（差异化卖点）

### 验收标准
- [ ] 用同一个问题问 3 个模型，能看到置信度数字
- [ ] 收敛时给出 finalConsensus，不收敛时给出 retainedDisagreements
- [ ] 旧前端不挂（v=1 兼容）
- [ ] 单测覆盖率 ≥ 60%

### 风险
- LLM 输出格式不稳定 → 加 JSON schema 校验 + 重试
- 多轮成本爆炸 → 默认 max 3 轮 + 用户可调

---

## P1.D4 — worker 抽成独立开源 micro-template（拉社区曝光）

> 跟 D1 并行做。D4 不依赖 D1，可以任何时候独立发。

### 目标
把 `worker/src/index.js`(150 行) 抽出来做成可独立部署的 `lemonsqueezy-cloudflare-worker-template`，发布到 GitHub。**填补社区空白**(前面调研发现没有现成 boilerplate 做 LS license API + Cloudflare Worker)。

### Step 4.1 新建独立仓库（半天）
```bash
mkdir -p /Users/hxx/Desktop/00_项目/09_open-source/lemonsqueezy-cf-worker-template
cd /Users/hxx/Desktop/00_项目/09_open-source/lemonsqueezy-cf-worker-template
git init
```
> ⚠️ **跨项目落盘，必须用绝对路径**（CLAUDE.md 红线）

### Step 4.2 复制 + 通用化代码（1 天）
- 拷 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板/worker/src/index.js`
- 删 Xike Lab 专属逻辑（如果有），变量名脱敏（`LS_*` 留通用名）
- 加 `wrangler.toml.example`、`.dev.vars.example`、`README.md`

### Step 4.3 文档（1 天）
README 必须有：
- 60 秒部署指南（带截图）
- HMAC 验签原理图
- LS webhook event 字段对照表
- "为什么不用现成 boilerplate" 章节(点名解决的痛点)

### Step 4.4 测试套件（1 天）
- `test/local-mock.mjs` — 类似 `/tmp/xikelab-worker-test.mjs`，但通用化
- `test/replay-real-event.mjs` — 接受 LS 真实 webhook payload 回放

### Step 4.5 发布 + 反向链接（半天）
- 推 GitHub，加 topics: `cloudflare-workers`, `lemon-squeezy`, `webhook`, `license-validation`
- 发 dev.to 一篇短文 + Hacker News Show HN
- **Xike Lab 官网首页底部加 "Powered by [我们自己开源的] lemonsqueezy-cf-worker-template"** → 反向引流

### 验收
- [ ] 独立 repo 可 `wrangler deploy` 跑起来
- [ ] README 一个完全陌生的开发者能照着 5 分钟跑通
- [ ] Xike Lab worker/ 改成"使用同一个 template"（可选）

### 风险
- 维护两个 worker → 用 git subtree 或保持 panel 内 worker 是 template 的拷贝、定期 sync

---

## P2.D3 — 跨模型成本日历视图（3-5 天）

> P1 完成后做。也可以更早插入，独立性高。

### 目标
panel 加一个「按日 / 按模型 / 按模块」的成本视图，回答用户最高频的问题：「我这个月在 AI 上花了多少？」

### 参考
- [ccusage](https://github.com/ryoppippi/ccusage)
- [codeburn / CCSeva / tokentap](https://www.scriptbyai.com/claude-code-resource-list/)

### Step 3.1 数据层（1 天）
- 检查 panel SQLite `~/.claude-panel/panel.db` 现有表结构
- 如果 events 表没记 `tokens_in/tokens_out/cost`，加 migration
- 写 `src/server/services/cost-aggregator.js`：按天/模型聚合

### Step 3.2 API（半天）
- `GET /api/cost/calendar?from=2026-01-01&to=2026-05-31`
- `GET /api/cost/by-model?period=month`
- `GET /api/cost/by-module?period=week`（chat/debate/squad/arena 分别多少）

### Step 3.3 UI（2 天）
- 新页面 `public/cost.html`
- GitHub-style 热力图日历（纯 SVG，不要第三方库）
- 模型饼图 + 模块堆叠柱状图

### Step 3.4 异常告警（半天）
- 加 `~/.claude-panel/cost-budget.json`（用户自填月预算）
- 超 80% 时 panel 顶部红条提醒

### 验收
- [ ] 打开 panel 能直接看到本月成本 + 同比上月
- [ ] 热力图能下钻到单日明细
- [ ] 跨 4 个模块的成本归因正确

---

## P3.D2 — squad 改成显式角色卡 UI（1-2 周）

> 重大重构，放后面。前面没做完不要碰这块。

### 目标
当前 squad 是 prompt 拆活，对用户是黑盒。改成 CrewAI 范式的「角色卡」：每个 agent 显示 role / goal / tools，用户能拖拽组队。

### 参考
- [CrewAI](https://github.com/crewAIInc/crewAI) — role + goal + tools 范式
- [LangGraph](https://github.com/langchain-ai/langgraph) — 有状态图式编排

### Step 2.1 设计角色卡数据模型（1 天）
```typescript
type AgentCard = {
  id: string;
  role: string;       // "需求分析师" / "前端实现" / "测试"
  goal: string;       // 一句话目标
  model: string;      // 用哪个 LLM
  tools: string[];    // 能用哪些工具
  systemPrompt: string;
};
type Squad = { cards: AgentCard[]; coordination: 'sequential' | 'hierarchical' };
```

### Step 2.2 预设角色库（1 天）
- `src/server/data/agent-presets.js`：10-15 个常用角色卡（产品经理 / 架构师 / 前端 / 后端 / 测试 / 文档...）
- 用户可基于预设改

### Step 2.3 编排引擎（3-4 天）
- 新建 `src/server/services/squad-orchestrator.js`
- 实现 sequential（A → B → C）和 hierarchical（leader → workers）两种模式
- 复用 SendMessage / 消息总线（如果没有就先做一个轻量版）

### Step 2.4 拖拽 UI（3-4 天）
- 改 `public/squad.html`：
  - 左侧角色库
  - 中间画布（拖拽组队，画箭头表示协作方向）
  - 右侧编辑器（点角色卡改 prompt）
- 用原生 HTML5 drag-and-drop，不引第三方库

### Step 2.5 模板分享（1-2 天）
- 用户可导出 squad 为 JSON
- 加 `~/.claude-panel/squads/` 存本地模板
- 之后可以做"社区模板市场"（v3.x）

### 验收
- [ ] 用户能拖出一个 3 角色 squad 跑通"写个简单 Web 应用"
- [ ] 模板可导出、导入
- [ ] 预设的 10 个角色卡至少 7 个开箱即用

---

## P4.D5 — panel 检测本机已装 CLI 接管（1 周）

> 最后做，是锦上添花。

### 参考
- [AionUi](https://github.com/iOfficeAI/AionUi) — 自动检测 Claude Code / Gemini CLI / Codex 等
- [OpenCowork](https://github.com/OpenCoworkAI/open-cowork) — 多 CLI 接管

### Step 5.1 CLI 探针（2 天）
- 新建 `src/server/services/cli-detector.js`
- 检测：`claude`、`gh copilot`、`gemini`、`codex`、`cursor-agent`、`ollama`
- 路径：先 `$PATH`，然后 `~/.local/bin`、`/opt/homebrew/bin`
- 写到 `~/.claude-panel/detected-clis.json`

### Step 5.2 协议层适配（2-3 天）
- 每个 CLI 一个 adapter：`src/server/integrations/cli-adapters/{claude,gemini,...}.js`
- 统一 `invoke(prompt, opts) → Promise<{output, tokens, cost}>`

### Step 5.3 UI 集成（1-2 天）
- panel 顶部加「检测到的本机 CLI」徽章
- chat 模型选择器里把 CLI 当成一个 provider 显示

### Step 5.4 风险与隔离（1 天）
- 调用本机 CLI = 执行外部进程 → 必须沙箱
- 默认 dry-run + 用户确认
- 文档明确"这个功能给高级用户"

### 验收
- [ ] 装了 Claude Code 的机器 panel 能自动识别并加进 provider 列表
- [ ] 调用 CLI 时正确捕获 stdout / 错误码
- [ ] 用户能一键禁用整个 CLI 接管功能

---

## P5. v3.0 发售（1 天）

### Step 5.1 集成测试
- 全跑一遍：chat、debate（新版）、squad（新版）、arena、cost、CLI 接管
- 真发一笔 test mode 订单（v2.1 跳过的那步）

### Step 5.2 文档总装
- 改 `HANDOFF_v2.0_xikelab.md` → 拆成 `HANDOFF_v3.0.md` + `CHANGELOG_v2-to-v3.md`
- 更新官网 `website/` 首页：4 个核心模块改为 v3 卖点（带置信度的 debate、角色卡 squad、成本日历、CLI 接管）

### Step 5.3 release
```bash
git tag v3.0.0-xikelab
gh release create v3.0.0-xikelab --notes-file CHANGELOG_v2-to-v3.md
```

### Step 5.4 社区铺设
- dev.to 长文："How we built a privacy-first multi-AI workbench"
- Show HN：标题强调"local + Bayesian-confidence debate"差异化
- Reddit r/LocalLLaMA、r/ClaudeAI

---

## 整体依赖图

```
P0(决策) ─┬─► P1.D1(debate) ──────────────┐
          ├─► P1.D4(worker 开源)──────────┤
          │                                ├─► P5(v3 发售)
P1 任意完成 ─► P2.D3(成本)──► P3.D2(squad)─┤
                                            │
                              P4.D5(CLI 接管)┘
```

- **强依赖**：P5 需要 P1+P2+P3 至少完成 D1/D3/D2 三块
- **弱依赖**：D4 完全独立、D5 可选
- **任何阶段都可以停发**：v2.1 → v2.2(D1) → v2.3(D3) → v2.4(D2) → v3.0(D5+整合)

---

## 执行入口建议

| 偏好 | 建议先做 |
|------|----------|
| 想最快看到差异化 | **P0 + P1.D1** |
| 想最快拉社区曝光 | **P0 + P1.D4**(约 4 天就能发 Show HN) |
| 想稳着来按顺序 | **P0 → P1.D1+D4 并行** |
| 想先验证商业模型 | **跳到 P5.Step 5.1 里"真发一笔 test mode 订单"那步** |

---

## 全部参考资源（按方向归档）

### 多模型 playground / arena
- [nat/openplayground](https://github.com/nat/openplayground)
- [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)
- [OpenCoworkAI/open-cowork](https://github.com/OpenCoworkAI/open-cowork)
- [CliGate](https://dev.to/codekingai/i-stopped-paying-for-ai-cli-chaos-this-local-gateway-makes-claude-code-codex-and-gemini-work-as-59hl)

### 多 agent 编排
- [CrewAI](https://github.com/crewAIInc/crewAI)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
- [Dify](https://github.com/langgenius/dify)

### 多 LLM 辩论 / 共识
- [Multi-Agent-LLMs/mallm](https://github.com/Multi-Agent-LLMs/mallm)
- [arbgjr/multi-agent-debate](https://github.com/arbgjr/multi-agent-debate)
- [Free-MAD 论文](https://arxiv.org/pdf/2509.11035)
- [Council Mode 论文](https://arxiv.org/pdf/2604.02923)
- [DiMo 论文](https://arxiv.org/pdf/2510.16645)

### SaaS boilerplate / 商品化
- [Open SaaS](https://docs.opensaas.sh/)
- [Firestarta](https://github.com/uixmat/firestarta)
- [Cascade](https://github.com/CodeParrot/cascade)
- [awesome-opensource-boilerplates](https://github.com/EinGuterWaran/awesome-opensource-boilerplates)

### Claude Code observability
- [claude-code-otel](https://github.com/ColeMurray/claude-code-otel)
- [Ultimate Claude Code Resource List 2026](https://www.scriptbyai.com/claude-code-resource-list/)
- [OpenObserve + Claude Code](https://medium.com/devops-ai/openobserve-claude-code-end-to-end-ai-observability-984afcaeba36)

---

## 修订记录

| 日期 | 版本 | 改动 | 作者 |
|------|------|------|------|
| 2026-05-21 | v1 | 初始草案，基于当日开源调研生成 | hxx + Claude |
