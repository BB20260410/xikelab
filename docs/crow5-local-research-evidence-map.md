# Crow5 本地研究证据地图与 Xike Lab 吸收方案

更新时间：2026-05-26 00:41 CST

## 研究边界

本文件只记录本机可访问、用户可拥有或可导出的内容：

- macOS 应用元数据：`/Applications/Crow5.app/Contents/Info.plist`、签名与 notarization 信息。
- 应用 bundle 中的可读配置与技能文本：`default-opencode.jsonc`、`resources/skills/gstack/**/SKILL.md`。
- 用户本机 Crow5 数据目录的结构、数据库 schema、行数、日志元信息、模型缓存数量。
- 公开 UI 观察结论：主工作台、设置、Skills、Provider、审查/文件区、模型/权限控件的布局级信息。
- 不读取或复述用户消息正文、不输出 token/auth 明文、不反编译二进制、不绕过登录/授权/付费/加密/DRM。

没有在 bundle 内发现 `LICENSE` / `NOTICE` / `README` / copyright 文本。许可边界按专有桌面应用处理：可以学习通用架构模式、数据流、配置形态、交互组织和本地治理思想；不能复制 Crow5 的私有前端资源、品牌资产、角色名、文案、二进制实现、付费/授权逻辑或未公开算法。

自检/审查：

- 符合用户要求 1：来源、版本、安装路径、许可边界和分析范围已先确认。
- 符合用户要求 2：分析范围限定为本机可访问内容，不做破解或绕过。

## 1. 来源、版本与安装事实

本机证据：

- 安装路径：`/Applications/Crow5.app`
- Bundle ID：`com.crow5.desktop`
- 版本：`CFBundleShortVersionString = 1.3.13`，`CFBundleVersion = 1.3.13`
- 可执行文件：`/Applications/Crow5.app/Contents/MacOS/Crow5`
- Sidecar CLI：`/Applications/Crow5.app/Contents/MacOS/opencode-cli`
- URL schemes：`crow5`、`opencode`
- 签名：`Developer ID Application: Beijing Netrain technology Co.,Ltd (4TYNTWZC9Y)`
- Notarization：`spctl` 显示 accepted，source 为 `Notarized Developer ID`
- Quarantine 来源：`com.apple.quarantine` 显示通过 Chrome 下载；Spotlight `kMDItemWhereFroms` 没有保留来源 URL

当前运行状态：

- `Crow5` 桌面进程正在运行。
- `opencode-cli --print-logs --log-level WARN serve --hostname 127.0.0.1 --port 56079` 正在运行。
- `lsof` 显示 sidecar 监听 `127.0.0.1:56079`，没有监听公网地址。

自检/审查：

- 事实来自 `Info.plist`、`codesign`、`spctl`、`xattr`、`pgrep` 和 `lsof`。
- 没有使用网络抓包、MITM、私有接口破解或二进制逆向。

## 2. 本地文件结构

应用 bundle：

```text
/Applications/Crow5.app/Contents
  Info.plist
  MacOS/Crow5                 # 约 148 MB，Tauri/桌面主程序
  MacOS/opencode-cli          # 约 196 MB，opencode sidecar/CLI
  Resources/icon.icns
  Resources/resources/default-opencode.jsonc
  Resources/resources/skills/gstack/**/SKILL.md
```

用户数据目录：

```text
~/Library/Application Support/com.crow5.desktop
  .window-state.json
  default.dat
  opencode.global.dat
  opencode.settings.dat
  opencode.workspace.*.dat
  bundled/skills/gstack/**/SKILL.md
  opencode/
    models.json
    opencode.jsonc
    auth.json                 # 存在，但研究中不读取明文
    opencode.db
    opencode.db-wal
    opencode.db-shm
    storage/session_diff/
    storage/migration
    tool-output/
    version
```

当前本机统计：

- `models.json`：约 2.08 MB，135 个 provider，4849 个 model 条目。
- `opencode.db`：约 2.47 MB。
- `tool-output/`：11 个文件，约 3.22 MB。
- `storage/session_diff/`：55 个文件，很小，主要作为 session diff 占位/索引。
- `.window-state.json`：记录主窗口最大化，1920 x 1280，`visible=true`。
- `default.dat`、`opencode.global.dat`、`opencode.settings.dat`、`opencode.workspace.*.dat` 均为 JSON data，说明 Tauri store / workspace store 也采用本机可读 JSON 存储形态。

