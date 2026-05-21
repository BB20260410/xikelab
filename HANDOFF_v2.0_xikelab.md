# 🎁 Xike Lab v2.0 — 新会话接手文档

> 复制本文件全文给新 Claude 会话作为第一条消息，新会话能立刻接手项目工作。
> 创建时间：2026-05-21（v2.0 文档）
> 末次更新：2026-05-21（v2.1 增量 — LS 集成全打通后回填，按 commit 自述更新，未实测）
> 项目路径（绝对）：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板/`

---

## ⚡ 30 秒接手

```bash
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
git log --oneline | head -10      # 看最近改动
git tag -l 'v*-xikelab' | tail    # 找最新 tag
curl http://127.0.0.1:51735/api/commercial/status | python3 -m json.tool  # 看商品化进度（panel 必须在跑）
```

如果 panel 没跑：`lsof -ti tcp:51735 || (PANEL_VERSION=2.0.0 nohup npm start > /tmp/panel.log 2>&1 &)`

---

## 🎯 项目是什么

**Xike Lab**（息刻实验室）— 本地多 AI 工作台。
- 8+ AI provider（Claude/GPT/Gemini/MiniMax/Ollama 等）
- 4 种 AI 协作模式：chat / debate / squad / arena
- MCP 一站式 + Autopilot 自驾 + 向量语义搜索
- macOS Electron 桌面应用 + 浏览器 :51735 双模式
- 数据全本地 `~/.claude-panel/` 权限 0o600
- 商品化：Free / Pro $19 / Team $49（一次性买断）

**用户**：hxx（中国，注册主邮箱 `ilifelahepeq54@gmail.com`，GitHub `BB20260410`）

---

## 📊 当前状态

### 代码（19/19 task 全完成 + v2.1 LS 集成 4 commit 增量）

| 阶段 | tag | 内容 |
|---|---|---|
| v1.0 | `v1.0.0` | Sentry-compat ErrorReporter + electron-builder + auto-update + i18n + onboarding |
| v1.1 | `v1.1.0-final` | Analytics + telemetry consent + 5 篇 docs |
| v1.5 | `v1.5.0` | Ed25519 离线 License + Pro/Free 分级 + LS/Polar webhook |
| v2.0 | `v2.0.0-shipping` | SQLite + 向量搜索 + 多 workspace + Pino 日志 |
| 改名史 | `v2.0.0-xikelab`（最新 tag）| Claude Panel → Roundtable → Hangora → Xikely → **Xike Lab** |
| v2.1 增量 | 未 tag（4 commit 在 main） | LS 集成全打通（详见下表） |

**v2.1 增量 commit（HEAD 上的 4 个，未打 tag）**：

| commit | 内容 |
|---|---|
| `3907eee` | Keychain 密码代理 endpoint — panel 自动填密码到 Chrome，密码不进 LLM 对话 |
| `256e69d` | LS API 集成（5 endpoint + LemonSqueezyClient.js），token 移到 `~/.claude-panel/` 0o600 |
| `ad992d8` | 官网（Cloudflare Pages）+ Worker webhook + LS webhook 自动注册（5 问题 1 次解决） |
| `8f20b8c` | playwright 自动建 LS Pro product（最终用 Chrome JS via Apple Events 完成） |

### 测试 175/175 全过（v2.0 基线，v2.1 commit 仅声明全过未额外补 case）

```
4 套 smoke   : 68/68 ✅
vitest      : 65/65 ✅
e2e         : 35/35 ✅
LIVE 端到端  : 7/7  ✅（签发→激活→tier 升级→squad 房→workspace 拒→向量搜→Pino 日志）

⚠️ v2.1 收钱链路（官网 → checkout → Worker → license → 邮件）未实测真订单
```

### 商品化进度（2026-05-21 状态机修复后实测）

```
panel /api/commercial/status:  5/6 = 83%

✅ licenseKeys     Ed25519 私钥（~/.claude-panel-keys/）
✅ githubToken     gh CLI 已登录 BB20260410（fallback 查 ~/.config/gh/hosts.yml）
✅ lemonWebhook    secret 存 ~/.claude-panel/ls-webhook-secret.txt（fallback 路径）
❌ polarWebhook    可选，跳过（用户决定不做）
✅ sqliteMigrated  panel.db 已建
✅ pricingPage     /pricing.html + website/index.html 全完成

