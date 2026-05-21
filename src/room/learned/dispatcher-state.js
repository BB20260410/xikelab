// dispatcher-state — debate/squad 等 dispatcher 的显式 state machine 描述
// 学自 W6 LangGraph StateGraph + edge condition
// 独立模块，未接入实际 dispatcher——作为未来重构（B-008）的设计参考

/**
 * debate 模式 state machine
 * 当前 DebateDispatcher 是隐式 round 循环 + judge，此 schema 形式化它
 */
export const DEBATE_STATE_MACHINE = {
  initial: 'r1_propose',
  states: {
    r1_propose: {
      desc: '独立提案：每个成员各自给方案（互不可见）',
      transitions: [
        { to: 'r2_critique', condition: 'all_members_proposed' },
        { to: 'error', condition: 'timeout || any_member_failed' },
      ],
    },
    r2_critique: {
      desc: '互评修订：看完别人方案 → 评价 + 修订',
      transitions: [
        { to: 'r3_finalize', condition: 'all_critiques_done && rounds_left > 0' },
        { to: 'judge', condition: 'all_critiques_done && rounds_left === 0' },
      ],
    },
    r3_finalize: {
      desc: '终稿表态：列共识点 + 分歧',
      transitions: [
        { to: 'judge', condition: 'all_finalized' },
        { to: 'r2_critique', condition: 'rounds_left > 0 && score < threshold' },
        // W5 学到：consensus-detector 命中 → 直接跳 judge
        { to: 'judge', condition: 'consensus_detected' },
      ],
    },
    judge: {
      desc: '主持人合成最优共识',
      transitions: [
        { to: 'done', condition: 'judge_output_ready' },
        { to: 'error', condition: 'judge_failed' },
      ],
    },
    done: { terminal: true },
    error: { terminal: true, recovery: 'retry || manual_intervention' },
  },
};

/**
 * squad 模式 state machine
 */
export const SQUAD_STATE_MACHINE = {
  initial: 'pm_decompose',
  states: {
    pm_decompose: {
      desc: 'PM 拆 topic 为 task graph',
      transitions: [
        { to: 'dev_running', condition: 'tasks_created' },
        { to: 'error', condition: 'pm_failed' },
      ],
    },
    dev_running: {
      desc: 'Dev 并行实现 task（按依赖）',
      transitions: [
        { to: 'qa_review', condition: 'all_devs_done' },
        { to: 'error', condition: 'critical_task_failed' },
      ],
    },
    qa_review: {
      desc: 'QA 审查产物',
      transitions: [
        { to: 'done', condition: 'all_passed' },
        { to: 'dev_running', condition: 'some_failed && attempt_left' },
        { to: 'escalated', condition: 'attempt_exhausted' },
      ],
    },
    done: { terminal: true },
    escalated: { terminal: true, recovery: 'manual_intervention' },
    error: { terminal: true, recovery: 'retry' },
  },
};

/**
 * 用法（未来接入示例）：
 *   class DispatcherStateMachine {
 *     constructor(schema, ctx) { this.schema = schema; this.ctx = ctx; this.state = schema.initial; }
 *     async transition(event) {
 *       const transitions = this.schema.states[this.state].transitions || [];
 *       const next = transitions.find(t => evaluateCondition(t.condition, this.ctx, event));
 *       if (next) { this.state = next.to; await this.onEnter(this.state); }
 *     }
 *   }
 */