自检/审查：

- 结构来自 `find`、`ls`、只读统计脚本。
- `auth.json` 只确认存在和大小，不读取、不写入、不输出。

## 3. 配置机制

核心配置文件：

- Bundle 默认配置：`/Applications/Crow5.app/Contents/Resources/resources/default-opencode.jsonc`
- 用户运行配置：`~/Library/Application Support/com.crow5.desktop/opencode/opencode.jsonc`

默认 provider：

- `crow5_international`
- `crow5_china`
- 二者均使用 OpenAI-compatible provider 形态，`baseURL = https://api.crow5.com`，并启用 `setCacheKey` 和 `cache=system`。

默认 collaboration 配置：

- Chief Agent：`reinhard`
- Default sub-agents：`rem`、`emilia`
- On-demand agents：`mario`、`chunli`、`ayanami`、`zhaoyun`、`sora`
- Skill registry：22 个条目
- Agent-skill bindings：8 组
- Dispatch rules：7 条
- Response policy：显示本次使用技能，标签为“本次使用技能”

关键设计模式：

- Provider 抽象和模型列表分离。模型缓存可大规模更新，provider 只定义连接方式。
- Agent / Skill / Dispatch / Response Policy 均配置化，而不是散落在 prompt 文案里。
- 用户配置和 bundle 默认配置分开，支持应用升级后仍保留用户本地状态。

默认配置与用户运行配置结构对比：

- 二者顶层 key 一致：`$schema`、`collaboration`、`disabled_providers`、`provider`。
- 二者 provider id 一致：`crow5_china`、`crow5_international`。
- 二者 collaboration 主结构一致：chief agent、default sub-agents、on-demand agents、22 个 skill registry 条目、8 组 agent-skill binding、7 条 dispatch rule。
- 当前用户配置没有禁用 provider。

自检/审查：

- 只读取 JSONC 中的结构字段和非敏感 baseURL。
- 用户配置只抽取 provider/model/agent/skill/permission 等行，并做 token/key 字段脱敏。

## 4. Agent 与 Skill 体系

默认 Agent 结构：

| Agent | 类型 | 绑定技能 | 可学习的职责形态 |
| --- | --- | --- | --- |
| `reinhard` | chief | 无固定绑定 | 统筹、计划、汇总、决定是否派发 |
| `rem` | default sub-agent | `codex`, `review` | 实现、代码问题、二次判断、评审 |
| `emilia` | default sub-agent | `qa`, `qa-only`, `browse`, `office-hours` | QA、浏览器验收、产品/商业判断 |
| `mario` | on-demand | `codex`, `ship` | 交付、PR、发版 |
| `chunli` | on-demand | `plan-eng-review`, `plan-ceo-review`, `retro`, `autoplan` | 架构、产品范围、复盘、评审流水线 |
| `ayanami` | on-demand | `investigate`, `benchmark` | 根因分析、性能基准 |
| `zhaoyun` | on-demand | `setup-deploy`, `land-and-deploy`, `canary`, `ship`, `careful`, `cso` | 部署、安全、生产验证 |
| `sora` | on-demand | `design-consultation`, `design-review`, `plan-design-review`, `document-release` | 设计、文档、发布表达 |

Dispatch rule 形态：

- QA / test / validation / browser / report / product idea -> QA agent。
- implement / feature / code / review / quality -> builder agent。
- delivery / PR -> shipper agent。
- architecture / system-design / scope / strategy / retro -> architect/reviewer agent。
- bug / debug / root-cause / performance -> investigator agent。
- deploy / release / production / security / destructive -> release/security agent。
- UI / UX / visual / docs / changelog -> designer/documentation agent。

Bundle 中实际存在 20 个 `gstack` skill 文本目录；默认配置的 registry 有 22 个 skill 条目，说明配置层可引用比 bundle 文本更宽的技能集合，或由用户/远端/运行时补齐。用户数据目录中复制了一份同名 bundled skills。

Skill 文件形态：

- `SKILL.md`
- YAML frontmatter：`name`、`description`，部分有 `version`、`allowed-tools`
- Markdown body 描述执行流程、检查点、停止条件、证据要求

Skill inventory 观察：

