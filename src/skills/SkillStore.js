// v0.55 Sprint 13-C — Skills 系统（兼容 Claude Skills 格式）
//
// Skills 目录：~/.claude-panel/skills/<skill-name>/
// 每个 skill 必须含 SKILL.md，frontmatter 跟 Claude Skills 兼容：
// ---
// name: my-skill
// description: When to use this skill (短句让 LLM 决策)
// ---
//
// 后面跟 markdown body（skill 的具体内容，作为 system prompt 注入）。
//
// 可选附加文件：scripts/ assets/ references/（不强制处理，将来 LLM 可读）

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.claude-panel');
const SKILLS_DIR = join(DIR, 'skills');

const MAX_SKILLS = 100;
const MAX_NAME = 64;
const MAX_DESC = 1000;
const MAX_BODY = 200_000;    // 200KB
const MAX_FILE = 1024 * 1024;

function safeName(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(s)) return null;
  return s.slice(0, MAX_NAME);
}

/** 解析 SKILL.md 的 YAML frontmatter（仅支持 name + description + 简单字段） */
function parseSkillMd(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const fmRaw = m[1];
  const body = m[2] || '';
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const lm = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (!lm) continue;
    let v = lm[2];
    // 去引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1, -1);
    fm[lm[1]] = v;
  }
  return { fm, body };
}

/** 把 frontmatter object + body 组装回 SKILL.md 文本 */
function stringifySkillMd(fm, body) {
  const fmLines = [];
  for (const [k, v] of Object.entries(fm)) {
    let val = String(v).replace(/\n/g, ' ');
    if (/[:#&*!|<>%@`'"]/.test(val) || val.length > 60) val = JSON.stringify(val);
    fmLines.push(`${k}: ${val}`);
  }
  return `---\n${fmLines.join('\n')}\n---\n\n${body || ''}`;
}

export class SkillStore {
  constructor() {
    this._ensureDirs();
    this.cache = new Map();
    this.reload();
  }

  _ensureDirs() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
  }

  reload() {
    this.cache.clear();
    let entries;
    try { entries = readdirSync(SKILLS_DIR, { withFileTypes: true }); }
    catch { return; }
    let count = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (!safeName(name)) continue;
      const skillMdPath = join(SKILLS_DIR, name, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;
      try {
        const stat = statSync(skillMdPath);
        if (stat.size > MAX_FILE) continue;
        const text = readFileSync(skillMdPath, 'utf-8');
        const parsed = parseSkillMd(text);
        if (!parsed) continue;
        const { fm, body } = parsed;
        const entry = {
          name,
          displayName: fm.name || name,
          description: (fm.description || '').slice(0, MAX_DESC),
          body: body.slice(0, MAX_BODY),
          enabled: fm.enabled !== 'false',
          updatedAt: stat.mtime.toISOString(),
          path: join(SKILLS_DIR, name),
          extra: Object.fromEntries(Object.entries(fm).filter(([k]) => !['name', 'description', 'enabled'].includes(k))),
        };
        this.cache.set(name, entry);
        count++;
        if (count >= MAX_SKILLS) break;
      } catch {
        // ignore single broken skill
      }
    }
  }

  list() {
    return Array.from(this.cache.values()).map((e) => ({
      name: e.name,
      displayName: e.displayName,
      description: e.description,
      enabled: e.enabled,
      updatedAt: e.updatedAt,
      bodyLen: e.body.length,
    }));
  }

  get(name) {
    const e = this.cache.get(name);
    if (!e) return null;
    return { ...e };
  }

  /** 创建 / 更新一个 skill */
  upsert({ name, displayName, description, body, enabled = true, extra = {} }) {
    const cleanName = safeName(name);
    if (!cleanName) throw new Error('skill name 不合法（仅字母数字 _ . -，1-64 字符）');
    if (this.cache.size >= MAX_SKILLS && !this.cache.has(cleanName)) {
      throw new Error(`已达 skill 数量上限 ${MAX_SKILLS}`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error('description 必填（短句让 LLM 决策何时调用此 skill）');
    }
    if (description.length > MAX_DESC) throw new Error(`description 过长（>${MAX_DESC}）`);
    if (typeof body !== 'string') body = '';
    if (body.length > MAX_BODY) throw new Error(`body 过长（>${MAX_BODY}）`);

    const skillDir = join(SKILLS_DIR, cleanName);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    const fm = {
      name: displayName || cleanName,
      description,
      ...(enabled === false ? { enabled: 'false' } : {}),
      ...((extra && typeof extra === 'object') ? Object.fromEntries(
        Object.entries(extra)
          .filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_-]{0,30}$/.test(k))
          .filter(([k]) => !['name', 'description', 'enabled'].includes(k))
          .slice(0, 10)
      ) : {}),
    };
    const md = stringifySkillMd(fm, body);
    const filePath = join(skillDir, 'SKILL.md');
    writeFileSync(filePath, md, { encoding: 'utf-8', mode: 0o600 });
    this.reload();
    return this.get(cleanName);
  }

  delete(name) {
    const cleanName = safeName(name);
    if (!cleanName) return false;
    const dir = join(SKILLS_DIR, cleanName);
    if (!existsSync(dir)) return false;
    // 防御性：dir 必须在 SKILLS_DIR 内
    if (!dir.startsWith(SKILLS_DIR + '/')) return false;
    rmSync(dir, { recursive: true, force: true });
    this.cache.delete(cleanName);
    return true;
  }

  /** 把多个 enabled skill 拼成一段 system prompt 注入 */
  buildSystemPromptForSkills(skillNames = []) {
    if (!Array.isArray(skillNames) || skillNames.length === 0) return '';
    const parts = [];
    for (const n of skillNames) {
      const s = this.cache.get(n);
      if (!s || s.enabled === false) continue;
      parts.push(`## Skill：${s.displayName}\n\n_${s.description}_\n\n${s.body}`);
    }
    if (parts.length === 0) return '';
    return `# 已挂载的 Skills（你被授权按需调用以下技能；每个 skill 含触发条件 + 操作指南）\n\n` + parts.join('\n\n---\n\n');
  }
}

export const skillStore = new SkillStore();