状态机修复（2026-05-21）：commercial-setup.js 行 22-26 + 30 加 fallback：
- githubToken: 查 ~/.config/gh/hosts.yml（gh CLI 路径）
- lemonWebhook: 查 ~/.claude-panel/ls-webhook-secret.txt（v2.1 secret 单文件路径）
未打 commit/tag（等本轮实测全过后一次性 commit）
```

收钱基础设施（v2.1 新增 ad992d8 / 256e69d / 8f20b8c）：

```
Lemon Squeezy:
✅ Account     用户 5/18 早已注册，store 'hxx' (ID 379358) plan=free CN
✅ API token   ~/.claude-panel/lemonsqueezy-key.txt (0o600)，永不进 LLM 对话
✅ Product     1074614 'Xike Lab Pro' status=published price=$19（顺带 store 还有 DuetCheck Pro 1065158，无关项目）
✅ Checkout    https://hxx.lemonsqueezy.com/checkout/buy/5809ccc9-20aa-4d63-9f8f-3754d85ab28e
✅ Webhook     ID 102447 → Cloudflare Worker
   ⚠️ testMode=true（需切 production 才能收真订单 webhook）
   ⚠️ lastSentAt=null（从未触发过，整链路从未真跑过）
   订阅事件: order_created / subscription_created / subscription_payment_success

Cloudflare:
✅ Pages       https://xikelab.pages.dev/（官网，免费域名）
✅ Worker      https://xikelab-webhook.ilifelahepeq54.workers.dev
   Routes      POST /webhooks/lemon + GET /api/license/verify + GET /health
   Secrets     LS_API_TOKEN + LS_WEBHOOK_SECRET（永不进对话）

Keychain (macOS):
✅ 8 站点密码代理 endpoint (/api/auto-fill/password)
   LLM 调 endpoint → osascript 自动填到 Chrome 当前焦点框，密码不进 LLM

GitHub:
✅ Repo:   https://github.com/BB20260410/xikelab
✅ Releases: v1.0.0 / v1.5.0 / v2.0.0 三个（含完整 release notes）
✅ Branch main + 10+ tags 全 push
```

⚠️ **未实测项 + 真实链路（关键，commit message 说的与代码实际不一致）**：

真实收钱链路（读 worker/src/index.js + src/server/routes/lemonsqueezy.js 后确认）：

```
买家付款 → LS 用 LS 自己的 license-keys 系统签发 license（不是本机 Ed25519！）
        → LS 邮件买家（LS 内置）
        → LS POST webhook → Cloudflare Worker /webhooks/lemon
        → Worker 只验 HMAC + log（不签发，不调 panel）
        → 买家 paste license 到 panel UI
        → panel 调 Worker /api/license/verify?key=...
        → Worker 转发到 LS API /v1/licenses/validate
        → 返回 valid 与否
```

含义：
- v1.5 Ed25519 私钥（~/.claude-panel-keys/）**当前未在 LS 主链路上**，仅作 fallback / 离线 / 自签发模式
- panel 本机不需要外部可达 — Worker 才是 LS webhook 收件人
- 整链路从未实跑（webhook lastSentAt=null + testMode=true）

未实测项 = LS test mode 下一笔真订单 → 看 Worker `wrangler tail` 是否收到 → 看买家邮箱是否收到 LS license 邮件 → paste 到 panel 验证 verify endpoint 返回 valid

### 外部账号

| 账号 | 状态 | 备注 |
|---|---|---|
| GitHub | ✅ 已登录 `BB20260410`（gh CLI token: repo+workflow scope）| 本机 `~/.config/gh/hosts.yml` |
| Payoneer | ✅ 收款账户已开通 | Gmail 邮件确认过 |
| Apple Developer | 🟡 用户在做（另一项目「息刻」iOS App，App Store Connect tab 已开）| 跟 Xike Lab 共享品牌 |
| **Lemon Squeezy** | ✅ **已开店 + Pro product 已发布** | store ID 379358，product 1074614，token 0o600 本地存 |
| Cloudflare | ✅ 已登录（`ilifelahepeq54@gmail.com`）| Pages + Worker 双部署，免费层 |
| Polar.sh | ❌ 可选，需 Stripe US | 跳过（用户决定不做） |
| Keygen | ❌ 跳过（panel 自实现 license） | — |
| 域名（xikelab.com / .ai）| ⏸️ 推迟 | 用 `xikelab.pages.dev` 免费域名占位，赚到钱再买 |
| 商标（USPTO Class 9+42）| ⏸️ 推迟 | $350 + 律师 $500-1500，用户决定赚到钱再注册 |
| macOS Keychain | ✅ 8 站点密码已存 + 代理 endpoint | `./scripts/setup-keychain-passwords.sh` 一次 setup 永久免密 |

---

## 🏷 品牌信息（用户严令）

| 维度 | 值 |
|---|---|
| 产品名 | **Xike Lab**（带空格显示）|
| npm/git/appId | `xikelab` |
| 中文 | 息刻实验室 |
| 起源 | Xī Kè 拼音 + Lab 后缀 |
| 商标搜索结论 | USPTO + Google 0 商业冲突 |
| Logo | X 字母 + 中心刻点 + 外圆环 + 4 协作点（public/assets/logo.svg）|
| 主色 | `#10b981`（emerald green）|