- 大多数 `gstack` skill 体量在 23 KB 到 85 KB 之间，属于“完整操作手册”级别，而不是一两段 prompt。
- `ship`、`plan-ceo-review`、`office-hours`、`design-review`、`plan-eng-review` 等技能较大，说明交付、战略/产品评审、设计评审被当成复杂流程处理。
- `setup-browser-cookies` 只有约 2.7 KB，属于窄用途 setup skill。
- `codex` skill frontmatter 明确出现 `allowed-tools: Bash`，说明技能层可以声明工具权限。
- 多数大型 skill 共享一组通用章节：先执行 preamble、提问格式、完整性原则、repo ownership、search-before-building、contributor mode、复现步骤模板等。这是一种“全局工作纪律 + 领域技能正文”的复合结构。
- 20 个 bundle skill 均有 frontmatter；字段覆盖：`name` 20/20、`description` 20/20、`version` 1/20、`allowed-tools` 1/20。总字节数约 755 KB，平均约 37.8 KB。

可借鉴点：

- Skill 是可读文档，不是黑盒插件。
- Skill 与 Agent 绑定，避免一次性注入所有技能。
- Dispatch 先按任务 tag 做确定性候选，再交给模型执行。
- Skill 重复、权限、可用性需要诊断；日志中已经出现 duplicate skill warning。
- Xike Lab 的 skill loader 应保留体量上限、冲突检测、权限声明和来源解释，否则大技能集合会快速污染 prompt。

自检/审查：

- 只读 bundle 与用户目录中的 `SKILL.md` 元信息，没有复制技能正文。
- Xike Lab 已经用自己的 `xike-*` profile 替代 Crow5 角色名，后续也应继续避免直接使用 Crow5 品牌角色。

## 5. CLI、Sidecar 与运行时数据流

`opencode-cli --help` 暴露的能力：

- TUI / attach / run
- `serve` / `web`
- `providers` / `models`
- `agent`
- `mcp`
- `session`
- `db`
- `stats`
- `export` / `import`
- `github` / `pr`

这说明 Crow5 Desktop 的底座不是单纯 WebView，而是：

```text
Tauri native shell
  -> WebView frontend
  -> local opencode sidecar on 127.0.0.1:<port>
  -> SQLite session/message/part/project/permission
  -> provider/model layer
  -> agent + skill + tool runtime
  -> tool-output/session_diff files
```

日志证据：

- 启动时记录 `Spawning sidecar on http://127.0.0.1:<port>`。
- 第一次启动执行数据库迁移，并记录 migration complete。
- Sidecar 记录 `opencode server listening on http://127.0.0.1:<port>`。
- provider diagnostic 记录 `hasEnv/hasAuth/hasConfig` 等可用性维度。
- session prompt 日志记录 `sessionID`、`messageID`、`providerID`、`modelID`、`agent`、`step`、`maxSteps`、`sourceMessages`、`contextMessages` 等调度元信息。
- LLM 错误会记录 provider/model/session/agent 和错误类别；本机样本里出现过 usage limit exceeded。
- skill duplicate warning 记录 skill name、existing path、duplicate path、rank。

自检/审查：

- 日志分析只输出元信息和计数，不输出用户 prompt 正文。
- 发现 CLI `db path` 默认指向 `~/.local/share/opencode/opencode.db`，而 Crow5 Desktop 实际使用 `~/Library/Application Support/com.crow5.desktop/opencode/opencode.db`；后续工具脚本必须显式传 Crow5 Desktop 数据路径，不能误读普通 opencode 默认路径。

## 6. SQLite 数据模型

只读 schema 检查显示表：

- `project`
- `session`
- `message`
- `part`
- `todo`
- `permission`
- `session_share`
- `workspace`
- `account`
- `account_state`
- `control_account`
- `__drizzle_migrations`

当前行数：

- `session`: 55
- `message`: 239
- `part`: 615
- `todo`: 4
- `project`: 1
- `permission`: 0
- `account` / `control_account`: 0
- `__drizzle_migrations`: 9

Migration 与索引：

- 已应用 9 个 migration，名称包括 `20260127222353_familiar_lady_ursula`、`20260211171708_add_project_commands`、`20260225215848_workspace`、`20260227213759_add_session_workspace_id`、`20260303231226_add_workspace_fields`、`20260309230000_move_org_to_state`、`20260312043431_session_message_cursor` 等。
- 显式索引包括 `message_session_time_created_id_idx`、`part_message_id_id_idx`、`part_session_idx`、`session_project_idx`、`session_parent_idx`、`session_workspace_idx`、`todo_session_idx`。
- 这些索引说明查询热点集中在按 session、message、project、workspace 做时间线和关联读取。

