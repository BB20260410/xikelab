#!/bin/bash
# Xike Lab — 一次性把账号密码存进 macOS Keychain
# 用法: ./setup-keychain-passwords.sh
#
# 安全特性：
#   - 密码不显示在屏幕（read -s）
#   - 不写到任何 shell history（用 read 而非 cmd-line arg）
#   - 不进入 Claude 对话日志（这是 shell 脚本，独立于 LLM 上下文）
#   - 存入 macOS Keychain login.keychain（用你开机密码加密）
#
# 跑完后 panel 的 auto-fill endpoint 能自动从 Keychain 读密码填到 Chrome

set -e

USER_NAME="hxx"

cat <<'EOF'
==========================================================
  Xike Lab — Keychain 密码存档
==========================================================

接下来我会问你这些网站的密码。密码：
  - 不显示在屏幕（盲打）
  - 不存到 shell history
  - 不进入 Claude 对话日志
  - 存进 macOS Keychain（用你 Mac 开机密码加密）

之后 panel 后端能自动读 Keychain 填到 Chrome，
你再也不用手动输密码登录这些网站。

每个网站可以：
  - 输密码 + 回车 → 存入
  - 直接回车（跳过）→ 不存

==========================================================
EOF

# 要存的网站列表（可按需扩展）
SITES=(
  "github.com|GitHub"
  "lemonsqueezy.com|Lemon Squeezy"
  "myaccount.payoneer.com|Payoneer"
  "polar.sh|Polar"
  "app.keygen.sh|Keygen"
  "dash.cloudflare.com|Cloudflare"
  "appstoreconnect.apple.com|Apple Developer / App Store Connect"
  "accounts.google.com|Google / Gmail"
)

echo ""
read -p "按 Enter 开始（Ctrl+C 取消）..."
echo ""

STORED=0
SKIPPED=0

for entry in "${SITES[@]}"; do
  site="${entry%|*}"
  label="${entry#*|}"

  # 检查是否已存
  EXISTING=$(security find-internet-password -s "$site" 2>/dev/null | grep -c "srvr" || echo "0")
  if [ "$EXISTING" -gt 0 ]; then
    echo "🔍 $label ($site) — 已存在 keychain，跳过（如需更新请先在 Keychain Access 删除旧条目）"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  echo ""
  echo "─────────────────────────────"
  echo "📝 $label"
  echo "   site: $site"
  read -s -p "   密码（盲打 + 回车，留空跳过）: " PASSWORD
  echo ""

  if [ -z "$PASSWORD" ]; then
    echo "   ⏭️  跳过"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  # 存入 Keychain
  # -a account name
  # -s server
  # -w password
  # -j comment
  # -T 信任 security 二进制可读（免每次 GUI 授权弹窗）
  # -U 如已存在则更新
  security add-internet-password \
    -a "$USER_NAME" \
    -s "$site" \
    -w "$PASSWORD" \
    -j "Xike Lab auto-fill (added $(date '+%Y-%m-%d'))" \
    -T /usr/bin/security \
    -T /usr/bin/osascript \
    -U \
    2>&1 | head -3

  STORED=$((STORED+1))
  echo "   ✅ 已存入 Keychain"

  # 清密码变量（避免脚本退出前残留）
  PASSWORD=""
done

echo ""
echo "=========================================="
echo "✅ Setup 完成"
echo "   已存: $STORED 个"
echo "   跳过: $SKIPPED 个"
echo "=========================================="
echo ""
echo "验证："
echo "  curl http://127.0.0.1:51735/api/auto-fill/status"
echo ""
echo "测试自动填密码（确保 Chrome 已打开对应网站的密码框，并已聚焦密码字段）："
echo '  curl -X POST http://127.0.0.1:51735/api/auto-fill/password \'
echo '       -H "Content-Type: application/json" \'
echo '       -d {\"site\":\"lemonsqueezy.com\"}'
echo ""
echo "⚠️  首次 panel 调 security 命令时，macOS 可能弹一次授权对话框："
echo '    "Terminal/security wants to use ..." → 点 "Always Allow"'
echo "    之后 panel 永久免弹窗"