**绝对禁止**回退到任何含 `Claude` 字样的产品名（Anthropic 商标）。可保留 `Claude` 作为 adapter ID（API provider 合法兼容性引用）。

---

## 🔐 安全约束（关键，从过往教训提炼）

1. **密码 / API token / webhook secret 永远不能进对话**
   - 用户的 Apple Notes 加锁笔记「07_panel-passwords」存了 4 个独立强密码
   - LS / Payoneer / 商标律师等任何账号的凭据**必须**让用户自己输 / 从 Apple Notes 取
   - panel 内 webhook secret 配置走 `/tmp/configure-ls-webhook.sh <secret>` 脚本，secret 仅从 shell 参数传，不在对话出现

2. **截屏可能暴露隐私**（已发生过事故）
   - cliclick 自动点击需要先截屏定位按钮 → 截屏会**捕获相机 / 其他屏幕内容**
   - 之前发生过：截屏捕获到用户相机面孔 + 其他项目笔记 → 已 rm 但上传过一次
   - **永不再用 screencapture + Read 图片** 来定位 GUI 按钮

3. **用户数据 0o600**
   - `~/.claude-panel/` 所有文件强制 0o600
   - SQLite `panel.db` 也是 0o600
   - 写新 data 时检查权限

4. **macOS UI 自动化能力 / 边界**
   - osascript 让 Chrome 跳 URL：✅ 能
   - osascript 读 Chrome tab title/url：✅ 能
   - osascript 执行 JS in Chrome：❌ "Allow JavaScript from Apple Events" 菜单 disabled
   - cliclick 模拟键盘鼠标：✅ 能（Terminal 已有辅助功能权限）但**禁用截屏定位**
   - playwright 启动独立 Chromium：✅ 能（但和用户 Chrome session 不共享 cookies）

5. **memory 文件不存任何凭据**
   - `~/.claude/projects/.../memory/` 是明文 markdown，每次新会话自动注入 LLM 上下文
   - 见 `memory/user-security-passwords-rule.md`

---

## 🚧 当前阻塞 & 下一步

### 真实当前阻塞（v2.1 后）：无收钱基础设施阻塞，仅缺端到端实测

v2.0 文档里写的"用户没注册 LS、要 25min 手动注册 + ngrok + 配 secret"等 7 步**已全部被 v2.1 commit 解决**（详见上面 v2.1 增量表）。

**真正还差的事**：

1. ⚠️ **LS test mode 真订单实测**（30 min，需操作 LS dashboard）
   - 在 LS 后台切 test mode → 用测试卡 4242 4242 4242 4242 下一笔 $19 单
   - 验证：Worker `/webhooks/lemon` 收到 webhook → 签名校验通过 → 调 panel `/api/license/*` 签发 license → 邮件给买家
   - Worker 日志看：`wrangler tail xikelab-webhook`
   - panel 日志看：`tail -f ~/.claude-panel/logs/panel-*.log`
   - 如果链路有 bug，这里会暴露 — 比 v2.0 文档里"7 步手动"靠谱多了

2. ⚠️ **打 `v2.1.0-xikelab` tag**（5 min）
   - 4 个 v2.1 commit 还在 main 上没打 tag
   - 测试链路通了再打，免得测出 bug 还要回滚

### 中期 TODO（不卡发布）

1. **域名注册** xikelab.com / xikelab.ai — 用户决定赚到钱再买（暂用 `xikelab.pages.dev`）
2. **USPTO 商标注册** Class 9 + 42 — 同上推迟（$350 + 律师 $500-1500）
3. **panel server 自身部署**（非必需 — 现 webhook 收件人是 Cloudflare Worker 而非本机 panel；panel 只在用户本机跑就够）
4. **better-sqlite3 vs Electron 42 ABI 修复** — 等社区跟进或换 sql.js / libsql
5. **shadcn/ui 迁移**（v1.5 task 2.5 deferred）3 天工作