关键结构：

- `session` 保存 project、parent、title、version、summary、permission、workspace、archive/compact 时间。
- `message` 保存 session 下的消息 envelope。
- `part` 保存消息片段，适合承载 text、reasoning、tool-call、tool-result 等分段。
- `permission` 以 project 为主键保存权限策略。
- `todo` 以 session + position 记录任务项。
- `session_share` 和 account 相关表证明分享/账户能力存在结构基础，但当前本机没有账户记录。

对 Xike Lab 的启发：

- 不要只把模型输出当日志；应拆成 run/message/part/tool-result 级记录。
- 会话 summary、diff、permission、workspace 应与 session 强关联。
- 任务计划/todo 应作为会话内一等对象，不只存在 prompt 文本中。

自检/审查：

- 使用 SQLite readonly URI；只读取 schema 和 count。
- 没有读取 `message.data`、`part.data`、`session.title` 等可能含用户内容的字段。

## 7. 日志与可观测性

本机日志文件：

- `opencode-desktop_2026-05-24_12-46-24.log`：约 1.2 MB，3146 行。
- `opencode-desktop_2026-05-25_10-09-42.log`：约 657 KB，1837 行。
- `opencode-desktop_2026-05-25_22-50-05.log`：约 1.3 KB，15 行。
- `opencode-desktop_2026-05-25_23-22-12.log`：约 263 KB，741 行。

Tool output 元信息：

- `tool-output/` 当前有 11 个文件，总计约 3.22 MB。
- 单文件大小范围约 86 KB 到 451 KB。
- 修改时间集中在 2026-05-24 07:16:47Z 到 2026-05-24 07:17:08Z。
- 本文档只记录大小和时间，不读取工具输出正文。

日志维度：

- sidecar 启动与监听
- database migration
- provider diagnostic
- model selection
- session prompt / processor
- agent id
- tool schema / tools
- token usage / cost / quota
- cache
- permission
- duplicate skill warning
- error / warn

可借鉴点：

- 日志里保留足够多的结构化字段，便于定位“哪个 agent、哪个 model、哪个 provider、哪个 session、哪一步”。
- 错误不是纯文本堆栈，而是带 provider/model/statusCode/usage limit 等可 UI 化字段。
- Provider diagnostic 可以在 UI 中转成“未配置 env / auth / config”的明确提示。

自检/审查：

- 只统计日志维度和抽取脱敏样例。
- 不把日志中的用户 prompt、工具输出正文、token 明文写入文档。

## 8. UI 界面布局与交互模式

当前 UI 结构来自本机已运行 Crow5 的公开界面观察记录、窗口状态、日志元信息，以及 2026-05-25 通过 Computer Use 获取的 AX 层级快照。AX 快照包含用户历史会话正文，因此本文件只记录控件、区域和布局，不引用会话内容，也不保存截图文件。

布局模式：

- 左侧：项目 / 会话入口，强调“从项目和会话继续工作”。
- 中区：主对话时间线，多 Agent 的输出和错误以会话事件呈现。
- 右侧：审查区 / 文件树 / 文件变化，支撑用户检查 AI 具体改了什么。
- 底部输入区：自然语言输入，同时承载模型、Skill、权限/自动接受等运行控制。
- 设置区：Provider、模型、自定义模型、Skill、Agent 绑定、通知和用量。
- 启动/空状态：引导用户从自然语言 idea 进入 Plan / Build / QA / Ship。

AX 层级可见控件：

- 顶部栏：侧边栏切换、项目下拉、`WELCOME TO CROW5` 标题、`项目启动`、`项目移交`、`服务器状态`、审查/文件树切换。
- 左侧项目与系统区：项目列表、`打开项目`、`运行`、`调试`、`定时任务（即将开放）`、`存档`、`数据库（暂未开放）`、`可视化Memory Banck（即将开放）`、`超级工作站（即将开放）`、`切换终端`、`设置`、`帮助`。
- 主内容区：session 标题、上下文用量按钮、更多选项、消息时间线、子 Agent 按钮、分叉/重置/复制消息动作。
- 输入区：文本输入框、协同模式开关、优化输入、发送、附件、Shell 标识、模式下拉、模型下拉、Skills 下拉、自动接受权限开关。
- 右侧证据区：`审查` tab、`打开文件`、`会话变更` 下拉、创建 Git 仓库提示、`0 更改` / `所有文件` tabs、文件变更提示图例。
- 通知/辅助区：Notifications 容器、本地项目标识、部分 disabled 的扩展功能开关。

