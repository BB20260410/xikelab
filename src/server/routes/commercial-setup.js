// panel v2.0 final — 商品化上架准备状态 API
// 让 panel UI 能展示「商品化 setup」完成度 + 引导用户完成剩余步骤

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = path.join(os.homedir(), '.claude-panel');
const KEYS_DIR = path.join(os.homedir(), '.claude-panel-keys');

function checkFile(p) {
  return fs.existsSync(p);
}

function getCommercialStatus() {
  const status = {
    licenseKeys: {
      done: checkFile(path.join(KEYS_DIR, 'panel-license-private-key.pem')),
      hint: '已生成 Ed25519 私钥（卖家本地，0o600）',
      script: 'node scripts/issue-license.js <email> [tier] [days]',
    },
    githubToken: {
      done: checkFile(path.join(HOME, 'github-token.json'))
        || checkFile(path.join(os.homedir(), '.config', 'gh', 'hosts.yml')),
      hint: 'GitHub PAT 已存 或 gh CLI 已登录，npm run dist:publish 可发 Release',
      script: 'node scripts/register-github.mjs  或  gh auth login',
    },
    lemonWebhook: {
      done: (() => {
        if (checkFile(path.join(HOME, 'ls-webhook-secret.txt'))) return true;
        const sp = path.join(HOME, 'webhook-secrets.json');
        if (!checkFile(sp)) return false;
        try {
          const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
          return !!s.lemon;
        } catch { return false; }
      })(),
      hint: 'Lemon Squeezy webhook secret 已配，订单可自动签 license',
      script: 'curl -X POST http://localhost:51735/api/webhooks/config -d \'{"provider":"lemon","secret":"<your_secret>"}\'',
    },
    polarWebhook: {
      done: (() => {
        const sp = path.join(HOME, 'webhook-secrets.json');
        if (!checkFile(sp)) return false;
        try {
          const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
          return !!s.polar;
        } catch { return false; }
      })(),
      hint: 'Polar webhook secret 已配（可选）',
      script: 'curl -X POST http://localhost:51735/api/webhooks/config -d \'{"provider":"polar","secret":"<your_secret>"}\'',
    },
    sqliteMigrated: {
      done: checkFile(path.join(HOME, 'panel.db')),
      hint: '历史 jsonl 已迁移到 SQLite（events/embeddings/kv 表）',
      script: 'node scripts/migrate-jsonl-to-sqlite.js',
    },
    pricingPage: {
      done: checkFile(path.join(process.cwd(), 'public', 'pricing.html')),
      hint: '/pricing.html 可访问（panel.app/pricing 上线落地页）',
      script: 'open http://localhost:51735/pricing.html',
    },
  };

  const total = Object.keys(status).length;
  const done = Object.values(status).filter(s => s.done).length;
  const percent = Math.round(done / total * 100);

  return {
    total,
    done,
    percent,
    items: status,
    externalSteps: {
      label: '需要用户在浏览器手动完成（密码、邮件验证码、绑卡 — LLM 无法代做）',
      tasks: [
        { name: 'GitHub 账号登录 + 创建 repo + 生成 PAT', est: '5 min', autoScript: 'scripts/register-github.mjs' },
        { name: 'Lemon Squeezy 注册 + W-8BEN + 产品 panel-pro + webhook', est: '30 min', autoScript: null },
        { name: 'Polar 注册（可选，需 Stripe US）', est: '15 min', autoScript: null },
        { name: 'Payoneer 收款账号 + 关联 LS payout', est: '10 min', autoScript: null },
      ],
    },
    docs: {
      external: 'EXTERNAL_REGISTRATIONS.md',
      releaseNotes_v15: 'RELEASE_NOTES_v1.5.md',
      releaseNotes_v20: 'RELEASE_NOTES_v2.0.md',
    },
  };
}

export function registerCommercialSetupRoutes(app) {
  app.get('/api/commercial/status', (req, res) => {
    try {
      res.json({ ok: true, ...getCommercialStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/commercial/next-step', (req, res) => {
    try {
      const s = getCommercialStatus();
      const undone = Object.entries(s.items).find(([_, v]) => !v.done);
      if (!undone) {
        return res.json({
          ok: true,
          allDone: true,
          message: '✅ 全部商品化准备已完成！现在可以发布 panel 上架了。',
          nextAction: 'npm run dist:publish',
        });
      }
      const [key, item] = undone;
      res.json({
        ok: true,
        allDone: false,
        nextKey: key,
        nextHint: item.hint,
        nextScript: item.script,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
