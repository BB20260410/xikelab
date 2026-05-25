// v0.55 Sprint 14 F2 — Skill 注入工具
// dispatcher 在调 adapter.chat() 前用这个把 room.skills 拼到 system message

import { skillStore } from '../skills/SkillStore.js';
import { buildAgentRuntimeContext } from '../agents/AgentSkillRegistry.js';
import { effectiveAgentRegistry } from '../agents/AgentPolicyStore.js';

export function buildRoomAgentContext(room, options = {}) {
  if (!options?.member) return null;
  return buildAgentRuntimeContext({
    room,
    member: options.member,
    objective: options.objective,
    codeContext: options.codeContext,
    skillStore,
    registry: effectiveAgentRegistry(),
  });
}

/**
 * 把 room.skills 解析成 system prompt 段，合并到 messages 的 system 消息里
 * （若没 system 消息则新建一条）
 *
 * @param {Array} messages OpenAI 风格 [{role, content}]
 * @param {object} room ChatRoomStore 的 room 对象
 * @returns {Array} 新 messages（不变更原数组）
 */
export function injectSkillsToMessages(messages, room, options = {}) {
  let out = messages;
  const projectPrompt = room?.projectContext?.prompt;
  if (projectPrompt && typeof projectPrompt === 'string') {
    out = appendSystemContext(out, projectPrompt);
  }
  const agentContext = options?.agentContext || buildRoomAgentContext(room, options);
  if (agentContext?.prompt) {
    out = appendSystemContext(out, agentContext.prompt);
  }
  const skillNames = getActiveSkillNames(room, options, agentContext);
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

/** 给 chat / debate / arena / squad 复用：拿 room + agent 的 enabled skill names（filter 掉无效的） */
export function getActiveSkillNames(room, options = {}, precomputedAgentContext = null) {
  const roomNames = Array.isArray(room?.skills) ? room.skills : [];
  const agentContext = precomputedAgentContext || options?.agentContext || buildRoomAgentContext(room, options);
  const names = [
    ...roomNames,
    ...(Array.isArray(agentContext?.skillNames) ? agentContext.skillNames : []),
  ];
  const seen = new Set();
  return names
    .filter((n) => typeof n === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(n))
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .filter((n) => {
      const s = skillStore.get(n);
      return s && s.enabled !== false;
    });
}