交互模式：

- 自然语言负责表达目标，GUI 负责约束风险和展示证据。
- Agent 可视化让用户知道“谁在做什么”，而不是只有一个聊天角色。
- 文件变化和审查区让用户在执行中检查 diff，而不是执行后才看 git。
- 模型/provider/usage/permission 与输入框靠近，降低配置和成本不透明。
- 错误和配额问题作为会话事件出现，能和当前任务关联。

Xike Lab 可借鉴布局：

- 第一屏改成本地工作台，而不是营销页或功能入口集合。
- 保留左侧工作台/治理/系统入口，但主路径应是 `Idea -> Plan -> Work -> Verify -> Archive`。
- 中区是任务与 Agent Run 时间线，右侧是证据栏：文件变化、Codebase Index 命中、审批/预算、测试结果。
- 底部输入区展示模型、Agent、Skill、权限范围、预算预估。

自检/审查：

- UI 部分只保留布局和交互抽象，不复制 Crow5 视觉资产、品牌名、角色名或具体文案。
- AX 快照证明 UI 布局不只是旧文档推断；敏感会话正文未写入本文档。
- 若后续需要截图级 UI 证据，应先切到空项目或遮蔽会话正文，再保存截图。

## 9. Crow5 能力清单

已证实或有强本机证据的能力：

- 桌面应用：Tauri 风格原生壳 + WebView + local sidecar。
- 本地 sidecar：`opencode-cli serve` 在 127.0.0.1 监听。
- 本地持久化：SQLite session/message/part/project/todo/permission/workspace schema。
- 数据迁移：Drizzle migrations 表和启动日志 migration。
- 多 Agent 配置：chief、default sub-agents、on-demand agents。
- Skill registry：`SKILL.md` 文档型技能、Agent 绑定、dispatch tag。
- Dispatch rules：任务 tag 到 agent 的配置化映射。
- Provider/model 生态：OpenAI-compatible provider 和大型 `models.json` 缓存。
- CLI：agent/provider/model/session/db/stats/export/import/mcp/github/pr 等命令。
- 工具输出外置：`tool-output/` 文件存储，避免全部塞入会话正文。
- session diff：`storage/session_diff/` 记录会话关联文件变化。
- 轻状态 JSON store：`.dat` 文件保存全局、设置和 workspace 状态，适合窗口/工作区轻状态。
- 权限结构：DB 有 permission 表，CLI agent list 暴露 allow/ask/deny 权限规则。
- 可观测性：日志记录 sidecar、provider、model、agent、session、tools、usage、cache、errors。
- UI 工作台：项目/会话、timeline、审查/文件变化、输入区模型/Skill/权限、设置 Provider/Skill/Usage。

未证实或证据不足的能力：

- 完整源码级算法实现：bundle 没有暴露源码，不能声称已掌握内部算法。
- 完整 AST/LSP/向量索引实现细节：本机只看到 codesearch/tool/schema/产品表现和数据结构线索。
- 付费授权、登录、加密、DRM 的内部实现：不分析。
- 云端 API 行为：不抓包、不模拟、不绕过。

自检/审查：

- 清单区分“已证实”和“未证实”，避免把推断写成事实。

## 10. 合法可借鉴模式与禁止复制内容

可以借鉴或自研替代：

- `Agent Registry + Skill Registry + Dispatch Rules` 的架构模式。
- `SKILL.md + frontmatter + Markdown body` 的技能文件形态。
- “绑定少量技能到特定 Agent，而不是全量注入”的治理策略。
- “本地 SQLite session/message/part/tool-output/session_diff”的数据组织思想。
- “sidecar + WebView + local HTTP”的桌面架构边界。
- Provider/model registry、模型缓存、健康检查、用量提示。
- Provider diagnostic、duplicate skill warning、usage/quota/error UI 化。
- UI 的三栏工作台思想：任务时间线 + 文件/审查证据 + 输入控制。

