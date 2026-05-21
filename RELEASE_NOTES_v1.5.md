# Roundtable v1.5.0 — 商品化收费层

发布日期：2026-05-21
代号：Pay-The-Bills

## 🎯 这一版的主线

v1.0 把 panel 做成可上架商品；**v1.5 让它能赚钱**：
- ✅ License 验签 → 防破解（Ed25519 离线，零外部依赖）
- ✅ Pro / Free 功能分级 → 让 Free 用户感受到价值上限
- ✅ 支付集成 → Lemon Squeezy / Polar webhook 收单自动签发 license

## ✨ 新功能

### 🔑 离线 License 系统（自实现，零依赖）

**安全模型**：Ed25519 公私钥
- **私钥**仅在卖家 `~/.claude-panel-keys/panel-license-private-key.pem` (0o600)
- **公钥**嵌入 panel binary（任何人能验签，**不能伪造**）
- 防伪测试：sig 篡改 / 错私钥签 / 过期 license → 全部拒绝
- 全程 Node `crypto` 内置，**不需要** Keygen / Auth0 / 其他 SaaS

**端点 6 个**：
```
GET  /api/license/status         → 当前 tier + 邮箱 + 到期
POST /api/license/activate       → 激活 license 字符串
POST /api/license/deactivate     → 清除 license
GET  /api/license/features       → 列当前可用 feature
GET  /api/license/check/:feature → 是否有某 feature
POST /api/license/verify         → 仅验证不激活（dry-run）
```

**签发脚本**：`node scripts/issue-license.js <email> [tier] [days]`
- `node scripts/issue-license.js buyer@x.com pro 365` → 1 年 Pro
- `node scripts/issue-license.js team@x.com team 0` → 永久 Team
- License 格式：`base64url(payload).base64url(sig)` 单字符串，邮件可复制粘贴

### 🎚 Pro / Free 功能分级

| 功能 | Free | Pro ($19/永久) | Team ($49/永久) |
|---|---|---|---|
| 单模型聊天 chat | ✅ | ✅ | ✅ |
| 多模型辩论 debate | ✅ | ✅ | ✅ |
| AI 团队拆活 squad | ❌ | ✅ | ✅ |
| 多模型联网核对 arena | ❌ | ✅ | ✅ |
| Autopilot 自驾 | ❌ | ✅ | ✅ |
| MCP server | 3 个 | 不限 | 不限 |
| Adapter (provider) | 3 个 | 不限 | 不限 |
| Webhook | ❌ | ✅ | ✅ |
| Archive 归档 | ❌ | ✅ | ✅ |
| 多 workspace | ❌ | ❌ | ✅ |
| 优先支持 | ❌ | ❌ | ✅ |

**Free 受限时的体验**：被拦的 POST 返 `402 Payment Required` + `upgradeUrl: https://panel.app/pricing`，前端弹窗引导购买。

### 💳 Lemon Squeezy / Polar 支付 webhook

**端点 5 个**：
```
GET  /api/webhooks/config        → 已配置哪些 provider
POST /api/webhooks/config        → 配置 webhook secret { provider, secret }
POST /api/webhooks/lemon         → 接收 Lemon Squeezy 支付事件
POST /api/webhooks/polar         → 接收 Polar.sh 支付事件
GET  /api/webhooks/issued        → 查询历史签发记录（最近 100 条）
```

**安全**：
- HMAC-SHA256 签名验证（X-Signature header）
- `crypto.timingSafeEqual` 防 timing attack
- raw body 保留供验签
- secret 存 `~/.claude-panel/webhook-secrets.json` (0o600)
- 签发日志 `~/.claude-panel/licenses-issued.jsonl` (0o600)

**支付流程**：
1. 用户在 LS/Polar 下单 → LS 调 webhook → panel 验签
2. 解析 email + 产品（panel-pro / panel-team）
3. 自动 `signLicense()` 签发 license
4. 返 license string 给 LS（LS 把 license 通过 fulfillment email 发给买家）
5. 买家收邮件 → 打开 panel → 设置 → License → 粘贴激活

## 🔧 改进

- `POST /api/rooms` 增加 squad/arena tier guard
- `POST /api/mcp/servers` 增加 free tier 3 个上限
- `PUT /api/room-adapters` 增加 free tier 3 个 adapter 上限
- 受限端点统一返 402 + 引导 URL（不是 403 也不是 500）
- `express.json` middleware 加 raw body 保留（仅 `/api/webhooks/*` 路径）

## 🧪 测试覆盖

- vitest 单元：65/65 ✅
- 4 套 smoke：68/68 ✅（routes/webhook/panel/storage）
- License 安全测试：4/4 ✅（sig 篡改 / 错私钥 / 过期 / 不存在）
- HMAC 验签测试：4/4 ✅（正确 / 篡改 body / 错 secret / sha256= 前缀）

## 🛣 下一站 v2.0（即将开发）

- libsql SQLite 替 jsonl（数据底座）
- 向量索引（语义搜索房间内容）
- 多 workspace 隔离（独立 db + 配置）
- Pino 结构化日志

## 📦 升级

```bash
# 源码升级
git pull && npm install && npm start

# .app 升级
panel 顶栏 Help → 检查更新 → 自动下载 v1.5.0
```

## ⚠️ Breaking changes

无。v1.0 用户升级到 v1.5 是 **0 操作**：
- 没有 license = free tier，原有 chat/debate 房继续跑（squad/arena 房保留只读）
- 现有 MCP/adapter 配置全保留（即使数量超过 3 也不会被强删，只是不能再加）

---

## 🤝 贡献者

- [@你的 GitHub username]（主开发）
- Anthropic Claude（结对开发）

## 📝 完整 commits

```bash
git log v1.1.0-final..v1.5.0 --oneline
```
