# panel 商品化外部账号注册手册

最后更新：2026-05-21

本文档是 panel v2.0 上架前你需要做的**5 个外部账号注册**的精确步骤。所有自动化能做的部分已经写好脚本，**密码 / 验证码 / 卡号永远不进对话**。

## 🔑 安全前置（必读，5 分钟）

在开始任何注册之前，请确认：

- [ ] 你 Gmail（`ilifelahepeq54@gmail.com`）已开 2 步验证（Google Authenticator / Authy）
- [ ] `Lyh666666` 这个密码已在 Have I Been Pwned 检查过：[https://haveibeenpwned.com/Passwords](https://haveibeenpwned.com/Passwords)
- [ ] Apple Notes 已有「07_panel-passwords」加锁笔记（File > Lock Note）
- [ ] 笔记里有 4 个 28 字符独立强密码：
  ```
  1. GitHub         : tqiwxfJNSeUsCAzb1FkNJkINa39f
  2. Keygen         : FepDdruASMDQl5fOaUmDhXN1VKgl
  3. Lemon Squeezy  : IFKAQ6TsG5g4iD0G7AD094b4LOST
  4. Polar          : x2RmhJH4tbxEnKVubFi9kP0zzlry
  ```
- [ ] 如果某账号已存在（用 Lyh666666 注册的），登录后**第一件事改成对应强密码**

## 📋 5 个账号注册总览

| 平台 | 用途 | 需要 | 自动化脚本 |
|---|---|---|---|
| **GitHub** | repo + Release 发布 | 邮箱 + 密码 + 2FA | `scripts/register-github.mjs` |
| **Keygen** | License key 服务（可选）| 邮箱 + 密码 + 邮件验证 | 见下方手动步骤 |
| **Lemon Squeezy** | 海外收款 + 自动 license | 邮箱 + W-8BEN + Wise/Payoneer | 见下方手动步骤 |
| **Polar** | 海外收款（备选）| 邮箱 + W-8BEN + Stripe | 见下方手动步骤 |

> 推荐路径：GitHub → Lemon Squeezy（主收款）→ 其他可选。Keygen 可跳过（panel 自实现了 license 系统）。

## 1. GitHub（必须，免费）

### 自动化脚本

```bash
cd ~/Desktop/00_项目/05_Claude可视化面板
node scripts/register-github.mjs --email ilifelahepeq54@gmail.com --mode login
# 已有账号：mode=login
# 新建账号：mode=signup
```

脚本会：
1. 打开 github.com/login（或 /signup）
2. 等你在浏览器输 username + 自己从 Apple Notes 取密码粘贴
3. 你完成 2FA / CAPTCHA / 邮件验证后回终端按 Enter
4. 脚本自动跳到 https://github.com/new 帮你创建 `claude-panel` repo
5. 引导你生成 PAT（scope: repo）→ 你粘贴 token 到终端
6. 脚本存 token 到 `~/.claude-panel/github-token.json` (0o600)

### 后续：发 v1.0 Release

```bash
export GH_TOKEN=$(node -p "require(require('os').homedir()+'/.claude-panel/github-token.json').token")
npm run dist:publish
```

预计：
- 编译 5 min（electron-builder 打 .app）
- 上传 GitHub Release 2 min（304MB .app + .yml meta）
- 验证：访问 https://github.com/<username>/claude-panel/releases/tag/v1.0.0

## 2. Lemon Squeezy（主收款，最重要）

### 手动步骤（30 分钟）

**a. 注册**
1. 打开 https://app.lemonsqueezy.com/register
2. Email：`ilifelahepeq54@gmail.com`
3. Password：从 Apple Notes 取 LS 密码（`IFKAQ6TsG5g4iD0G7AD094b4LOST`）
4. 提交 → 去 Gmail 看验证邮件 → 点链接

**b. 填 W-8BEN 个人税务表**
1. Account → Settings → Tax info
2. Country：China
3. 选 Individual（个人，非 entity）
4. 填真实姓名 + 出生日期 + 永久地址
5. Tax ID：你的中国身份证号（或 ITIN 美国税号如有）
6. 签名 → 提交

**c. 关联收款方式**
1. Settings → Payouts
2. 选 Payout method = Wise
3. 输入 Wise 账户 email + 收款币种（USD 推荐）
4. 等 Wise 验证（一般 1-2 工作日）

**d. 创建产品 panel-pro**
1. Products → Add product
2. Name：`Claude Panel Pro`
3. Description（贴下面这段）：
   ```
   Local-first multi-AI workbench with Claude/GPT/Gemini.
   4 collaboration modes, MCP, autopilot, archive.
   One-time payment, lifetime updates.
   ```
4. Pricing：One-time, $19 USD
5. Files：先空（license 是 webhook 签发，不需要附件）
6. Variants 不勾
7. Save

**e. 配置 Webhook**
1. Settings → Webhooks → Add webhook
2. URL：`https://你的域名/api/webhooks/lemon` 或测试期用 `https://your-ngrok-tunnel.ngrok.io/api/webhooks/lemon`
3. Events：勾 `order_created` + `subscription_created`
4. Generate signing secret → ⌘C 复制
5. 回 panel：`curl -X POST http://localhost:51735/api/webhooks/config -H 'Content-Type: application/json' -d '{"provider":"lemon","secret":"<刚才的 secret>"}'`
   - 注意 secret **不要发到对话里**，从 Apple Notes / 1Password 取

**f. 测试**
1. LS dashboard → 你的产品 → Test mode 下单
2. panel 端：`tail -f ~/.claude-panel/logs/panel-*.log` 看 webhook 是否签发 license
3. 看 `~/.claude-panel/licenses-issued.jsonl` 验签发记录

## 3. Polar（备选收款）

### 类似 LS 但更简

1. 打开 https://polar.sh
2. Continue with GitHub（用你刚注册的 GitHub 账号 OAuth 登录，省一次密码）
3. Tax info → 同 LS 填 W-8BEN
4. Payout → Stripe（Polar 用 Stripe 后端，需要 Stripe 账号——美国 LLC 才能开）

> **重要**：Polar 需要 Stripe 美国账号才能收款。如果没 Stripe US，建议跳过 Polar 只用 LS。

## 4. Keygen（可选，跳过也行）

panel 已**自实现** ed25519 离线 license 系统，**不需要** Keygen。

如果你想要 Keygen 做 license activation tracking（看哪些用户激活了几次）：

1. 打开 https://app.keygen.sh/register
2. 同 LS 注册流程
3. Account → API → Generate API token
4. 存到 panel：`echo '{"token":"..."}' > ~/.claude-panel/keygen.json && chmod 600 ~/.claude-panel/keygen.json`

我**不推荐**做这一步，因为：
- panel 现有 license 系统已足够
- Keygen 是额外成本（$19/月起，没免费层永久使用）
- 等你卖出 100+ license 再考虑

## 📦 注册后验证清单

完成后跑：

```bash
# 1. License 系统自验
node scripts/issue-license.js me@example.com pro 365
# 输出 license string，复制下来

# 2. 激活到 panel
LIC="复制粘贴的 license string"
curl -X POST http://localhost:51735/api/license/activate \
  -H 'Content-Type: application/json' \
  -d "{\"license\":\"$LIC\"}"

# 3. 验证 tier 升 pro
curl http://localhost:51735/api/license/status | jq

# 4. 创建一个 squad 房（free 时会被拒，pro 时通过）
curl -X POST http://localhost:51735/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-squad","mode":"squad"}'
# free → 402
# pro  → 200 + 房创建成功

# 5. Webhook 测试（模拟 LS 调用）
SECRET="你 LS 的 webhook secret"
BODY='{"meta":{"event_name":"order_created"},"data":{"attributes":{"user_email":"buyer@x.com","product_name":"panel-pro"}}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST http://localhost:51735/api/webhooks/lemon \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
# 应返回 { ok: true, issued: true, license: "..." }
```

## 🆘 遇到问题

| 问题 | 解决 |
|---|---|
| GitHub PAT 输错（看错字符）| 重新跑 register-github.mjs，旧 token 仍可在 GitHub Settings → Tokens 重生成 |
| LS 邮件验证码没收到 | 检查 Gmail 垃圾邮件，或在 LS 登录页 Resend |
| W-8BEN 提交后 pending | 正常，一般 24h 内审核完，过了再开始卖 |
| Webhook 签名失败 401 | secret 配错；从 LS Settings → Webhook → Signing secret 再 copy 一次 |
| `npm run dist:publish` 失败 | 看 `GH_TOKEN` 是否 export；token 是否过期 |

## ⏱ 时间预算

| 任务 | 预计 |
|---|---|
| GitHub 登录 + 创建 repo + PAT | 5 min |
| GitHub Release 编译 + 上传 | 7 min |
| LS 注册 + 邮件验证 + W-8BEN + 产品创建 + webhook | 30 min |
| LS payout（Wise 验证）| 1-2 工作日（异步等）|
| Polar 注册（如果做）| 15 min |
| Keygen 注册（如果做）| 10 min |
| **总计**（必做：GitHub + LS）| **~45 min 主动操作** |

完成后 panel 即可正式上架卖货。
