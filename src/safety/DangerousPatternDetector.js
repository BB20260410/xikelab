// DangerousPatternDetector — 22 条危险命令规则
// 移植自 思维镜 Safety/DangerousPatternDetector.swift
// 用法：detector.scan(toolUseInput.command) → DangerHit[]，若 shouldBlock 则 kill

export const DANGER_RULES = [
  // ===== CRITICAL（必拦） =====
  { pattern: /rm\s+-rf\s+(\/|~|\$HOME)(\s|$)/, severity: 'critical', category: '删除系统/家目录', advice: '禁止递归删除根目录或家目录' },
  { pattern: /rm\s+-rf\s+\*/, severity: 'critical', category: '删除当前目录全部', advice: '改为指定具体文件或子路径' },
  { pattern: /sudo\s+rm/, severity: 'critical', category: 'sudo 删除', advice: '严禁 sudo 删除，先 ls 确认目标' },
  { pattern: /git\s+push\s+.*--force(?!-with-lease)/, severity: 'critical', category: 'Git 强推（无 lease）', advice: '改 --force-with-lease 至少' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, severity: 'critical', category: '数据库 DROP', advice: '不可逆，必须人工二次确认' },
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)(\s|$)/, severity: 'critical', category: '远程脚本直接执行', advice: '先 curl 下载到文件审计再 bash' },
  { pattern: /chmod\s+-R\s+\d{3,4}\s+\//, severity: 'critical', category: '递归改根目录权限', advice: '会破坏系统权限模型' },
  { pattern: /(>|>>)\s*\.env(\s|$)/, severity: 'critical', category: '.env 文件被重定向覆盖', advice: '会写空或覆盖密钥' },
  { pattern: /:\(\)\s*\{\s*:\|\:&\s*\}\s*;:/, severity: 'critical', category: 'Fork bomb', advice: '经典 fork 炸弹' },
  { pattern: /dd\s+if=\/dev\/(zero|random)\s+of=\/dev\/[sh]d/, severity: 'critical', category: '硬盘清零', advice: '会清空真实磁盘' },

  // ===== HIGH（默认拦） =====
  // v0.17 真测发现的盲区补丁：rm -rf 任意绝对路径（除明显安全的临时目录显式白名单）
  { pattern: /\brm\s+-r?f+r?\s+\/(?!tmp\/|var\/folders\/|private\/tmp\/)\S+/, severity: 'high', category: '递归删除绝对路径', advice: '会不可恢复，请先 ls 确认目标，或用 trash 命令' },
  { pattern: /\brm\s+-r?f+r?\s+~\//, severity: 'high', category: '递归删除家目录子路径', advice: '~/ 是用户家目录，谨慎删除子路径，先 ls 确认' },
  { pattern: /\brm\s+-r?f+r?\s+(\.\.?\/|\.\.\/?)/, severity: 'high', category: '递归删除上级/当前目录', advice: '改用具体子路径，避免 .. 含义不明' },
  { pattern: /git\s+reset\s+--hard/, severity: 'high', category: 'Git 硬重置', advice: '会丢本地未提交改动，先 stash' },
  { pattern: /git\s+clean\s+-[fdx]+/, severity: 'high', category: 'Git 清未追踪', advice: '会删未追踪文件不可恢复' },
  { pattern: /git\s+push(\s+\S+)?\s+(main|master|prod)(\s|$)/, severity: 'high', category: '直推主分支', advice: '应走 PR 流程' },
  { pattern: /git\s+checkout\s+(--\s+)?\./, severity: 'high', category: 'Git 丢工作区改动', advice: '先 git stash 保留' },
  { pattern: /find\s+\S+\s+.*-delete/, severity: 'high', category: '批量 find -delete', advice: '先用 -print 预览' },
  { pattern: /DELETE\s+FROM\s+\w+(\s+WHERE\s+1\s*=\s*1)?(\s|;|$)/i, severity: 'high', category: '无条件 DELETE', advice: '必须带具体 WHERE 子句' },
  { pattern: /TRUNCATE\s+TABLE/i, severity: 'high', category: 'TRUNCATE', advice: '清空表不可逆' },
  { pattern: /npm\s+publish(\s|$)/, severity: 'high', category: 'npm 发布', advice: '会推到公开 registry' },
  { pattern: /wrangler\s+(deploy|publish)(\s|$)/, severity: 'high', category: 'Cloudflare 部署', advice: '生产环境生效' },
  { pattern: /kubectl\s+(apply|delete)/, severity: 'high', category: 'K8s 变更', advice: '集群配置变更' },
  { pattern: /docker\s+(rm|rmi)\s+-f/, severity: 'high', category: 'Docker 强删', advice: '强删容器/镜像不可恢复' },
  { pattern: /chmod\s+777/, severity: 'high', category: '权限 777', advice: '极不安全，改 755/644' },

  // ===== LOW（记录但不拦） =====
  { pattern: /cat\s+.*\.env/, severity: 'low', category: '读取 .env', advice: '注意密钥不要进日志' },
  { pattern: /(>|>>)\s+\S+\.(md|json|yml|yaml|toml)(\s|$)/, severity: 'low', category: '重定向覆盖配置/文档', advice: '注意是否会覆盖关键文件' },
];

export class DangerousPatternDetector {
  scan(text) {
    if (!text) return [];
    const hits = [];
    for (const rule of DANGER_RULES) {
      const m = text.match(rule.pattern);
      if (m) {
        hits.push({
          rule: { pattern: rule.pattern.toString(), severity: rule.severity, category: rule.category, advice: rule.advice },
          snippet: m[0].slice(0, 200),
          matchedAt: Date.now(),
        });
      }
    }
    return hits;
  }

  // guardLevel: strict（CRITICAL+HIGH）/ standard（同 strict）/ loose（仅 CRITICAL）
  shouldBlock(hits, guardLevel = 'standard') {
    if (!hits || hits.length === 0) return false;
    if (guardLevel === 'loose') return hits.some(h => h.rule.severity === 'critical');
    return hits.some(h => h.rule.severity === 'critical' || h.rule.severity === 'high');
  }

  worstSeverity(hits) {
    if (hits.some(h => h.rule.severity === 'critical')) return 'critical';
    if (hits.some(h => h.rule.severity === 'high')) return 'high';
    if (hits.some(h => h.rule.severity === 'low')) return 'low';
    return null;
  }
}