必须自研、不能照搬：

- Crow5 二进制、前端资源、品牌、图标、角色名、视觉文案。
- Crow5 私有模型网关、付费、登录、授权、加密、DRM 相关逻辑。
- 未公开的 Agent 调度 runtime、内部 prompt、私有工具实现。
- 任何用户账号、token、auth、session 正文、云端请求正文。
- 任何需要反编译或绕过保护才能获得的实现。

Xike Lab 的原则：

- 用自己的 `xike-*` Agent profile。
- 用本地 SQLite / JSON store / ActivityLog / Approval / Budget / Delegation 原语。
- 让所有吸收能力可测试、可审计、可回滚。
- 不做 SaaS 多租户，不做企业雇佣/HR agent，不做云索引默认上传。

自检/审查：

- 合法边界覆盖用户明确禁止的 Crow5 授权/付费/登录/加密/DRM。
- 对可复刻内容只描述模式，不复制私有实现。

## 11. Xike Lab 自研替代方案

### Agent / Skill

- `AgentSkillRegistry` 保持 Xike 自有 profile：`xike-chief`、`xike-builder`、`xike-verifier` 等。
- `dispatchTags` 使用确定性规则 + code context signals，输出可解释原因。
- Skill 注入保留来源：profile、dispatch、room。
- Skill 诊断覆盖过多技能、prompt 过大、冲突/互斥组。

### Session / Run / Activity

- `AgentRunStore` 作为 Crow5 session/message/part 的 Xike 替代，但保留 Xike 的 budget/approval/delegation/autopilot 链路。
- 每个 run 记录：profile、skills、model、budget policy、approval id、delegation id、related activity。
- run export 输出 JSON/Markdown，供归档和审计。

### Codebase Index

- 用 `CodebaseIndexStore` / `CodebaseMap` / `CodebaseQueryEngine` / `SymbolGraph` 自研替代 codesearch。
- 继续走本地索引，不上传源码。
- 已新增 rebuild 级 per-file evidence cache、内存 SQLite FTS5/BM25 排序层、TS/TSX/JSX AST 解析、named/default/re-export/renamed import 绑定、本地 SQLite snapshot 持久化，以及查询结果 citation chain；后续继续补 LSP/Tree-sitter、更多 TS 类型引用、VectorIndex 融合和代码问答 UI。

### Permission / Governance

- 用 `PermissionGovernance.evaluatePermission()` 统一 shell/file/network/plugin/MCP/provider/model config 等高风险动作。
- 审批后允许安全重试 HTTP/API 操作，但危险终端命令不自动重放。
- Activity 中保留 permission decision 和 agentRunId，形成 run 级时间线。

### UI 主路径

- 主页聚焦 `Idea -> Plan -> Work -> Verify -> Archive`。
- Agent Center 展示谁会做、为什么、技能和治理策略。
- Codebase Center 展示路径、行号、reason、symbols/routes，不做黑盒总结。
- Governance Center 统一审批、预算、审计、委派、Agent Run。

自检/审查：

- 方案均映射到 Xike Lab 现有模块或明确的自研模块，没有要求复制 Crow5 私有实现。

## 12. P0-P9 实施路线

### P0：Agent Run 与 Codebase Index 打穿

- Agent Run：补强 run 与 Activity/approval/delegation/budget 的双向跳转、筛选、失败/重试链路。
- Codebase Index：SQLite FTS/BM25、rebuild 级 per-file evidence cache、TS/TSX/JSX AST、import/export 绑定、本地 SQLite snapshot 和 citation chain 已进入未提交增量；继续完成 LSP/Tree-sitter、更多 TS 类型引用、VectorIndex 融合和 code question UI。
- 验收：用户问“某功能在哪里实现”返回路径、行号、reason，并能进入 Agent prompt；一次任务能看到谁做了什么、是否被阻断。

### P1：Idea-to-Archive 主流程

- 新建 Idea 入口：一句话 -> plan preview -> 建议 Agent/Skill -> 预算/审批预估 -> 执行。
- 执行后归档：目标、文件、Agent runs、预算、审批、测试、截图、后续行动。
- 验收：一个小任务可完整从输入到归档。

### P2：Governance Center 统一入口

