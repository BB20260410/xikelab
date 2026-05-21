# 4 种 AI 协作模式（panel 核心差异化）

panel 不止是"多个 AI 聊天框"。它有 4 种结构化的 AI 协作模式，对应不同任务。

## 💬 1. 单模型聊天 (chat)

**最简模式**。1 个 AI 跟你 1v1 对话，跟用 ChatGPT 网页版差不多。

**适合**：日常问答、写代码、debug、写文档

**特色**：
- 完整对话历史在 panel 里持久化
- 可自由换 AI（同房间内可中途切 adapter）
- ⌘↵ 发送
- 支持 attach 文件 / 拖入

## 🥊 2. 多模型辩论 (debate) ⭐

**让多个 AI 互相挑刺，逼出最优方案**。

**流程**：
- **R1 独立提案**：3 个 AI 各自给方案（互不可见对方答案，防 anchoring）
- **R2 互评修订**：看完对方的方案 → 评分 + 修订
- **R3 终稿表态**：列共识点 + 分歧
- **Judge 合成**：主持人 AI 整合最终共识

**适合**：架构决策、产品定位、技术选型、写作改稿

**示例 topic**：
- "设计一个能扛 10w QPS 的消息推送架构"
- "为我的 SaaS 起 3 个名字"
- "Tailwind vs CSS Modules，给我选择建议"

**特色**：
- 大轮数可配（1-10）
- 每个成员可独立选 adapter
- W5 consensus-detector 实时检测共识（inspector 🔬 Debate tab 看）

## 👥 3. AI 团队拆活 (squad)

**模拟一个开发团队**：PM 拆任务 → Dev 实现 → QA 审查。

**角色**：
- **PM**：拆 topic 为多个 task（带依赖图）
- **Dev**：并行实现各 task（QA 审不过 → 自动返工）
- **QA**：每个 attempt 审查，pass / reject

**适合**：项目落地、代码任务、文档拆写

**示例 topic**：
- "给我的博客加评论系统"
- "把 panel 的 styles.css 拆成 7 个 view 文件"

**特色**：
- W8 squad-diff-preview：第 2+ 次 attempt 可对比 diff
- QA 严格度可调（standard / strict / lenient）
- Task 间依赖图 + 看板 4 列（pending/in_progress/in_review/done/escalated）

## 🌐 4. 多模型联网核对 (arena)

**多 AI 各自给方案 + Judge 联网核实事实 → 合成最准确答案**。

**流程**：
- N 个 AI 背对背给方案
- Judge (Claude with WebSearch) 联网验证哪些 claim 是真的、哪些是 hallucination
- 给出"事实加权"最优答案

**适合**：事实性强的问题、查数据、行业研究

**示例 topic**：
- "2026 年 5 月 macOS 最新版本号 + 主要 feature"
- "对比 React 19 vs Vue 3.5 的性能基准"

**特色**：
- Judge 用真实 web search（Claude WebSearch tool）
- 标 [✓ verified] / [✗ wrong] / [? unverifiable]

## 🔄 房间之间互转（forward）

任何房完成后，可一键转到其他模式继续：

| 当前 | 可转到 | 用途 |
|---|---|---|
| debate done | squad / arena / chat | 把"共识"作为 topic 给团队落地 |
| squad done | arena | 让多 AI 核对实现是否对 |
| arena done | chat | 基于验证结果继续追问 |
| 任何 | chat | 单聊深挖 |

forward 时可选：
- **📚 全部对话历史**（信息量大，新房 AI 看到推理过程）
- **📌 只用最终结论**（更短聚焦）

## 💰 成本提示

- chat：1 个 AI × N 轮 = 最便宜
- debate：N 个 AI × 3 轮 + Judge = 大约 4 倍 chat
- squad：PM + N Dev + QA × M task = 最贵（任务多时）
- arena：N AI + Judge with WebSearch = 中等

panel inspector 右下「累计 $X.XX」实时显示。配 `adapter pricing.js` 估算。

下一步：[mcp-quickstart.md](./mcp-quickstart.md)
