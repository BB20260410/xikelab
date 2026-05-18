// WatcherAdapter — 监视者抽象基类
// 子类（MiniMaxAdapter / GeminiAdapter / OllamaAdapter / OpenAIAdapter）实现 judge()
// 任务：读 Claude session 的 messages + 主目标 + cwd，输出结构化 JSON 判断

/**
 * @typedef {Object} SessionState
 * @property {string} id
 * @property {string} name
 * @property {string} cwd
 * @property {string|null} mainGoal
 * @property {Array<{role:string,content:string,ts:string}>} messages 最近 N 条
 * @property {string} runState idle|thinking|running|completed|error
 */

/**
 * @typedef {Object} WatcherVerdict
 * @property {'completed'|'partial'|'stuck'|'need_user'|'failed'|'drifted'} status
 * @property {number} confidence 0.0 - 1.0
 * @property {string[]} completed_items
 * @property {string[]} remaining_items
 * @property {Object} next_action
 * @property {'continue'|'retry_with_hint'|'review'|'stop'|'escalate_to_user'} next_action.type
 * @property {string} next_action.prompt
 * @property {'safe'|'needs_review'} next_action.danger_level
 * @property {boolean} drift_detected
 * @property {string} reasoning
 */

export class WatcherAdapter {
  constructor({ apiKey, model, baseUrl, timeout = 30000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  get name() { return 'abstract'; }

  /**
   * 子类实现：调监督模型 API，返回 WatcherVerdict
   * @param {SessionState} sessionState
   * @returns {Promise<WatcherVerdict>}
   */
  async judge(sessionState) {
    throw new Error('WatcherAdapter.judge() must be implemented by subclass');
  }

  /** 通用 judge prompt 生成（子类可覆盖） */
  buildJudgePrompt(sessionState) {
    const msgs = (sessionState.messages || []).slice(-30).map(m => {
      const head = m.role === 'user' ? '👤 用户' :
                   m.role === 'assistant' ? '🤖 Claude' :
                   m.role === 'tool_use' ? '🔧 工具' :
                   m.role === 'system' ? '⚙️ 系统' : m.role;
      const body = (m.content || '').slice(0, 800);
      return `${head}: ${body}`;
    }).join('\n\n');

    return `你是 Claude session 的监督者。你看到 Claude 跑了一段对话，需要判断任务状态 + 给出下一步建议。

## 项目上下文
- session 名: ${sessionState.name || '未命名'}
- cwd: ${sessionState.cwd || '未知'}
- 主目标: ${sessionState.mainGoal || '（用户未设主目标）'}
- 当前状态: ${sessionState.runState || 'idle'}

## 最近对话（最多 30 条，每条截 800 字）

${msgs}

## 你的任务
根据上面对话判断 task 状态，输出 **严格的 JSON**（不要 markdown 代码块，直接 JSON）：

{
  "status": "completed | partial | stuck | need_user | failed | drifted",
  "confidence": 0.85,
  "completed_items": ["claude 做了 X", "claude 做了 Y"],
  "remaining_items": ["还没做 Z"],
  "next_action": {
    "type": "continue | retry_with_hint | review | stop | escalate_to_user",
    "prompt": "（要发给 Claude 继续干的具体指令，留空表示不需要继续）",
    "danger_level": "safe | needs_review"
  },
  "drift_detected": false,
  "reasoning": "（你的判断理由，2-3 句话）"
}

## 判断准则
- status=completed: 主目标完成 + 没未决工具调用 + Claude 自己说"完成了"
- status=partial: 还有明显未做的事
- status=stuck: Claude 在重复尝试同一件事失败
- status=need_user: Claude 主动停下问问题等用户介入
- status=failed: 报错且无法自动恢复
- status=drifted: Claude 偏离主目标做无关的事
- next_action.prompt 必须**具体可执行**（"请继续完成 X 模块的 Y 功能"，不要"请继续"）
- next_action.danger_level=needs_review 当 prompt 含可能危险的命令（rm/git push --force 等）

只输出 JSON。`;
  }

  /** 通用 JSON 解析 + schema 校验 */
  validateVerdict(raw) {
    let obj;
    try {
      // 容错：剥 markdown code fence
      const cleaned = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      obj = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('watcher 输出不是合法 JSON: ' + e.message + ' | raw: ' + raw.slice(0, 200));
    }
    const validStatus = ['completed', 'partial', 'stuck', 'need_user', 'failed', 'drifted'];
    if (!validStatus.includes(obj.status)) {
      throw new Error('invalid status: ' + obj.status);
    }
    if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
      obj.confidence = 0.5;
    }
    obj.completed_items = Array.isArray(obj.completed_items) ? obj.completed_items : [];
    obj.remaining_items = Array.isArray(obj.remaining_items) ? obj.remaining_items : [];
    obj.next_action = obj.next_action || {};
    const validActionType = ['continue', 'retry_with_hint', 'review', 'stop', 'escalate_to_user'];
    if (!validActionType.includes(obj.next_action.type)) obj.next_action.type = 'review';
    obj.next_action.prompt = typeof obj.next_action.prompt === 'string' ? obj.next_action.prompt : '';
    if (!['safe', 'needs_review'].includes(obj.next_action.danger_level)) {
      obj.next_action.danger_level = 'needs_review';
    }
    obj.drift_detected = !!obj.drift_detected;
    obj.reasoning = String(obj.reasoning || '');
    return obj;
  }
}