---

## 🗂 项目结构（关键文件位置）

```
/Users/hxx/Desktop/00_项目/05_Claude可视化面板/
├── server.js                              4000+ 行后端
├── electron-main.js                       Electron 入口
├── package.json                           v2.0.0, productName="Xike Lab"
├── README.md                              # Xike Lab + 源码运行指南
├── EXTERNAL_REGISTRATIONS.md              5 个外部账号注册步骤
├── HANDOFF_v2.0_xikelab.md                ← 本文档
├── RELEASE_NOTES_v1.0/v1.5/v2.0.md        发布说明
├── src/
│   ├── license/LicenseManager.js          Ed25519 离线 license
│   ├── integrations/
│   │   └── LemonSqueezyClient.js          [v2.1] 全 LS REST API wrapper（token 从 ~/.claude-panel/ 读）
│   ├── server/routes/
│   │   ├── license.js                     6 endpoint /api/license/*
│   │   ├── payment-webhooks.js            LS+Polar HMAC 验签
│   │   ├── lemonsqueezy.js                [v2.1] 6 endpoint /api/lemonsqueezy/*（含 webhook-auto-register）
│   │   ├── auto-fill.js                   [v2.1] 4 endpoint /api/auto-fill/*（Keychain 密码代理）
│   │   ├── storage.js                     /api/storage/* (SQLite)
│   │   ├── embeddings.js                  /api/embeddings/* (向量搜索)
│   │   ├── workspaces.js                  /api/workspaces/* (team-tier)
│   │   └── commercial-setup.js            /api/commercial/status 自检
│   ├── storage/SqliteStore.js             better-sqlite3 wrapper
│   ├── embeddings/                        hash+ollama 双轨 + 余弦相似度
│   ├── workspace/WorkspaceManager.js      team-tier 多空间
│   └── logger/index.js                    Pino 0o600 日志
├── scripts/
│   ├── issue-license.js                   卖家本地签发 license
│   ├── migrate-jsonl-to-sqlite.js         一次性数据迁移
│   ├── register-github.mjs                playwright 注册自动化骨架
│   ├── setup-keychain-passwords.sh        [v2.1] 一次 setup 把 8 站点密码存进 macOS Keychain
│   └── auto-create-ls-product.mjs         [v2.1] 用 osascript + Chrome JS 自动建 LS Pro product
├── website/                                [v2.1] Cloudflare Pages 静态站（xikelab.pages.dev）
│   ├── index.html                         landing page
│   ├── _headers / _redirects              CF Pages 配置
│   ├── favicon.svg
│   └── assets/logo.svg + logo-mono.svg
├── worker/                                 [v2.1] Cloudflare Worker（xikelab-webhook.ilifelahepeq54.workers.dev）
│   ├── wrangler.toml                      Worker 配置
│   └── src/index.js                       POST /webhooks/lemon + GET /api/license/verify + /health
├── public/
│   ├── index.html                         <title>Xike Lab</title>
│   ├── pricing.html                       完整定价落地页
│   ├── favicon.svg                        绿底 X + 圆点
│   ├── assets/logo.svg + logo-mono.svg    主 logo（X + 圆点 + 圆环 + 4 协作点）
│   └── src/web/license-ui.js              徽章 + workspace 切换器
└── tests/
    └── e2e/panel-ui-walkthrough.mjs       35 个 e2e 场景

~/.claude-panel/                           用户数据（0o600 强制）
├── data.json / rooms.json / mcp-servers.json / etc
├── panel.db + panel.db-shm + panel.db-wal SQLite
├── license.txt                            激活的 license（可空）
├── webhook-secrets.json                   LS/Polar secret (0o600)
├── lemonsqueezy-key.txt                   [v2.1] LS API token (0o600，永不进 LLM)
├── ls-webhook-secret.txt                  [v2.1] 40-hex HMAC secret，与 Worker 同步
├── logs/panel-YYYY-MM-DD.log              Pino 日志
└── workspaces/                            team-tier 多 workspace（每个独立 db）

~/.claude-panel-keys/                      私钥目录（0o600）
└── panel-license-private-key.pem          Ed25519 签发用
```

---

## 🛠 常用命令

