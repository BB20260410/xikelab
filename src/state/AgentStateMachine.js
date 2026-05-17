// AgentStateMachine — 从 stream-json 推断 claude 当前状态
// 状态枚举：idle | thinking | running | completed | error
// 移植自 思维镜 State/AgentStateMachine.swift（精简，不含 OCR 哨兵）

export const STATES = ['idle', 'thinking', 'running', 'completed', 'error'];

export class AgentStateMachine {
  constructor() {
    this.state = 'idle';
    this.history = [];
  }

  // 输入 stream-json 一行解析后的 obj，返回新状态（或 null 表示无变化）
  ingest(obj) {
    let next = null;
    let reason = '';

    if (obj.type === 'system' && obj.subtype === 'init') {
      next = 'thinking';
      reason = 'system init';
    } else if (obj.type === 'assistant' && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        const hasToolUse = content.some(c => c?.type === 'tool_use');
        next = hasToolUse ? 'running' : 'thinking';
        reason = hasToolUse ? 'tool_use emitted' : 'assistant text only';
      }
    } else if (obj.type === 'result') {
      if (obj.is_error) {
        next = 'error';
        reason = 'result error: ' + (obj.error || obj.subtype || 'unknown');
      } else {
        next = 'completed';
        reason = 'result success';
      }
    }

    if (next && next !== this.state) {
      this.history.push({ from: this.state, to: next, reason, at: Date.now() });
      if (this.history.length > 100) this.history = this.history.slice(-100);
      const prev = this.state;
      this.state = next;
      return { from: prev, to: next, reason };
    }
    return null;
  }

  reset() {
    if (this.state !== 'idle') {
      this.history.push({ from: this.state, to: 'idle', reason: 'manual reset', at: Date.now() });
      this.state = 'idle';
    }
  }

  get current() { return this.state; }
  get transitions() { return [...this.history]; }
}
