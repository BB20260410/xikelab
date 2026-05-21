# 🎁 Xike Lab v2.0 — 新会话接手文档

> 复制本文件全文给新 Claude 会话作为第一条消息，新会话能立刻接手项目工作。
> 创建时间：2026-05-21
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

### 代码（19/19 task 全完成）

| 阶段 | tag | 内容 |
|---|---|---|
| v1.0 | `v1.0.0` | Sentry-compat ErrorReporter + electron-builder + auto-update + i18n + onboarding |
| v1.1 | `v1.1.0-final` | Analytics + telemetry consent + 5 篇 docs |
| v1.5 | `v1.5.0` | Ed25519 离线 License + Pro/Free 分级 + LS/Polar webhook |
| v2.0 | `v2.0.0-shipping` | SQLite + 向量搜索 + 多 workspace + Pino 日志 |
| 改名史 | `v2.0.0-xikelab`（最新）| Claude Panel → Roundtable → Hangora → Xikely → **Xike Lab** |

### 测试 175/175 全过

```
4 套 smoke   : 68/68 ✅
vitest      : 65/65 ✅
e2e         : 35/35 ✅
LIVE 端到端  : 7/7  ✅（签发→激活→tier 升级→squad 房→workspace 拒→向量搜→Pino 日志）
```

### 商品化进度

```
panel /api/commercial/status:  3/6 = 50%

✅ licenseKeys     Ed25519 私钥（~/.claude-panel-keys/）
⏸️ githubToken     panel 自己的 token 未存（gh CLI 已登录 BB20260410，可代替）
⏸️ lemonWebhook    LS 未注册 → 没 secret（这是当前阻塞）
⏸️ polarWebhook    可选，跳过
✅ sqliteMigrated  panel.db 已建
✅ pricingPage     /pricing.html 已写

GitHub:
✅ Repo:   https://github.com/BB20260410/xikelab
✅ Releases: v1.0.0 / v1.5.0 / v2.0.0 三个（含完整 release notes）
✅ Branch main + 10+ tags 全 push
```

### 外部账号

| 账号 | 状态 | 备注 |
|---|---|---|
| GitHub | ✅ 已登录 `BB20260410`（gh CLI token: repo+workflow scope）| 本机 `~/.config/gh/hosts.yml` |
| Payoneer | ✅ 收款账户已开通 | Gmail 邮件确认过 |
| Apple Developer | 🟡 用户在做（另一项目「息刻」iOS App，App Store Connect tab 已开）| 跟 Xike Lab 共享品牌 |
| **Lemon Squeezy** | ❌ **未注册** — 当前主要阻塞 | 25 min 用户手动注册 |
| Polar.sh | ❌ 可选，需 Stripe US | 跳过 |
| Keygen | ❌ 跳过（panel 自实现 license） | — |
| 域名（xikelab.com / .ai）| ❌ 未买 | Cloudflare Registrar 用户已登录可代办 |
| 商标（USPTO Class 9+42）| ❌ 未办 | $350 + 律师 $500-1500 |

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

### 阻塞项：用户没注册 Lemon Squeezy

**Xike Lab 代码 100% 完成**，但没收银台 = 卖不了。

**当前进度**：Chrome 已经停在 `https://app.lemonsqueezy.com/register` 等用户操作。25 分钟用户工作：
1. 用 Apple Notes 里 LS 密码注册（不进对话）
2. 填 W-8BEN（真实姓名 / 地址 / 身份证 — 不进对话）
3. 关联 Payoneer 收款（Payoneer 邮箱）
4. 创建产品 `Xike Lab Pro $19`（描述在 `/tmp/xikelab-product-desc.txt`）
5. 配置 Webhook URL → 用 ngrok 暴露 localhost:51735 （需 `brew install ngrok`）
6. 复制 webhook secret → 跑 `/tmp/configure-ls-webhook.sh <secret>` 存到 panel
7. Test mode 下单验证 license 自动签发

### 中期 TODO

1. **域名注册** xikelab.com / xikelab.ai（Cloudflare Registrar，用户已登录）
2. **USPTO 商标注册** Class 9 + 42（$350 + 律师答复 OA $500-1500）
3. **panel.app 部署** — 把 panel server 部署到固定 URL，让 LS webhook 能稳定打过来（不用 ngrok）
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
│   ├── server/routes/
│   │   ├── license.js                     6 endpoint /api/license/*
│   │   ├── payment-webhooks.js            LS+Polar HMAC 验签
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
│   └── register-github.mjs                playwright 注册自动化骨架
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
├── webhook-secrets.json                   LS/Polar secret (0o600，待 LS 注册后写)
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

**已被授权可做**（之前用户多次 `/goal` 明确）：
- ✅ 在 Xike Lab 项目内 git commit + push + tag + release
- ✅ 用 gh CLI 创建 / rename GitHub repo（限 BB20260410 账号）
- ✅ 重启 panel（关 + 启动新）
- ✅ 改 panel 源码 / 配置 / 测试 / 文档
- ✅ osascript 控 Chrome 跳 URL / 读 tab 状态
- ✅ 自实现 HMAC license / SQLite / 向量搜索（无外部账号依赖）

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
我接手 Xike Lab 项目，刚读完 HANDOFF_v2.0_xikelab.md。

panel pid: <跑 `lsof -ti tcp:51735` 查>
GitHub repo: https://github.com/BB20260410/xikelab
当前 tag: v2.0.0-xikelab
商品化进度: <跑 commercial status>

主要阻塞: 用户没注册 Lemon Squeezy，Chrome 当前停在 LS 注册页。
等用户告诉我 LS 注册到哪一步了。
```

---

🎁 接手后第一件事**永远不要做**：擅自重命名（用户已经改名 5 次，定的是 **Xike Lab**，不要再改）。