- 汇总 approvals、budget incidents、delegations、autopilot jobs、permission decisions、agent runs。
- 支持从任一事件跳到 run/profile/room/file evidence。
- 验收：任何高风险动作都有 who/what/why/approval/result/cost。

### P3：Model / Provider Center

- Provider registry：状态、最近使用、模型缓存、健康检查、错误摘要。
- Model picker：按 task tag 推荐模型，支持本地/隐私/低成本偏好。
- 验收：用户不改 JSON 也能知道 provider 是否可用、模型为什么被选。

### P4：Skill Center 本地版

- Skill 分类、来源、启用/禁用、Agent 绑定、冲突/重复诊断、usage analytics。
- 验收：同名重复 skill 有提示，禁用 skill 不会进入 prompt。

### P5：Workspace / Session / Part 数据模型收敛

- 把 room/session/message/tool result/report 的长期记录收敛到明确 schema。
- 引入 migration versioning 和 WAL/备份策略。
- 验收：升级后旧库自动迁移，run export 与 archive 不丢字段。

### P6：桌面壳与 sidecar 试验

- 不立即迁移主项目；先做 Tauri/sidecar demo。
- 明确 Electron 与 Tauri 的窗口、更新、deep link、权限边界取舍。
- 验收：demo 能启动/停止 Node sidecar 并显示健康状态。

### P7：可观测性与成本诊断

- UI 化 prompt tokens、tool-output 裁剪、cache hit、provider latency、quota 错误。
- 验收：一次失败模型调用能显示 provider/model/status/retry 建议。

### P8：插件/MCP 权限 SDK 化

- 统一 plugin/MCP manifest、权限声明、审批动作、审计事件。
- 验收：插件安装/执行/配置都经过 allow/ask/deny，并能回放审计。

### P9：商业化但保持本地优先

- License/Pro 能力与本地工作流关联，但不做 Crow5 式复制。
- 保留本地数据、用户自带 provider、本地模型、导出归档。
- 验收：付费边界不破坏本地治理和数据所有权。

自检/审查：

- P0-P9 覆盖用户要求的路线粒度。
- 路线优先补 Xike Lab 当前缺口，不把项目改成 SaaS。

## 13. 不需要用户授权、可自行继续确认的事项

后续可以继续自行做，仍在合法/本机范围内：

- 在空项目或遮蔽会话正文后重新采集 UI 截图，用于布局证据。
- 检查 sidecar 本地端口的公开 OpenAPI/health 元信息，如果不需要鉴权且不返回用户正文。
- 对 Xike Lab 已实现能力做差距矩阵：Crow5 pattern -> Xike module -> missing tests。

本轮已自行完成的确认：

- `default-opencode.jsonc` 与用户 `opencode.jsonc` 的结构对比。
- bundled skills 的 frontmatter 字段覆盖率、allowed-tools 分布和体量统计。
- SQLite readonly migration 名称、表索引、字段类型与表行数统计。
- tool-output 文件数量、大小范围、总量和修改时间统计。

不应自行做：

- 读取/输出 `auth.json` token。
- 导出或复述用户历史会话正文。
- 抓取云端请求正文、绕过 TLS 或模拟付费接口。
- 反编译、patch 或破解 app/sidecar。
- 复制 Crow5 角色名、品牌、图标、前端资源或私有文案。

## 14. 完成度审计

| 用户要求 | 当前证据 | 状态 |
| --- | --- | --- |
| 确认来源、版本、安装路径、许可边界、可分析范围 | 第 1、2 节 | 已完成 |
| 只分析本机可访问内容 | 研究边界、每节自检 | 已完成 |
| Crow5 能力清单 | 第 9 节 | 已完成 |
| 可借鉴设计模式与 UI 布局 | 第 8、10 节；第 8 节已补 AX 层级控件证据 | 已完成 |
| Xike Lab 自研替代方案 | 第 11 节 | 已完成 |
| P0-P9 实施路线 | 第 12 节 | 已完成 |
| 不需用户授权可继续确认事项 | 第 13 节；结构对比、skill 统计、SQLite migration/index、tool-output 元信息已自行确认 | 已完成 |
| 每完成一个内容自检和代码审查 | 各节自检/审查 | 已完成 |

剩余可选增强：

- 在空项目环境补 UI 截图证据。
- 把本文件拆成机器可读 JSON evidence index。
- 将 P0-P9 路线转成 Xike Lab issue/backlog 或本地 task graph。
