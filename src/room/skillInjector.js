// v0.55 Sprint 14 F2 — Skill 注入工具
// dispatcher 在调 adapter.chat() 前用这个把 room.skills 拼到 system message

import { skillStore } from '../skills/SkillStore.js';

/**
 * 把 room.skills 解析成 system prompt 段，合并到 messages 的 system 消息里
 * （若没 system 消息则新建一条）
 *
 * @param {Array} messages OpenAI 风格 [{role, content}]
 * @param {object} room ChatRoomStore 的 room 对象
 * @returns {Array} 新 messages（不变更原数组）
 */
export function injectSkillsToMessages(messages, room) {
  let out = messages;
  const projectPrompt = room?.projectContext?.prompt;
  if (projectPrompt && typeof projectPrompt === 'string') {
    out = appendSystemContext(out, projectPrompt);
  }
  const skillNames = room?.skills;
  if (!Array.isArray(skillNames) || skillNames.length === 0) return out;
  try {
    const ctx = skillStore.buildSystemPromptForSkills(skillNames);
    if (!ctx) return out;
    return appendSystemContext(out, ctx);
  } catch (e) {
    console.warn('[skillInjector] failed:', e.message);
    return out;
  }
}

function appendSystemContext(messages, ctx) {
  if (!ctx) return messages;
  const out = messages.slice();
  const sysIdx = out.findIndex((m) => m && m.role === 'system');
  if (sysIdx >= 0) {
    out[sysIdx] = { ...out[sysIdx], content: (out[sysIdx].content || '') + '\n\n' + ctx };
  } else {
    out.unshift({ role: 'system', content: ctx });
  }
  return out;
}

/** 给 chat / debate / arena / squad 复用：拿 room 的 enabled skill names（filter 掉无效的） */
export function getActiveSkillNames(room) {
  const names = room?.skills;
  if (!Array.isArray(names)) return [];
  return names
    .filter((n) => typeof n === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(n))
    .filter((n) => {
      const s = skillStore.get(n);
      return s && s.enabled !== false;
    });
}