```bash
# 启动 panel
cd /Users/hxx/Desktop/00_项目/05_Claude可视化面板
npm start

# 跑全套测试
node .s18-2-routes-smoke.mjs              # 21/21
node .s18-2a-webhook-test.mjs             # 18/18
node .s18-7-panel-smoke.mjs               # 20/20
node /tmp/panel-s18-3-smoke.mjs           # 9/9
npm test                                   # vitest 65/65
node tests/e2e/panel-ui-walkthrough.mjs   # e2e 35/35

# 签发 license
node scripts/issue-license.js buyer@x.com pro 365

# 看商品化进度
curl http://127.0.0.1:51735/api/commercial/status | python3 -m json.tool

# 看 panel 日志
tail -f ~/.claude-panel/logs/panel-*.log

# GitHub 操作
gh repo view BB20260410/xikelab
gh release list -R BB20260410/xikelab
gh auth status

# Chrome 自动化（osascript）
osascript -e 'tell application "Google Chrome" to set URL of active tab of front window to "https://..."'
osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'
```

---

## 🚨 红线（绝不能自主，必须问用户）

按 CLAUDE.md 全局规则：

1. **真启动用户生产项目跑付费 LLM 配额** → 问
2. **修改用户其他项目的代码**（非 Xike Lab）→ 问
3. **在用户其他项目里 git commit** → 问
4. **launchctl / cron / systemd** → 问
5. **删除用户已有文件** → 问

**已被授权可做**（之前用户多次 `/goal` + v2.1 commit 历史明确）：
- ✅ 在 Xike Lab 项目内 git commit + push + tag + release（需用户明说当次提交动作）
- ✅ 用 gh CLI 创建 / rename GitHub repo（限 BB20260410 账号）
- ✅ 改 panel 源码 / 配置 / 测试 / 文档
- ✅ osascript 控 Chrome 跳 URL / 读 tab 状态 / 执行 JS（已实证）
- ✅ 自实现 HMAC license / SQLite / 向量搜索（无外部账号依赖）
- ✅ [v2.1] 用 LS API token 调 LS REST API（创 webhook / 查 store / list product）
- ✅ [v2.1] 用 wrangler 部署 Cloudflare Worker + 配 secret（用户 CF 账号已登录）
- ✅ [v2.1] 用 osascript + Chrome JS 在用户当前 Chrome 操作（建 LS product 已实证）
- ✅ [v2.1] 用 macOS `security` 读 Keychain 密码并 osascript 填到 Chrome（永不暴露给 LLM）

**与项目 CLAUDE.md 红线对齐**（HANDOFF v2.0 老版本写"可以重启 panel"，CLAUDE.md 写"不自主重启 panel"，**以 CLAUDE.md 为准**）：
- ⚠️ **不自主重启 panel** — 改 server.js 后告知用户「需要重启」，不擅自 kill + npm start
- ⚠️ **不 npm install 新依赖** — 除非诊断报告明列且用户同意
- ⚠️ **不 git commit / push** — 除非用户明说当次动作

---

## 💬 用户工作偏好（从过往对话提炼）

1. **默认中文对话**（即使技术术语英文保留）
2. **直接执行，不要把每小步变成确认题**
3. **遇到困难自己想办法解决**（已多次明确授权 "全权处理"）
4. **物理边界要诚实**（密码 / 邮件验证 / 绑卡这些必须用户做）
5. **截屏请慎重**（会泄漏隐私）
6. **不要重复"完成所有 task"的死循环抗辩**：物理无法做的就明确说，不要绕弯

---

## 🎬 新会话第一条消息可以这样开始

```
我接手 Xike Lab 项目，刚读完 HANDOFF_v2.0_xikelab.md（含 v2.1 增量回填）。

panel pid: <lsof -ti tcp:51735>
GitHub repo: https://github.com/BB20260410/xikelab
最新 tag: v2.0.0-xikelab（v2.1 4 commit 在 main 还没打 tag）
LS Pro product: 1074614 published $19
Checkout URL: https://hxx.lemonsqueezy.com/checkout/buy/5809ccc9-20aa-4d63-9f8f-3754d85ab28e
Worker: https://xikelab-webhook.ilifelahepeq54.workers.dev
官网: https://xikelab.pages.dev/

主要待办: 收钱链路（官网 → checkout → Worker → license → 邮件）未实测真订单。
建议第一步：LS 后台切 test mode + 下一笔 4242 测试卡 → 看 Worker / panel 日志确认链路通。
```

---

🎁 接手后第一件事**永远不要做**：擅自重命名（用户已经改名 5 次，定的是 **Xike Lab**，不要再改）。
